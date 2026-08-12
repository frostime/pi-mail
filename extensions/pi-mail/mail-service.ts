import { randomUUID } from "node:crypto";

import { FsMailStore } from "./fs-store.ts";
import { matchesIdFragment, MIN_ID_FRAGMENT_LENGTH, shortMessageId, shortSessionId } from "./identity.ts";
import { resolveMailRoot } from "./project-root.ts";
import type {
  DeliveryRecord,
  DiscoveredPeer,
  MailMessage,
  MailStatus,
  MessageRecord,
  PeerAddress,
  PeerRecord,
  ProjectMessageSummary,
  RecipientKind,
  SentMessageSummary,
  SenderKind,
  WaitResult,
} from "./types.ts";

const DEFAULT_PRESENCE_TTL_MS = 20_000;
const DEFAULT_LIMIT = 20;
const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const MAX_WAIT_TIMEOUT_MS = 300_000;
const WAIT_POLL_INTERVAL_MS = 250;
const WAIT_RESULT_LIMIT = 20;
export const HUMAN_PRINCIPAL_ID = "human-local";
export const HUMAN_PRINCIPAL_ALIAS = "user";

export interface MailServiceOptions {
  cwd: string;
  sessionId: string;
  runtimeId?: string;
  presenceTtlMs?: number;
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

function nowIso(): string {
  return new Date().toISOString();
}

function defaultAlias(sessionId: string): string {
  return `session-${shortSessionId(sessionId)}`;
}

function legacyDefaultAlias(sessionId: string): string {
  return `session-${sessionId.slice(0, 8)}`;
}

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

function senderKindOf(message: MessageRecord): SenderKind {
  return message.senderKind === "human" ? "human" : "session";
}

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

  constructor({
    cwd,
    sessionId,
    runtimeId = randomUUID(),
    presenceTtlMs = DEFAULT_PRESENCE_TTL_MS,
  }: MailServiceOptions) {
    if (!sessionId) throw new Error("sessionId is required");

    this.cwd = cwd;
    this.sessionId = sessionId;
    this.runtimeId = runtimeId;
    this.presenceTtlMs = presenceTtlMs;
    this.root = resolveMailRoot(cwd);
    this.store = new FsMailStore(this.root);
  }

  async init(options: { alias?: string; discoverable?: boolean; sessionName?: string | null } = {}): Promise<PeerRecord> {
    await this.store.init();

    const timestamp = nowIso();
    const existing = await this.store.getPeer(this.sessionId);
    const sessionName = options.sessionName === undefined
      ? existing?.sessionName
      : normalizeSessionName(options.sessionName);
    const requestedAlias = normalizeAlias(options.alias);
    const existingAlias = existing?.alias === legacyDefaultAlias(this.sessionId)
      ? undefined
      : existing?.alias;
    const peer: PeerRecord = {
      version: 1,
      id: this.sessionId,
      alias: existingAlias ?? requestedAlias ?? defaultAlias(this.sessionId),
      ...(sessionName ? { sessionName } : {}),
      cwd: this.cwd,
      discoverable: existing?.discoverable ?? options.discoverable ?? true,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };

    await this.store.putPeer(peer);
    await this.heartbeat();
    return peer;
  }

  async heartbeat(): Promise<void> {
    const timestamp = nowIso();
    const current = await this.currentPresence();
    await this.store.putPresence({
      version: 1,
      sessionId: this.sessionId,
      runtimeId: this.runtimeId,
      pid: process.pid,
      cwd: this.cwd,
      startedAt: current?.startedAt ?? timestamp,
      lastSeenAt: timestamp,
    });
  }

  async syncSessionName(sessionName: string | null | undefined): Promise<void> {
    const peer = await this.store.getPeer(this.sessionId);
    if (!peer) return;

    const nextName = normalizeSessionName(sessionName);
    if ((peer.sessionName ?? undefined) === nextName) return;

    const next = { ...peer, updatedAt: nowIso() };
    if (nextName) next.sessionName = nextName;
    else delete next.sessionName;
    await this.store.putPeer(next);
  }

  async close(): Promise<void> {
    await this.store.removePresence(this.sessionId, this.runtimeId);
  }

  async configure(options: { alias?: string; discoverable?: boolean } = {}): Promise<PeerRecord> {
    const peer = await this.store.getPeer(this.sessionId);
    if (!peer) throw new Error("Current session is not registered");
    if (options.alias === undefined && options.discoverable === undefined) {
      throw new Error("configure requires alias and/or discoverable");
    }

    const next: PeerRecord = {
      ...peer,
      alias: options.alias === undefined ? peer.alias : normalizeAlias(options.alias)!,
      discoverable: options.discoverable ?? peer.discoverable,
      updatedAt: nowIso(),
    };
    await this.store.putPeer(next);
    return next;
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

  private async listSessions(options: {
    includeInactive: boolean;
    includeSelf: boolean;
    includeUndiscoverable: boolean;
  }): Promise<DiscoveredPeer[]> {
    const peers = await this.store.listPeers();
    const activePresence = await this.activePresence();
    const presenceBySession = new Map<string, typeof activePresence>();

    for (const presence of activePresence) {
      const list = presenceBySession.get(presence.sessionId) ?? [];
      list.push(presence);
      presenceBySession.set(presence.sessionId, list);
    }

    return peers
      .filter((peer) => !peer.deletedAt)
      .filter((peer) => options.includeSelf || peer.id !== this.sessionId)
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
      })
      .sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        if (a.self !== b.self) return a.self ? -1 : 1;
        return a.alias.localeCompare(b.alias);
      });
  }

  async send(input: SendMailInput = {}): Promise<MailMessage> {
    return this.sendFrom({
      senderKind: "session",
      senderId: this.sessionId,
      senderAlias: (await this.store.getPeer(this.sessionId))?.alias ?? defaultAlias(this.sessionId),
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
    if (peerId === HUMAN_PRINCIPAL_ID) throw new Error("The human principal has no deletable session mailbox");
    if (peerId === this.sessionId) throw new Error("Cannot delete the mailbox of the current active session");

    const active = await this.activeSessionIds();
    if (active.has(peerId)) throw new Error("Cannot delete an active session mailbox");

    const peer = await this.store.getPeer(peerId);
    if (!peer || peer.deletedAt) throw new Error(`Unknown session mailbox "${address}"`);

    await this.store.removeMailbox(peerId);
    await this.store.removeSessionPresence(peerId);
    await this.store.removePeer(peerId);

    return { id: peer.id, shortId: shortSessionId(peer.id), alias: peer.alias };
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

    const entries: MailMessage[] = [];
    for (const delivery of deliveries) {
      const message = await this.store.getMessage(delivery.messageId);
      if (!message) continue;

      let visibleDelivery = delivery;
      if (markPresented && !delivery.presentedAt) {
        visibleDelivery = await this.store.updateDelivery(this.sessionId, delivery.messageId, {
          presentedAt: nowIso(),
        }) ?? delivery;
      }
      entries.push(await this.decorateMessage(message, visibleDelivery));
    }

    entries.sort(oldestFirst ? sortByCreatedAsc : sortByCreatedDesc);
    return entries.slice(0, boundedLimit(options.limit));
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
        shortId: shortMessageId(message.id),
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
    const inbox = await this.listInbox({
      unpresentedOnly: true,
      limit: 100,
      markPresented: false,
    }) as MailMessage[];

    return {
      id: this.sessionId,
      shortId: shortSessionId(this.sessionId),
      alias: peer?.alias ?? defaultAlias(this.sessionId),
      sessionName: peer?.sessionName ?? null,
      discoverable: peer?.discoverable !== false,
      mailRoot: this.root,
      unpresented: {
        to: inbox.filter((item) => item.delivery?.kind === "to").length,
        cc: inbox.filter((item) => item.delivery?.kind === "cc").length,
      },
      activePeerCount: (await this.discover()).length,
    };
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

    const id = randomUUID();
    const createdAt = nowIso();
    const message: MessageRecord = {
      version: 1,
      id,
      senderKind: input.senderKind,
      from: input.senderId,
      fromAlias: input.senderAlias,
      to: toIds,
      cc: ccIds,
      subject: String(subject ?? "(no subject)").trim() || "(no subject)",
      body: input.body,
      notify: input.notify === true,
      threadId: threadId ?? id,
      inReplyTo,
      createdAt,
    };

    await this.store.putMessage(message);
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
        deliveredAt: message.createdAt,
        presentedAt: null,
      });
    }
  }

  private async resolveMessageId(reference: string): Promise<string> {
    const query = String(reference ?? "").trim();
    if (!query) throw new Error("Message reference cannot be empty");

    if (await this.store.getMessage(query)) return query;

    if (query.replaceAll("-", "").length < MIN_ID_FRAGMENT_LENGTH) {
      throw new Error(`Unknown message "${query}". Message ID fragments must be at least ${MIN_ID_FRAGMENT_LENGTH} characters.`);
    }

    const matches = (await this.store.listMessages())
      .filter((message) => matchesIdFragment(message.id, query));

    if (matches.length === 1) return matches[0].id;
    if (matches.length > 1) {
      const candidates = matches
        .slice(0, 5)
        .map((message) => `${shortMessageId(message.id)} (${message.id})`)
        .join(", ");
      throw new Error(`Ambiguous message id fragment "${query}". Candidates: ${candidates}`);
    }

    throw new Error(`Unknown message "${query}". Use mail action=inbox, sent, or thread with a known message ID.`);
  }

  private async resolveOne(address: string): Promise<string> {
    const query = String(address ?? "").trim();
    if (!query) throw new Error("Recipient address cannot be empty");

    if (query === HUMAN_PRINCIPAL_ID || query.toLowerCase() === HUMAN_PRINCIPAL_ALIAS) {
      return HUMAN_PRINCIPAL_ID;
    }

    const peers = (await this.store.listPeers()).filter((peer) => !peer.deletedAt);
    const exactId = peers.find((peer) => peer.id === query);
    if (exactId) return exactId.id;

    if (query.replaceAll("-", "").length >= MIN_ID_FRAGMENT_LENGTH) {
      const idMatches = peers.filter((peer) => matchesIdFragment(peer.id, query));
      if (idMatches.length === 1) return idMatches[0].id;
      if (idMatches.length > 1) {
        const candidates = idMatches
          .map((peer) => `${peer.alias} (${shortSessionId(peer.id)})`)
          .join(", ");
        throw new Error(`Ambiguous session id fragment "${query}". Candidates: ${candidates}`);
      }
    }

    const aliasMatches = peers.filter(
      (peer) => peer.alias.toLowerCase() === query.toLowerCase(),
    );
    if (aliasMatches.length === 1) return aliasMatches[0].id;

    if (aliasMatches.length > 1) {
      const active = await this.activeSessionIds();
      const activeMatches = aliasMatches.filter((peer) => active.has(peer.id));
      if (activeMatches.length === 1) return activeMatches[0].id;

      const candidates = aliasMatches
        .map((peer) => `${peer.alias} (${shortSessionId(peer.id)})`)
        .join(", ");
      throw new Error(`Ambiguous alias "${query}". Candidates: ${candidates}`);
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
      shortId: shortMessageId(message.id),
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

  private async currentPresence() {
    const all = await this.store.listPresence();
    return all.find(
      (presence) => presence.sessionId === this.sessionId && presence.runtimeId === this.runtimeId,
    ) ?? null;
  }

  private async activePresence() {
    const cutoff = Date.now() - this.presenceTtlMs;
    const all = await this.store.listPresence();
    return all.filter((presence) => {
      const seen = Date.parse(presence.lastSeenAt);
      return Number.isFinite(seen) && seen >= cutoff;
    });
  }

  private async activeSessionIds(): Promise<Set<string>> {
    return new Set((await this.activePresence()).map((presence) => presence.sessionId));
  }

  private async peerMap(): Promise<Map<string, PeerRecord>> {
    return new Map((await this.store.listPeers()).map((peer) => [peer.id, peer]));
  }
}
