import {
  mkdir,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  assertSafeId,
  atomicWriteJson,
  errorCode,
  listJson,
  readJson,
} from "./store-util.ts";
import { decodePeerRecord, type PeerRecordV2 } from "./peer-record.ts";
import type {
  DeliveryRecord,
  MessageRecord,
} from "./types.ts";

const STORE_DIRECTORIES = ["peers", "messages", "mailboxes"] as const;
/** Presence storage left behind by pre-0.11 runtimes, kept cleanable. */
const LEGACY_PRESENCE_DIRECTORY = "presence";
/**
 * A running pre-0.11 runtime rewrites its presence file every few seconds, so
 * a file untouched for this long belongs to a crashed runtime; the generous
 * threshold protects slow or suspended sessions from being pruned.
 */
const LEGACY_PRESENCE_STALE_MS = 300_000;
const STORE_IGNORE_CONTENT = "# Pi Mail runtime data\n*\n";
const MANAGED_IGNORE_CONTENTS = new Set([
  STORE_IGNORE_CONTENT,
  "# Pi Mail runtime data\n*\n!.gitignore\n",
  "# Pi Mail runtime data\n*\n.gitignore\n",
]);

export class FsMailStore {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async init(): Promise<void> {
    for (const dir of STORE_DIRECTORIES) {
      await mkdir(path.join(this.root, dir), { recursive: true });
    }
    // A store created by an older Pi Mail version still owns a presence
    // directory inside the project; it is obsolete now that presence lives in
    // the user temp area, so prune crashed-runtime residue and clear it.
    await this.pruneLegacyPresence();
    await this.removeDirectoryIfEmpty(path.join(this.root, LEGACY_PRESENCE_DIRECTORY));
    await this.ensureIgnoreFile();
  }

  /** Remove a store that contains no mail data, without recursively deleting anything. */
  async removeIfEmpty(): Promise<boolean> {
    for (const dir of STORE_DIRECTORIES) {
      if (!await this.removeDirectoryIfEmpty(path.join(this.root, dir))) return false;
    }
    // Legacy in-project presence data is not mail data; stale residue from
    // crashed old-version runtimes must not block the store cleanup.
    await this.pruneLegacyPresence();
    if (!await this.removeDirectoryIfEmpty(path.join(this.root, LEGACY_PRESENCE_DIRECTORY))) {
      return false;
    }

    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return false;
      await this.removeEmptyPiParent();
      return true;
    }

    if (entries.some((entry) => entry !== ".gitignore")) return false;

    const ignoreFile = path.join(this.root, ".gitignore");
    if (entries.includes(".gitignore")) {
      let content: string;
      try {
        content = await readFile(ignoreFile, "utf8");
      } catch {
        return false;
      }
      if (!MANAGED_IGNORE_CONTENTS.has(content)) return false;

      try {
        await rm(ignoreFile);
      } catch {
        return false;
      }
    }

    try {
      await rmdir(this.root);
    } catch {
      // Another runtime may have populated the store after the emptiness check.
      await this.ensureIgnoreFile().catch(() => {});
      return false;
    }

    await this.removeEmptyPiParent();
    return true;
  }

  async getPeer(peerId: string): Promise<PeerRecordV2 | null> {
    const file = this.peerFile(peerId);
    const value = await readJson(file);
    return value === null ? null : decodePeerRecord(value, file);
  }

  async putPeer(peer: PeerRecordV2): Promise<void> {
    await atomicWriteJson(this.peerFile(peer.id), peer);
  }

  async listPeers(): Promise<PeerRecordV2[]> {
    const dir = path.join(this.root, "peers");
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }

    const peers: PeerRecordV2[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(dir, name);
      const value = await readJson(file);
      if (value !== null) peers.push(decodePeerRecord(value, file));
    }
    return peers;
  }

  async removePeer(peerId: string): Promise<void> {
    await rm(this.peerFile(peerId), { force: true });
  }

  async tryCreateMessage(message: MessageRecord): Promise<boolean> {
    const file = this.messageFile(message.id);
    await mkdir(path.dirname(file), { recursive: true });

    // Exclusive creation is the collision check. A separate existence check
    // would leave a race window between the check and this write.
    try {
      await writeFile(file, `${JSON.stringify(message, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return true;
    } catch (error) {
      if (errorCode(error) === "EEXIST") return false;
      throw error;
    }
  }

  async getMessage(messageId: string): Promise<MessageRecord | null> {
    return readJson(this.messageFile(messageId));
  }

  async listMessages(): Promise<MessageRecord[]> {
    return listJson(path.join(this.root, "messages"));
  }

  async removeMessage(messageId: string): Promise<void> {
    await rm(this.messageFile(messageId), { force: true });
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

  async listDeliveryIds(recipientId: string): Promise<string[]> {
    assertSafeId(recipientId, "recipient id");
    const dir = path.join(this.root, "mailboxes", recipientId);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }

    return names
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length));
  }

  async removeMailbox(recipientId: string): Promise<void> {
    assertSafeId(recipientId, "recipient id");
    await rm(path.join(this.root, "mailboxes", recipientId), { recursive: true, force: true });
  }

  async removeMailboxIfEmpty(recipientId: string): Promise<boolean> {
    assertSafeId(recipientId, "recipient id");
    return this.removeDirectoryIfEmpty(path.join(this.root, "mailboxes", recipientId));
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

  /**
   * Opportunistically delete legacy presence files whose owning runtime is
   * provably dead (stale mtime), so crash residue cannot block store cleanup
   * forever. Read failures are swallowed: this cleanup is not load-bearing.
   */
  private async pruneLegacyPresence(): Promise<void> {
    const base = path.join(this.root, LEGACY_PRESENCE_DIRECTORY);
    let sessionDirs;
    try {
      sessionDirs = await readdir(base, { withFileTypes: true });
    } catch {
      return;
    }

    const cutoff = Date.now() - LEGACY_PRESENCE_STALE_MS;
    for (const entry of sessionDirs) {
      if (!entry.isDirectory()) continue;
      const sessionDir = path.join(base, entry.name);

      let names;
      try {
        names = await readdir(sessionDir);
      } catch {
        continue;
      }

      for (const name of names) {
        const file = path.join(sessionDir, name);
        try {
          const info = await stat(file);
          if (info.mtimeMs < cutoff) await rm(file, { force: true });
        } catch {
          // Unreadable or already removed by a concurrent prune; retry later.
        }
      }
      await rmdir(sessionDir).catch(() => {});
    }
  }

  private async removeDirectoryIfEmpty(directory: string): Promise<boolean> {
    try {
      await rmdir(directory);
      return true;
    } catch (error) {
      return errorCode(error) === "ENOENT";
    }
  }

  private async removeEmptyPiParent(): Promise<void> {
    const parent = path.dirname(this.root);
    if (path.basename(this.root) === "mails" && path.basename(parent) === ".pi") {
      await rmdir(parent).catch(() => {});
    }
  }

  private async ensureIgnoreFile(): Promise<void> {
    const ignoreFile = path.join(this.root, ".gitignore");
    try {
      await writeFile(ignoreFile, STORE_IGNORE_CONTENT, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o644,
      });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }

  private peerFile(peerId: string): string {
    assertSafeId(peerId, "peer id");
    return path.join(this.root, "peers", `${peerId}.json`);
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
