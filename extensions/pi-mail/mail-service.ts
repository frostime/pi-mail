import { randomUUID } from "node:crypto";

import {
  parseReminderPolicy,
  reminderStatus,
  type EffectiveReminderPolicy,
  type ReminderPolicy,
  type ReminderStatus,
} from "./attention-policy.ts";
import { FsMailStore } from "./fs-store.ts";
import { FsPresenceStore } from "./presence-store.ts";
import {
  generateMessageId,
  isLegacyUuidMessageId,
  legacyMessageRef,
  matchesIdFragment,
  LEGACY_MESSAGE_REF_MIN_LENGTH,
  SESSION_ID_FRAGMENT_MIN_LENGTH,
  shortSessionId,
} from "./identity.ts";
import type { PeerRecordV2, StoredReminderOverride } from "./peer-record.ts";
import { resolveMailRoot, resolvePresenceRoot } from "./project-root.ts";
import { errorCode } from "./store-util.ts";
import type {
  DeliveryRecord,
  DiscoveredPeer,
  MailMessage,
  MailboxOverview,
  MailStatus,
  MessageRecord,
  PeerAddress,
  PresenceRecord,
  ProjectMessageSummary,
  RecipientKind,
  SentMessageSummary,
  SentRecipient,
  SenderKind,
  WaitResult,
} from "./types.ts";

const DEFAULT_PRESENCE_TTL_MS = 20_000;
const DEFAULT_LIMIT = 20;
const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const MAX_WAIT_TIMEOUT_MS = 300_000;
const WAIT_POLL_INTERVAL_MS = 250;
const WAIT_RESULT_LIMIT = 20;
const MAX_MESSAGE_ID_ATTEMPTS = 10;
const GENERATED_ALIAS_COUNT = 1_000;
export const HUMAN_PRINCIPAL_ID = "human-local";
export const HUMAN_PRINCIPAL_ALIAS = "user";

const UNAVAILABLE_STORAGE_CODES = new Set([
  "EACCES",
  "EDQUOT",
  "EEXIST",
  "EISDIR",
  "ENAMETOOLONG",
  "ENOSPC",
  "ENOTDIR",
  "EPERM",
  "EROFS",
]);

export class MailStorageUnavailableError extends Error {
  constructor(mailRoot: string, options: { cause: unknown }) {
    const code = typeof options.cause === "object" && options.cause !== null && "code" in options.cause
      ? String((options.cause as { code?: unknown }).code)
      : undefined;
    super(`Pi Mail disabled: cannot write to "${mailRoot}"${code ? ` (${code})` : ""}.`, options);
    this.name = "MailStorageUnavailableError";
  }
}

/** Interval between opportunistic sweeps of stale presence files. */
const PRESENCE_SWEEP_INTERVAL_MS = 60_000;
/** Minimum age of a presence file before an opportunistic sweep may delete it. */
const PRESENCE_STALE_MS = 300_000;

export interface MailServiceOptions {
  cwd: string;
  sessionId: string;
  runtimeId?: string;
  presenceTtlMs?: number;
  defaultReminder?: EffectiveReminderPolicy;
  /** Overrides the ephemeral presence location; tests use this for isolation. */
  presenceRoot?: { root: string; projectRoot: string };
}

export interface SendMailInput {
  to?: string[];
  cc?: string[];
  subject?: string;
  body?: string;
  notify?: boolean;
  replyTo?: string;
  replyAll?: boolean;
}

export interface MessageGcResult {
  deletedCount: number;
}

export interface DeleteProjectMailboxesResult {
  mailboxes: PeerAddress[];
  gc: MessageGcResult;
}

function nowIso(): string {
  return new Date().toISOString();
}

// --- 别名生成 ---------------------------------------------------------------
// Generated mailbox aliases: deterministic per session, collision-free against
// existing peers, with legacy "session-*" forms kept for rename detection.

function defaultAliasNumber(sessionId: string): number {
  const compact = sessionId.replaceAll("-", "");
  return Number.parseInt(compact.slice(-6), 16) % GENERATED_ALIAS_COUNT;
}

function defaultAlias(sessionId: string, peers: PeerRecordV2[]): string {
  const used = new Set(peers.map((peer) => peer.alias.toLowerCase()));
  const start = defaultAliasNumber(sessionId);

  for (let offset = 0; offset < GENERATED_ALIAS_COUNT; offset += 1) {
    const number = (start + offset) % GENERATED_ALIAS_COUNT;
    const alias = `S${String(number).padStart(3, "0")}`;
    if (!used.has(alias.toLowerCase())) return alias;
  }

  throw new Error("No available generated mailbox alias");
}

function legacyDefaultAlias(sessionId: string): string {
  return `session-${sessionId.slice(0, 8)}`;
}

function tailDefaultAlias(sessionId: string): string {
  return `session-${shortSessionId(sessionId)}`;
}

function isLegacyGeneratedAlias(alias: string | undefined, sessionId: string): boolean {
  return alias === legacyDefaultAlias(sessionId) || alias === tailDefaultAlias(sessionId);
}

// --- 规范化与判定 -----------------------------------------------------------
// Input cleanup at the service boundary and small domain predicates.

function normalizeSessionName(name: string | null | undefined): string | undefined {
  if (name == null) return undefined;
  const value = String(name).trim();
  if (!value) return undefined;
  return value.length > 200 ? value.slice(0, 200) : value;
}

function normalizeAlias(alias: string | undefined): string | undefined {
  if (alias == null) return undefined;
  const value = String(alias).trim();
  if (!value || value.length > 64 || /[\x00-\x1f/\\]/.test(value)) {
    throw new Error("Alias must be 1-64 characters and cannot contain slashes or control characters");
  }
  return value;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function makePeerDurable(peer: PeerRecordV2): PeerRecordV2 {
  if (peer.provisional !== true) return peer;
  const next = { ...peer, updatedAt: nowIso() };
  delete next.provisional;
  return next;
}

function senderKindOf(message: MessageRecord): SenderKind {
  return message.senderKind === "human" ? "human" : "session";
}

// --- 边界钳制与排序 ---------------------------------------------------------
// Query bounds and deterministic ordering shared by the read paths.

function boundedLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, 100));
}

function sortByCreatedDesc(a: { createdAt: string }, b: { createdAt: string }): number {
  return b.createdAt.localeCompare(a.createdAt);
}

function sortByCreatedAsc(a: { createdAt: string }, b: { createdAt: string }): number {
  return a.createdAt.localeCompare(b.createdAt);
}

function boundedWaitTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_WAIT_TIMEOUT_MS;
  return Math.max(0, Math.min(Number(timeoutMs) || 0, MAX_WAIT_TIMEOUT_MS));
}

function abortError(): Error {
  const error = new Error("mail wait aborted");
  error.name = "AbortError";
  return error;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);

    function done(): void {
      cleanup();
      resolve();
    }

    function aborted(): void {
      cleanup();
      reject(abortError());
    }

    function cleanup(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
    }

    signal?.addEventListener("abort", aborted, { once: true });
  });
}

export class MailService {
  readonly cwd: string;
  readonly sessionId: string;
  readonly runtimeId: string;
  readonly presenceTtlMs: number;
  readonly root: string;
  readonly store: FsMailStore;
  readonly presenceStore: FsPresenceStore;
  readonly defaultReminder: EffectiveReminderPolicy;
  private peerMutationQueue: Promise<void> = Promise.resolve();
  /** Pi session display name seen most recently; advertised through presence. */
  private currentSessionName: string | undefined;
  private lastSweepAt = 0;

  constructor({
    cwd,
    sessionId,
    runtimeId = randomUUID(),
    presenceTtlMs = DEFAULT_PRESENCE_TTL_MS,
    defaultReminder = { policy: { kind: "off" }, source: "built-in" },
    presenceRoot,
  }: MailServiceOptions) {
    if (!sessionId) throw new Error("sessionId is required");

    this.cwd = cwd;
    this.sessionId = sessionId;
    this.runtimeId = runtimeId;
    this.presenceTtlMs = presenceTtlMs;
    this.defaultReminder = defaultReminder;
    this.root = resolveMailRoot(cwd);
    this.store = new FsMailStore(this.root);
    const presence = presenceRoot ?? resolvePresenceRoot(cwd);
    this.presenceStore = new FsPresenceStore(presence.root, presence.projectRoot);
  }

  async init(options: { alias?: string; discoverable?: boolean; sessionName?: string | null } = {}): Promise<PeerRecordV2> {
    if (options.sessionName !== undefined) {
      this.currentSessionName = normalizeSessionName(options.sessionName);
    }
    await this.store.init();

    const timestamp = nowIso();
    const existing = await this.store.getPeer(this.sessionId);
    const sessionName = options.sessionName === undefined
      ? existing?.sessionName
      : normalizeSessionName(options.sessionName);
    const requestedAlias = normalizeAlias(options.alias);
    const existingAlias = existing?.alias && !isLegacyGeneratedAlias(existing.alias, this.sessionId)
      ? existing.alias
      : undefined;
    const peers = existingAlias ? [] : await this.store.listPeers();
    const explicitlyConfigured = requestedAlias !== undefined || options.discoverable !== undefined;
    const provisional = existing
      ? existing.provisional === true && !explicitlyConfigured
      : !explicitlyConfigured;
    const peer: PeerRecordV2 = {
      version: 2,
      id: this.sessionId,
      alias: existingAlias ?? requestedAlias ?? defaultAlias(this.sessionId, peers),
      ...(sessionName ? { sessionName } : {}),
      cwd: this.cwd,
      discoverable: existing?.discoverable ?? options.discoverable ?? true,
      ...(existing && Object.hasOwn(existing, "reminder") ? { reminder: existing.reminder } : {}),
      ...(provisional ? { provisional: true as const } : {}),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };

    await this.store.putPeer(peer);
    await this.heartbeat();
    return peer;
  }

  /**
   * Create the durable store and this session's peer record if missing.
   *
   * Sessions register lazily: starting a session only writes presence to the
   * temp area, and this is the first durable write path. The delay keeps the
   * project directory clean until real mail value exists, while presence
   * keeps the session discoverable and addressable in the meantime.
   */
  private async ensureRegistered(): Promise<void> {
    if (await this.store.getPeer(this.sessionId)) return;
    try {
      await this.init({ sessionName: this.currentSessionName });
    } catch (error) {
      if (error instanceof MailStorageUnavailableError) throw error;
      if (UNAVAILABLE_STORAGE_CODES.has(errorCode(error) ?? "")) {
        throw new MailStorageUnavailableError(this.root, { cause: error });
      }
      throw error;
    }
  }

  /** Create the durable store directories if the session is about to write mail data. */
  private async ensureStore(): Promise<void> {
    try {
      await this.store.init();
    } catch (error) {
      if (UNAVAILABLE_STORAGE_CODES.has(errorCode(error) ?? "")) {
        throw new MailStorageUnavailableError(this.root, { cause: error });
      }
      throw error;
    }
  }

  async heartbeat(): Promise<void> {
    const timestamp = nowIso();
    const peer = await this.store.getPeer(this.sessionId);
    if (peer?.sessionName) this.currentSessionName = peer.sessionName;
    const current = await this.currentPresence();
    const presence: PresenceRecord = {
      version: 1,
      sessionId: this.sessionId,
      runtimeId: this.runtimeId,
      pid: process.pid,
      cwd: this.cwd,
      // Sessions without a durable peer record must remain discoverable and
      // addressable, so the heartbeat itself advertises the mailbox identity.
      alias: peer?.alias ?? defaultAlias(this.sessionId, await this.store.listPeers()),
      ...(this.currentSessionName ? { sessionName: this.currentSessionName } : {}),
      startedAt: current?.startedAt ?? timestamp,
      lastSeenAt: timestamp,
    };
    await this.presenceStore.putPresence(presence);
    await this.sweepPresenceOccasionally();
  }

  private async sweepPresenceOccasionally(): Promise<void> {
    const nowMs = Date.now();
    if (nowMs - this.lastSweepAt < PRESENCE_SWEEP_INTERVAL_MS) return;
    this.lastSweepAt = nowMs;
    await this.presenceStore.sweepStale(Math.max(this.presenceTtlMs * 15, PRESENCE_STALE_MS));
  }

  async syncSessionName(sessionName: string | null | undefined): Promise<void> {
    const nextName = normalizeSessionName(sessionName);
    this.currentSessionName = nextName;
    const peer = await this.store.getPeer(this.sessionId);
    if (peer && (peer.sessionName ?? undefined) !== nextName) {
      await this.updateCurrentPeer((current) => {
        const next = { ...current, updatedAt: nowIso() };
        if (nextName) next.sessionName = nextName;
        else delete next.sessionName;
        return next;
      });
    }
    // Mirror the name into presence so discovery stays current even when the
    // peer record does not exist yet.
    await this.heartbeat();
  }

  async close(options: { discardUnusedMailbox?: boolean } = {}): Promise<void> {
    await this.presenceStore.removePresence(this.sessionId, this.runtimeId);
    if (options.discardUnusedMailbox) {
      await this.discardUnusedMailbox();
      await this.store.removeIfEmpty();
    }
  }

  async configure(options: { alias?: string; discoverable?: boolean } = {}): Promise<PeerRecordV2> {
    if (options.alias === undefined && options.discoverable === undefined) {
      throw new Error("configure requires alias and/or discoverable");
    }
    const alias = options.alias === undefined ? undefined : normalizeAlias(options.alias)!;
    await this.ensureRegistered();
    return this.updateCurrentPeer((peer) => {
      const nextAlias = alias ?? peer.alias;
      const nextDiscoverable = options.discoverable ?? peer.discoverable;
      const configured = nextAlias === peer.alias && nextDiscoverable === peer.discoverable
        ? peer
        : {
            ...peer,
            alias: nextAlias,
            discoverable: nextDiscoverable,
            updatedAt: nowIso(),
          };
      return makePeerDurable(configured);
    });
  }

  async configureReminder(policy: ReminderPolicy | undefined): Promise<PeerRecordV2> {
    const stored = policy === undefined
      ? undefined
      : policy.kind === "after-minutes" ? policy.minutes : policy.kind;
    if (stored !== undefined) parseReminderPolicy(stored);

    await this.ensureRegistered();
    return this.updateCurrentPeer((peer) => {
      const current = Object.hasOwn(peer, "reminder") ? peer.reminder : undefined;
      if (current === stored) return makePeerDurable(peer);
      const next: PeerRecordV2 = { ...peer, updatedAt: nowIso() };
      if (stored === undefined) delete next.reminder;
      else next.reminder = stored;
      return makePeerDurable(next);
    });
  }

  async getReminderOverride(): Promise<ReminderPolicy | undefined> {
    const peer = await this.store.getPeer(this.sessionId);
    return peer && Object.hasOwn(peer, "reminder")
      ? parseReminderPolicy(peer.reminder)
      : undefined;
  }

  async getEffectiveReminder(): Promise<EffectiveReminderPolicy> {
    return this.effectiveReminderForPeer(await this.store.getPeer(this.sessionId));
  }

  async discover(options: { includeInactive?: boolean } = {}): Promise<DiscoveredPeer[]> {
    return this.listSessions({
      includeInactive: options.includeInactive ?? false,
      includeSelf: false,
      includeUndiscoverable: false,
    });
  }

  async listProjectSessions(options: { includeInactive?: boolean } = {}): Promise<DiscoveredPeer[]> {
    return this.listSessions({
      includeInactive: options.includeInactive ?? true,
      includeSelf: true,
      includeUndiscoverable: true,
    });
  }

  async listProjectMailboxes(options: { includeInactive?: boolean } = {}): Promise<MailboxOverview[]> {
    const sessions = await this.listProjectSessions(options);
    const peers = await this.peerMap();
    const sentAtBySession = new Map<string, string>();
    for (const message of await this.store.listMessages()) {
      if (senderKindOf(message) !== "session") continue;
      const previous = sentAtBySession.get(message.from);
      if (previous === undefined || message.createdAt > previous) {
        sentAtBySession.set(message.from, message.createdAt);
      }
    }
    const output: MailboxOverview[] = [];

    for (const session of sessions) {
      const deliveries = await this.store.listDeliveries(session.id);
      const pending = deliveries.filter((delivery) => !delivery.presentedAt);
      const pendingTo = pending.filter((delivery) => delivery.kind === "to");
      const oldestToAt = pendingTo
        .map((delivery) => delivery.deliveredAt)
        .filter(Boolean)
        .sort()[0] ?? null;
      const deliveredAt = deliveries
        .map((delivery) => delivery.deliveredAt)
        .filter(Boolean)
        .sort()
        .at(-1) ?? null;

      output.push({
        ...session,
        pending: {
          to: pendingTo.length,
          cc: pending.filter((delivery) => delivery.kind === "cc").length,
          oldestToAt,
        },
        lastMailAt: [deliveredAt, sentAtBySession.get(session.id) ?? null]
          .filter(Boolean)
          .sort()
          .at(-1) ?? null,
        reminder: this.observedReminderForPeer(session.self === true, peers.get(session.id) ?? null),
      });
    }

    return output.sort((a, b) => {
      const aPending = a.pending.to + a.pending.cc;
      const bPending = b.pending.to + b.pending.cc;
      if ((a.pending.to > 0) !== (b.pending.to > 0)) return a.pending.to > 0 ? -1 : 1;
      if ((aPending > 0) !== (bPending > 0)) return aPending > 0 ? -1 : 1;
      if (a.active !== b.active) return a.active ? -1 : 1;
      if (a.self !== b.self) return a.self ? -1 : 1;
      return a.alias.localeCompare(b.alias);
    });
  }

  private async listSessions(options: {
    includeInactive: boolean;
    includeSelf: boolean;
    includeUndiscoverable: boolean;
  }): Promise<DiscoveredPeer[]> {
    const peers = await this.store.listPeers();
    const livePresence = await this.activePresence();
    const presenceBySession = new Map<string, typeof livePresence>();

    for (const presence of livePresence) {
      const list = presenceBySession.get(presence.sessionId) ?? [];
      list.push(presence);
      presenceBySession.set(presence.sessionId, list);
    }

    const visible = (id: string): boolean =>
      (options.includeSelf || id !== this.sessionId);

    const peerEntries = peers
      .filter((peer) => !peer.deletedAt)
      .filter((peer) => visible(peer.id))
      .filter((peer) => options.includeUndiscoverable || peer.discoverable !== false)
      .filter((peer) => options.includeInactive || presenceBySession.has(peer.id))
      .map((peer) => {
        const presences = presenceBySession.get(peer.id) ?? [];
        const latest = presences
          .slice()
          .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))[0];

        return {
          id: peer.id,
          shortId: shortSessionId(peer.id),
          alias: peer.alias,
          sessionName: peer.sessionName ?? null,
          active: presences.length > 0,
          runtimeCount: presences.length,
          cwd: latest?.cwd ?? peer.cwd,
          lastSeenAt: latest?.lastSeenAt ?? null,
          self: peer.id === this.sessionId,
        };
      });

    // Sessions without a durable peer record advertise identity through their
    // heartbeat; they are always active by definition.
    const presenceOnlyEntries = [...presenceBySession]
      .filter(([id]) => !peers.some((peer) => peer.id === id && !peer.deletedAt))
      .filter(([id]) => visible(id))
      .map(([id, presences]) => {
        const latest = presences
          .slice()
          .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))[0];

        return {
          id,
          shortId: shortSessionId(id),
          alias: latest?.alias ?? shortSessionId(id),
          sessionName: latest?.sessionName ?? null,
          active: true,
          runtimeCount: presences.length,
          cwd: latest?.cwd ?? this.cwd,
          lastSeenAt: latest?.lastSeenAt ?? null,
          self: id === this.sessionId,
        };
      });

    return [...peerEntries, ...presenceOnlyEntries].sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      if (a.self !== b.self) return a.self ? -1 : 1;
      return a.alias.localeCompare(b.alias);
    });
  }

  async send(input: SendMailInput = {}): Promise<MailMessage> {
    return this.sendFrom({
      senderKind: "session",
      senderId: this.sessionId,
      senderAlias: defaultAlias(this.sessionId, []),
      ...input,
    });
  }

  async sendAsHuman(input: Omit<SendMailInput, "replyTo" | "replyAll">): Promise<MailMessage> {
    return this.sendFrom({
      senderKind: "human",
      senderId: HUMAN_PRINCIPAL_ID,
      senderAlias: HUMAN_PRINCIPAL_ALIAS,
      ...input,
      notify: true,
    });
  }

  async recipientStatusesFor(messageId: string): Promise<SentRecipient[]> {
    const message = await this.store.getMessage(messageId);
    if (!message) throw new Error(`Unknown message "${messageId}"`);
    return this.recipientStatuses(message);
  }

  async deleteProjectMailbox(address: string): Promise<PeerAddress> {
    const peerId = await this.resolveOne(address);
    const result = await this.deleteProjectMailboxes([peerId]);
    return result.mailboxes[0];
  }

  async deleteProjectMailboxes(sessionIds: string[]): Promise<DeleteProjectMailboxesResult> {
    const ids = unique(sessionIds);
    if (ids.length === 0) throw new Error("At least one session mailbox is required");
    if (ids.includes(HUMAN_PRINCIPAL_ID)) {
      throw new Error("The human principal has no deletable session mailbox");
    }
    if (ids.includes(this.sessionId)) {
      throw new Error("Cannot delete the mailbox of the current active session");
    }

    const [active, peers] = await Promise.all([
      this.activeSessionIds(),
      this.store.listPeers(),
    ]);
    const peerById = new Map(peers.map((peer) => [peer.id, peer]));
    const targets: PeerRecordV2[] = [];

    for (const id of ids) {
      if (active.has(id)) throw new Error(`Cannot delete active session mailbox "${id}"`);
      const peer = peerById.get(id);
      if (!peer || peer.deletedAt) throw new Error(`Unknown session mailbox "${id}"`);
      targets.push(peer);
    }

    const deleted: PeerAddress[] = [];
    for (const peer of targets) {
      await this.store.removeMailbox(peer.id);
      await this.presenceStore.removeSessionPresence(peer.id);
      await this.store.removePeer(peer.id);
      deleted.push({ id: peer.id, shortId: shortSessionId(peer.id), alias: peer.alias });
    }

    try {
      return { mailboxes: deleted, gc: await this.collectUnreferencedMessages() };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Mailboxes deleted, but message cleanup failed: ${reason}`);
    }
  }

  async collectUnreferencedMessages(): Promise<MessageGcResult> {
    const [peers, messages] = await Promise.all([
      this.store.listPeers(),
      this.store.listMessages(),
    ]);
    const extantPeerIds = new Set(
      peers.filter((peer) => !peer.deletedAt).map((peer) => peer.id),
    );
    const referencedMessageIds = new Set<string>();

    for (const message of messages) {
      if (senderKindOf(message) === "session" && extantPeerIds.has(message.from)) {
        referencedMessageIds.add(message.id);
      }
    }

    for (const peerId of extantPeerIds) {
      for (const messageId of await this.store.listDeliveryIds(peerId)) {
        referencedMessageIds.add(messageId);
      }
    }

    let deletedCount = 0;
    for (const message of messages) {
      if (referencedMessageIds.has(message.id)) continue;
      await this.store.removeMessage(message.id);
      deletedCount += 1;
    }

    return { deletedCount };
  }

  async listUnpresentedForAttention(): Promise<MailMessage[]> {
    const deliveries = (await this.store.listDeliveries(this.sessionId))
      .filter((delivery) => !delivery.presentedAt);
    const messages: MailMessage[] = [];
    for (const delivery of deliveries) {
      const message = await this.store.getMessage(delivery.messageId);
      if (message) messages.push(await this.decorateMessage(message, delivery));
    }
    return messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listInbox(options: {
    messageId?: string;
    unpresentedOnly?: boolean;
    limit?: number;
    oldestFirst?: boolean;
    markPresented?: boolean;
  } = {}): Promise<MailMessage | MailMessage[]> {
    const {
      messageId,
      unpresentedOnly = false,
      oldestFirst = false,
      markPresented = true,
    } = options;

    if (messageId) {
      const resolvedMessageId = await this.resolveMessageId(messageId);
      const delivery = await this.store.getDelivery(this.sessionId, resolvedMessageId);
      if (!delivery) throw new Error(`Message "${messageId}" is not in your inbox`);

      const message = await this.store.getMessage(resolvedMessageId);
      if (!message) throw new Error(`Message "${resolvedMessageId}" is missing from storage`);

      let nextDelivery = delivery;
      if (markPresented && !delivery.presentedAt) {
        nextDelivery = await this.store.updateDelivery(this.sessionId, resolvedMessageId, {
          presentedAt: nowIso(),
        }) ?? delivery;
      }
      return this.decorateMessage(message, nextDelivery);
    }

    const deliveries = (await this.store.listDeliveries(this.sessionId))
      .filter((delivery) => !unpresentedOnly || !delivery.presentedAt);
    const entries: Array<{ message: MessageRecord; delivery: DeliveryRecord }> = [];
    for (const delivery of deliveries) {
      const message = await this.store.getMessage(delivery.messageId);
      if (message) entries.push({ message, delivery });
    }
    entries.sort((a, b) => oldestFirst
      ? sortByCreatedAsc(a.message, b.message)
      : sortByCreatedDesc(a.message, b.message));

    const output: MailMessage[] = [];
    for (const { message, delivery } of entries.slice(0, boundedLimit(options.limit))) {
      let visibleDelivery = delivery;
      if (markPresented && !delivery.presentedAt) {
        visibleDelivery = await this.store.updateDelivery(this.sessionId, delivery.messageId, {
          presentedAt: nowIso(),
        }) ?? delivery;
      }
      output.push(await this.decorateMessage(message, visibleDelivery));
    }
    return output;
  }

  async markPresented(messageId: string): Promise<DeliveryRecord | null> {
    const delivery = await this.store.getDelivery(this.sessionId, messageId);
    if (!delivery || delivery.presentedAt) return delivery;
    return this.store.updateDelivery(this.sessionId, messageId, { presentedAt: nowIso() });
  }

  async waitForInbox(options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<WaitResult> {
    const startedAt = Date.now();
    const timeoutMs = boundedWaitTimeout(options.timeoutMs);

    // Snapshot first, then inspect pending mail. This ordering closes the
    // lost-wakeup gap: a delivery that lands between the two reads either
    // appears as pending or is absent from the snapshot and is detected below.
    const baseline = new Set(await this.store.listDeliveryIds(this.sessionId));
    const pending = await this.listInbox({
      unpresentedOnly: true,
      limit: WAIT_RESULT_LIMIT,
      oldestFirst: true,
      markPresented: false,
    }) as MailMessage[];

    if (pending.length) {
      return { reason: "pending", waitedMs: Date.now() - startedAt, messages: pending };
    }

    while (true) {
      if (options.signal?.aborted) throw abortError();

      const newIds = (await this.store.listDeliveryIds(this.sessionId))
        .filter((messageId) => !baseline.has(messageId));

      if (newIds.length) {
        const messages: MailMessage[] = [];
        for (const messageId of newIds.slice(0, WAIT_RESULT_LIMIT)) {
          const delivery = await this.store.getDelivery(this.sessionId, messageId);
          const message = await this.store.getMessage(messageId);
          if (!delivery || !message) continue;
          messages.push(await this.decorateMessage(message, delivery));
        }
        messages.sort(sortByCreatedAsc);
        if (messages.length) {
          return { reason: "new", waitedMs: Date.now() - startedAt, messages };
        }
      }

      const elapsed = Date.now() - startedAt;
      if (elapsed >= timeoutMs) {
        return { reason: "timeout", waitedMs: elapsed, messages: [] };
      }

      await delay(Math.min(WAIT_POLL_INTERVAL_MS, timeoutMs - elapsed), options.signal);
    }
  }

  async listSent(options: { limit?: number } = {}): Promise<SentMessageSummary[]> {
    const messages = (await this.store.listMessages())
      .filter((message) => senderKindOf(message) === "session" && message.from === this.sessionId)
      .sort(sortByCreatedDesc)
      .slice(0, boundedLimit(options.limit));

    const output: SentMessageSummary[] = [];
    for (const message of messages) {
      output.push({
        id: message.id,
        subject: message.subject,
        threadId: message.threadId,
        createdAt: message.createdAt,
        recipients: await this.recipientStatuses(message),
      });
    }
    return output;
  }

  async thread(reference: string | undefined): Promise<MailMessage[]> {
    if (!reference) throw new Error("thread requires a message_id");

    const messageId = await this.resolveMessageId(reference);
    const referencedMessage = await this.store.getMessage(messageId);
    if (!referencedMessage) throw new Error(`Unknown message "${reference}"`);
    const threadId = referencedMessage.threadId;
    const messages = (await this.store.listMessages())
      .filter((message) => message.threadId === threadId)
      .sort(sortByCreatedAsc);

    const decorated = await Promise.all(messages.map((message) => this.decorateMessage(message)));
    if (decorated.length === 0) throw new Error(`No thread found for "${reference}"`);
    return decorated;
  }

  async listProjectMessages(options: { limit?: number } = {}): Promise<ProjectMessageSummary[]> {
    const messages = (await this.store.listMessages())
      .sort(sortByCreatedDesc)
      .slice(0, boundedLimit(options.limit ?? 100));

    const output: ProjectMessageSummary[] = [];
    for (const message of messages) {
      output.push({
        ...await this.decorateMessage(message),
        recipients: await this.recipientStatuses(message),
      });
    }
    return output;
  }

  async status(): Promise<MailStatus> {
    const peer = await this.store.getPeer(this.sessionId);
    const inbox = await this.listUnpresentedForAttention();

    return {
      id: this.sessionId,
      shortId: shortSessionId(this.sessionId),
      alias: peer?.alias ?? defaultAlias(this.sessionId, await this.store.listPeers()),
      sessionName: peer?.sessionName ?? this.currentSessionName ?? null,
      discoverable: peer?.discoverable !== false,
      reminder: reminderStatus(await this.getEffectiveReminder()),
      mailRoot: this.root,
      unpresented: {
        to: inbox.filter((item) => item.delivery?.kind === "to").length,
        cc: inbox.filter((item) => item.delivery?.kind === "cc").length,
      },
      activePeerCount: (await this.discover()).length,
    };
  }

  /** Oldest unpresented direct-To delivery time for the current mailbox, or null. */
  async oldestPendingToAt(): Promise<string | null> {
    const deliveries = await this.store.listDeliveries(this.sessionId);
    const pendingTo = deliveries.filter((delivery) => !delivery.presentedAt && delivery.kind === "to");
    return pendingTo.map((delivery) => delivery.deliveredAt).filter(Boolean).sort()[0] ?? null;
  }

  private async sendFrom(input: SendMailInput & {
    senderKind: SenderKind;
    senderId: string;
    senderAlias: string;
  }): Promise<MailMessage> {
    if (typeof input.body !== "string" || input.body.trim() === "") {
      throw new Error("send requires a non-empty body");
    }

    let inReplyTo: string | null = null;
    let threadId: string | null = null;
    let toIds: string[];
    let ccIds: string[];
    let subject = input.subject;

    if (input.replyTo) {
      const parentId = await this.resolveMessageId(input.replyTo);
      const parent = await this.store.getMessage(parentId);
      if (!parent) throw new Error(`Unknown reply_to message "${input.replyTo}"`);

      inReplyTo = parent.id;
      threadId = parent.threadId;

      if (input.to?.length) {
        toIds = await this.resolveMany(input.to);
        ccIds = await this.resolveMany(input.cc ?? []);
      } else {
        toIds = [parent.from];
        ccIds = input.replyAll
          ? unique([...parent.to, ...parent.cc]).filter(
              (id) => id !== input.senderId && id !== parent.from,
            )
          : [];
      }

      if (!subject) subject = /^re:/i.test(parent.subject) ? parent.subject : `Re: ${parent.subject}`;
    } else {
      if (!input.to?.length) throw new Error("A new message requires at least one To recipient");
      toIds = await this.resolveMany(input.to);
      ccIds = await this.resolveMany(input.cc ?? []);
    }

    toIds = unique(toIds);
    ccIds = unique(ccIds).filter((id) => !toIds.includes(id));
    if (toIds.length === 0) throw new Error("Message has no To recipients after resolution");

    // Resolve the sender alias only after registration: a lazily registering
    // session may gain its collision-checked alias during ensureRegistered.
    let senderAlias = input.senderAlias;
    if (input.senderKind === "session") {
      senderAlias = (await this.store.getPeer(input.senderId))?.alias ?? senderAlias;
    }

    if (input.senderKind === "session") {
      // A session's first durable mail write registers its mailbox record.
      await this.ensureRegistered();
      await this.makeMailboxDurable(input.senderId);
    } else {
      await this.ensureStore();
    }
    for (const recipientId of unique([...toIds, ...ccIds])) {
      await this.makeMailboxDurable(recipientId);
    }

    const createdAt = nowIso();
    let message: MessageRecord | null = null;

    // The store claims each candidate atomically, so concurrent senders cannot
    // both create the same canonical message.
    for (let attempt = 0; attempt < MAX_MESSAGE_ID_ATTEMPTS; attempt += 1) {
      const id = generateMessageId();
      message = {
        version: 1,
        id,
        senderKind: input.senderKind,
        from: input.senderId,
        fromAlias: senderAlias,
        to: toIds,
        cc: ccIds,
        subject: String(subject ?? "(no subject)").trim() || "(no subject)",
        body: input.body,
        notify: input.notify === true,
        threadId: threadId ?? id,
        inReplyTo,
        createdAt,
      };

      if (await this.store.tryCreateMessage(message)) break;
      message = null;
    }

    if (!message) {
      throw new Error(`Unable to allocate a unique message ID after ${MAX_MESSAGE_ID_ATTEMPTS} attempts`);
    }

    await this.deliver(message, "to", toIds);
    await this.deliver(message, "cc", ccIds);
    return this.decorateMessage(message);
  }

  private async deliver(message: MessageRecord, kind: RecipientKind, recipients: string[]): Promise<void> {
    for (const recipientId of recipients) {
      await this.store.putDelivery({
        version: 1,
        messageId: message.id,
        recipientId,
        kind,
        deliveredAt: nowIso(),
        presentedAt: null,
      });
    }
  }

  private async resolveMessageId(reference: string): Promise<string> {
    const query = String(reference ?? "").trim();
    if (!query) throw new Error("Message reference cannot be empty");

    if (await this.store.getMessage(query)) return query;

    if (query.replaceAll("-", "").length >= LEGACY_MESSAGE_REF_MIN_LENGTH) {
      const matches = (await this.store.listMessages())
        .filter((message) => isLegacyUuidMessageId(message.id) && matchesIdFragment(message.id, query));

      if (matches.length === 1) return matches[0].id;
      if (matches.length > 1) {
        const candidates = matches
          .slice(0, 5)
          .map((message) => `${legacyMessageRef(message.id)} (${message.id})`)
          .join(", ");
        throw new Error(`Ambiguous legacy message id fragment "${query}". Candidates: ${candidates}`);
      }
    }

    throw new Error(`Unknown message "${query}". Use the complete message ID shown by inbox, sent, wait, or thread.`);
  }

  private async resolveOne(address: string): Promise<string> {
    const query = String(address ?? "").trim();
    if (!query) throw new Error("Recipient address cannot be empty");

    if (query === HUMAN_PRINCIPAL_ID || query.toLowerCase() === HUMAN_PRINCIPAL_ALIAS) {
      return HUMAN_PRINCIPAL_ID;
    }

    // Sessions without a durable peer record are still addressable while they
    // are live: their heartbeat advertises id and alias.
    const peers = (await this.store.listPeers()).filter((peer) => !peer.deletedAt);
    const peerIds = new Set(peers.map((peer) => peer.id));
    const presenceCandidates = (await this.activePresence())
      .filter((presence) => !peerIds.has(presence.sessionId))
      .map((presence) => ({
        id: presence.sessionId,
        alias: presence.alias ?? shortSessionId(presence.sessionId),
      }));
    const candidates = [
      ...peers.map((peer) => ({ id: peer.id, alias: peer.alias })),
      ...presenceCandidates,
    ];

    const exactId = candidates.find((candidate) => candidate.id === query);
    if (exactId) return exactId.id;

    if (query.replaceAll("-", "").length >= SESSION_ID_FRAGMENT_MIN_LENGTH) {
      const idMatches = candidates.filter((candidate) => matchesIdFragment(candidate.id, query));
      if (idMatches.length === 1) return idMatches[0].id;
      if (idMatches.length > 1) {
        const candidatesText = idMatches
          .map((candidate) => `${candidate.alias} (${shortSessionId(candidate.id)})`)
          .join(", ");
        throw new Error(`Ambiguous session id fragment "${query}". Candidates: ${candidatesText}`);
      }
    }

    const aliasMatches = candidates.filter(
      (candidate) => candidate.alias.toLowerCase() === query.toLowerCase(),
    );
    if (aliasMatches.length === 1) return aliasMatches[0].id;

    if (aliasMatches.length > 1) {
      const active = await this.activeSessionIds();
      const activeMatches = aliasMatches.filter((candidate) => active.has(candidate.id));
      if (activeMatches.length === 1) return activeMatches[0].id;

      const candidatesText = aliasMatches
        .map((candidate) => `${candidate.alias} (${shortSessionId(candidate.id)})`)
        .join(", ");
      throw new Error(`Ambiguous alias "${query}". Candidates: ${candidatesText}`);
    }

    throw new Error(`Unknown recipient "${query}". Use mail action=discover to find peers.`);
  }

  private async resolveMany(addresses: string[]): Promise<string[]> {
    const resolved: string[] = [];
    for (const address of addresses) resolved.push(await this.resolveOne(address));
    return unique(resolved);
  }

  private async decorateMessage(
    message: MessageRecord,
    delivery?: DeliveryRecord | null,
  ): Promise<MailMessage> {
    const peers = await this.peerMap();
    const label = (id: string, fallbackAlias?: string): PeerAddress => {
      if (id === HUMAN_PRINCIPAL_ID) {
        return { id, shortId: "human", alias: HUMAN_PRINCIPAL_ALIAS };
      }
      const peer = peers.get(id);
      return {
        id,
        shortId: shortSessionId(id),
        alias: peer?.alias ?? fallbackAlias ?? shortSessionId(id),
      };
    };

    return {
      id: message.id,
      senderKind: senderKindOf(message),
      from: label(message.from, message.fromAlias),
      to: message.to.map((id) => label(id)),
      cc: message.cc.map((id) => label(id)),
      subject: message.subject,
      body: message.body,
      notify: message.notify === true,
      threadId: message.threadId,
      inReplyTo: message.inReplyTo,
      createdAt: message.createdAt,
      delivery: delivery
        ? {
            kind: delivery.kind,
            deliveredAt: delivery.deliveredAt,
            presentedAt: delivery.presentedAt,
          }
        : undefined,
    };
  }

  private async recipientStatuses(message: MessageRecord) {
    const peers = await this.peerMap();
    const active = await this.activeSessionIds();
    const output = [];

    for (const [kind, ids] of [["to", message.to], ["cc", message.cc]] as const) {
      for (const recipientId of ids) {
        const delivery = await this.store.getDelivery(recipientId, message.id);
        output.push({
          id: recipientId,
          shortId: recipientId === HUMAN_PRINCIPAL_ID ? "human" : shortSessionId(recipientId),
          alias: recipientId === HUMAN_PRINCIPAL_ID
            ? HUMAN_PRINCIPAL_ALIAS
            : peers.get(recipientId)?.alias ?? shortSessionId(recipientId),
          kind,
          deliveredAt: delivery?.deliveredAt ?? null,
          presentedAt: delivery?.presentedAt ?? null,
          active: recipientId === HUMAN_PRINCIPAL_ID ? null : active.has(recipientId),
        });
      }
    }
    return output;
  }

  private async makeMailboxDurable(peerId: string): Promise<void> {
    if (peerId === HUMAN_PRINCIPAL_ID) return;
    if (peerId === this.sessionId) {
      await this.updateCurrentPeer(makePeerDurable);
      return;
    }

    let peer = await this.store.getPeer(peerId);
    if (!peer) {
      // A lazily registering recipient is addressed through its heartbeat;
      // materialize the record so the new delivery has a durable owner.
      const presence = (await this.activePresence())
        .find((candidate) => candidate.sessionId === peerId);
      if (!presence) throw new Error(`Session mailbox "${peerId}" no longer exists`);
      const timestamp = nowIso();
      await this.store.putPeer({
        version: 2,
        id: peerId,
        alias: presence.alias ?? shortSessionId(peerId),
        cwd: presence.cwd,
        discoverable: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      peer = await this.store.getPeer(peerId);
    }
    if (!peer) throw new Error(`Session mailbox "${peerId}" no longer exists`);
    const durable = makePeerDurable(peer);
    if (durable !== peer) await this.store.putPeer(durable);
  }

  private async discardUnusedMailbox(): Promise<void> {
    const peer = await this.store.getPeer(this.sessionId);
    if (peer?.provisional !== true) return;
    if ((await this.activeSessionIds()).has(this.sessionId)) return;

    // A delivery written by an older Pi Mail version also makes the mailbox
    // durable even though that sender could not clear the provisional marker.
    if ((await this.store.listDeliveries(this.sessionId)).length > 0) {
      await this.makeMailboxDurable(this.sessionId);
      return;
    }

    const latest = await this.store.getPeer(this.sessionId);
    if (latest?.provisional !== true) return;
    if ((await this.store.listDeliveries(this.sessionId)).length > 0) {
      await this.makeMailboxDurable(this.sessionId);
      return;
    }

    if (!await this.store.removeMailboxIfEmpty(this.sessionId)) return;

    const removable = await this.store.getPeer(this.sessionId);
    if (removable?.provisional === true) await this.store.removePeer(this.sessionId);
  }

  private async updateCurrentPeer(
    update: (peer: PeerRecordV2) => PeerRecordV2,
  ): Promise<PeerRecordV2> {
    let resolveResult!: (peer: PeerRecordV2) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<PeerRecordV2>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    this.peerMutationQueue = this.peerMutationQueue.then(async () => {
      try {
        const peer = await this.store.getPeer(this.sessionId);
        if (!peer) throw new Error("Current session is not registered");
        const next = update(peer);
        if (next !== peer) await this.store.putPeer(next);
        resolveResult(next);
      } catch (error) {
        rejectResult(error);
      }
    });
    return result;
  }

  private observedReminderForPeer(self: boolean, peer: PeerRecordV2 | null): ReminderStatus | null {
    if (self) return reminderStatus(this.effectiveReminderForPeer(peer));
    if (!peer || !Object.hasOwn(peer, "reminder")) return null;
    return reminderStatus({
      policy: parseReminderPolicy(peer.reminder),
      source: "mailbox",
    });
  }

  private effectiveReminderForPeer(peer: PeerRecordV2 | null): EffectiveReminderPolicy {
    if (!peer || !Object.hasOwn(peer, "reminder")) return this.defaultReminder;
    return {
      policy: parseReminderPolicy(peer.reminder as StoredReminderOverride),
      source: "mailbox",
    };
  }

  private async currentPresence() {
    const all = await this.presenceStore.listPresence();
    return all.find(
      (presence) => presence.sessionId === this.sessionId && presence.runtimeId === this.runtimeId,
    ) ?? null;
  }

  private async activePresence() {
    const cutoff = Date.now() - this.presenceTtlMs;
    const all = await this.presenceStore.listPresence();
    return all.filter((presence) => {
      const seen = Date.parse(presence.lastSeenAt);
      return Number.isFinite(seen) && seen >= cutoff;
    });
  }

  private async activeSessionIds(): Promise<Set<string>> {
    return new Set((await this.activePresence()).map((presence) => presence.sessionId));
  }

  /**
   * Identity map for display and addressing: durable peer records, plus
   * heartbeat-advertised identities for sessions that have not registered.
   */
  private async peerMap(): Promise<Map<string, PeerRecordV2>> {
    const map = new Map((await this.store.listPeers()).map((peer) => [peer.id, peer]));
    for (const presence of await this.activePresence()) {
      if (map.has(presence.sessionId)) continue;
      map.set(presence.sessionId, {
        version: 2,
        id: presence.sessionId,
        alias: presence.alias ?? shortSessionId(presence.sessionId),
        cwd: presence.cwd,
        discoverable: true,
        createdAt: presence.startedAt,
        updatedAt: presence.lastSeenAt,
      });
    }
    return map;
  }
}
