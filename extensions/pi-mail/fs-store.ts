import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type {
  DeliveryRecord,
  MessageRecord,
  PeerRecord,
  PresenceRecord,
} from "./types.ts";

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function assertSafeId(value: string, label = "id"): void {
  if (!SAFE_ID.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  try {
    await rename(tmp, file);
  } catch (error) {
    // rename() is atomic on the local filesystems we target, but Windows does
    // not consistently replace an existing destination. The fallback keeps
    // the update local to one delivery/presence record instead of introducing
    // a cross-process lock protocol.
    if (errorCode(error) === "EEXIST" || errorCode(error) === "EPERM") {
      await rm(file, { force: true });
      await rename(tmp, file);
      return;
    }

    await rm(tmp, { force: true });
    throw error;
  }
}

async function listJson<T>(dir: string): Promise<T[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }

  const values: T[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const value = await readJson<T>(path.join(dir, name));
    if (value) values.push(value);
  }
  return values;
}

export class FsMailStore {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async init(): Promise<void> {
    for (const dir of ["peers", "presence", "messages", "mailboxes"]) {
      await mkdir(path.join(this.root, dir), { recursive: true });
    }

    const ignoreFile = path.join(this.root, ".gitignore");
    try {
      await writeFile(ignoreFile, "# Pi Mail runtime data\n*\n!.gitignore\n", {
        encoding: "utf8",
        flag: "wx",
        mode: 0o644,
      });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }

  async getPeer(peerId: string): Promise<PeerRecord | null> {
    return readJson(this.peerFile(peerId));
  }

  async putPeer(peer: PeerRecord): Promise<void> {
    await atomicWriteJson(this.peerFile(peer.id), peer);
  }

  async listPeers(): Promise<PeerRecord[]> {
    return listJson(path.join(this.root, "peers"));
  }

  async putPresence(presence: PresenceRecord): Promise<void> {
    await atomicWriteJson(
      this.presenceFile(presence.sessionId, presence.runtimeId),
      presence,
    );
  }

  async removePresence(sessionId: string, runtimeId: string): Promise<void> {
    await rm(this.presenceFile(sessionId, runtimeId), { force: true });

    try {
      await rmdir(path.join(this.root, "presence", sessionId));
    } catch {
      // A non-empty directory means another runtime for this session is still
      // present and therefore must remain discoverable.
    }
  }

  async listPresence(): Promise<PresenceRecord[]> {
    const base = path.join(this.root, "presence");
    let sessionDirs;
    try {
      sessionDirs = await readdir(base, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }

    const values: PresenceRecord[] = [];
    for (const entry of sessionDirs) {
      if (!entry.isDirectory()) continue;
      values.push(...await listJson<PresenceRecord>(path.join(base, entry.name)));
    }
    return values;
  }

  async putMessage(message: MessageRecord): Promise<void> {
    const file = this.messageFile(message.id);
    await mkdir(path.dirname(file), { recursive: true });

    // Canonical messages are immutable. "wx" converts an astronomically
    // unlikely ID collision into a visible failure instead of silent overwrite.
    await writeFile(file, `${JSON.stringify(message, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  }

  async getMessage(messageId: string): Promise<MessageRecord | null> {
    return readJson(this.messageFile(messageId));
  }

  async listMessages(): Promise<MessageRecord[]> {
    return listJson(path.join(this.root, "messages"));
  }

  async putDelivery(delivery: DeliveryRecord): Promise<void> {
    await atomicWriteJson(
      this.deliveryFile(delivery.recipientId, delivery.messageId),
      delivery,
    );
  }

  async getDelivery(recipientId: string, messageId: string): Promise<DeliveryRecord | null> {
    return readJson(this.deliveryFile(recipientId, messageId));
  }

  async listDeliveries(recipientId: string): Promise<DeliveryRecord[]> {
    assertSafeId(recipientId, "recipient id");
    return listJson(path.join(this.root, "mailboxes", recipientId));
  }

  async updateDelivery(
    recipientId: string,
    messageId: string,
    update: Partial<Pick<DeliveryRecord, "presentedAt">>,
  ): Promise<DeliveryRecord | null> {
    const current = await this.getDelivery(recipientId, messageId);
    if (!current) return null;

    const next = { ...current, ...update };
    await this.putDelivery(next);
    return next;
  }

  private peerFile(peerId: string): string {
    assertSafeId(peerId, "peer id");
    return path.join(this.root, "peers", `${peerId}.json`);
  }

  private presenceFile(sessionId: string, runtimeId: string): string {
    assertSafeId(sessionId, "session id");
    assertSafeId(runtimeId, "runtime id");
    return path.join(this.root, "presence", sessionId, `${runtimeId}.json`);
  }

  private messageFile(messageId: string): string {
    assertSafeId(messageId, "message id");
    return path.join(this.root, "messages", `${messageId}.json`);
  }

  private deliveryFile(recipientId: string, messageId: string): string {
    assertSafeId(recipientId, "recipient id");
    assertSafeId(messageId, "message id");
    return path.join(this.root, "mailboxes", recipientId, `${messageId}.json`);
  }
}
