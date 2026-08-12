import { randomUUID } from "node:crypto";

import { FsMailStore } from "./fs-store.ts";
import { resolveMailRoot } from "./project-root.ts";
import type {
  DeliveryRecord,
  DiscoveredPeer,
  MailMessage,
  MessageRecord,
  PeerAddress,
  PeerRecord,
  ProjectMessageSummary,
  RecipientKind,
  SentMessageSummary,
  SenderKind,
} from "./types.ts";

const DEFAULT_PRESENCE_TTL_MS = 20_000;
const DEFAULT_LIMIT = 20;
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
  replyTo?: string;
  replyAll?: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultAlias(sessionId: string): string {
  return `session-${sessionId.slice(0, 8)}`;
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

  async init(options: { alias?: string; discoverable?: boolean } = {}): Promise<PeerRecord> {
    await this.store.init();

    const timestamp = nowIso();
    const existing = await this.store.getPeer(this.sessionId);
    const peer: PeerRecord = {
      version: 1,
      id: this.sessionId,
      alias: existing?.alias ?? normalizeAlias(options.alias) ?? defaultAlias(this.sessionId),
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
    const peers = await this.store.listPeers();
    const activePresence = await this.activePresence();
    const presenceBySession = new Map<string, typeof activePresence>();

    for (const presence of activePresence) {
      const list = presenceBySession.get(presence.sessionId) ?? [];
      list.push(presence);
      presenceBySession.set(presence.sessionId, list);
    }

    return peers
      .filter((peer) => peer.id !== this.sessionId)
      .filter((peer) => peer.discoverable !== false)
      .filter((peer) => options.includeInactive || presenceBySession.has(peer.id))
      .map((peer) => {
        const presences = presenceBySession.get(peer.id) ?? [];
        const latest = presences
          .slice()
          .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))[0];

        return {
          id: peer.id,
          shortId: peer.id.slice(0, 8),
          alias: peer.alias,
          active: presences.length > 0,
          runtimeCount: presences.length,
          cwd: latest?.cwd ?? peer.cwd,
          lastSeenAt: latest?.lastSeenAt ?? null,
        };
      })
      .sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
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
    });
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
      const delivery = await this.store.getDelivery(this.sessionId, messageId);
      if (!delivery) throw new Error(`Message "${messageId}" is not in your inbox`);

      const message = await this.store.getMessage(messageId);
      if (!message) throw new Error(`Message "${messageId}" is missing from storage`);

      let nextDelivery = delivery;
      if (markPresented && !delivery.presentedAt) {
        nextDelivery = await this.store.updateDelivery(this.sessionId, messageId, {
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

  async listSent(options: { limit?: number } = {}): Promise<SentMessageSummary[]> {
    const messages = (await this.store.listMessages())
      .filter((message) => senderKindOf(message) === "session" && message.from === this.sessionId)
      .sort(sortByCreatedDesc)
      .slice(0, boundedLimit(options.limit));

    const output: SentMessageSummary[] = [];
    for (const message of messages) {
      output.push({
        id: message.id,
        shortId: message.id.slice(0, 8),
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

    const referencedMessage = await this.store.getMessage(reference);
    const threadId = referencedMessage?.threadId ?? reference;
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

  async status(): Promise<Record<string, unknown>> {
    const peer = await this.store.getPeer(this.sessionId);
    const inbox = await this.listInbox({
      unpresentedOnly: true,
      limit: 100,
      markPresented: false,
    }) as MailMessage[];

    return {
      id: this.sessionId,
      shortId: this.sessionId.slice(0, 8),
      alias: peer?.alias ?? defaultAlias(this.sessionId),
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
      const parent = await this.store.getMessage(input.replyTo);
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

  private async resolveOne(address: string): Promise<string> {
    const query = String(address ?? "").trim();
    if (!query) throw new Error("Recipient address cannot be empty");

    if (query === HUMAN_PRINCIPAL_ID || query.toLowerCase() === HUMAN_PRINCIPAL_ALIAS) {
      return HUMAN_PRINCIPAL_ID;
    }

    const peers = await this.store.listPeers();
    const exactId = peers.find((peer) => peer.id === query);
    if (exactId) return exactId.id;

    if (query.length >= 6) {
      const idMatches = peers.filter((peer) => peer.id.startsWith(query));
      if (idMatches.length === 1) return idMatches[0].id;
      if (idMatches.length > 1) throw new Error(`Ambiguous session id prefix "${query}"`);
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
        .map((peer) => `${peer.alias} (${peer.id.slice(0, 8)})`)
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
        shortId: id.slice(0, 8),
        alias: peer?.alias ?? fallbackAlias ?? id.slice(0, 8),
      };
    };

    return {
      id: message.id,
      shortId: message.id.slice(0, 8),
      senderKind: senderKindOf(message),
      from: label(message.from, message.fromAlias),
      to: message.to.map((id) => label(id)),
      cc: message.cc.map((id) => label(id)),
      subject: message.subject,
      body: message.body,
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
    const output = [];

    for (const [kind, ids] of [["to", message.to], ["cc", message.cc]] as const) {
      for (const recipientId of ids) {
        const delivery = await this.store.getDelivery(recipientId, message.id);
        output.push({
          id: recipientId,
          shortId: recipientId.slice(0, 8),
          alias: recipientId === HUMAN_PRINCIPAL_ID
            ? HUMAN_PRINCIPAL_ALIAS
            : peers.get(recipientId)?.alias ?? recipientId.slice(0, 8),
          kind,
          deliveredAt: delivery?.deliveredAt ?? null,
          presentedAt: delivery?.presentedAt ?? null,
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
