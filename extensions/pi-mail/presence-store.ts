import { mkdir, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertSafeId,
  atomicWriteJson,
  errorCode,
  listJson,
} from "./store-util.ts";
import type { PresenceRecord } from "./types.ts";

/**
 * Ephemeral presence storage. Presence lives outside the project directory so
 * that starting a session never creates project-side directories; the durable
 * project store is only created once real mail data exists.
 *
 * Layout: `<bucket>/<sessionId>/<runtimeId>.json`. The bucket is keyed by the
 * canonical project root (see resolvePresenceRoot in project-root.ts), so all
 * sessions of one project converge on the same directory regardless of how the
 * project path is spelled.
 */
export class FsPresenceStore {
  readonly root: string;
  private readonly projectRoot: string;

  constructor(root: string, projectRoot: string) {
    this.root = path.resolve(root);
    this.projectRoot = projectRoot;
  }

  async putPresence(presence: PresenceRecord): Promise<void> {
    await this.ensureBucket();
    await atomicWriteJson(this.presenceFile(presence.sessionId, presence.runtimeId), presence);
  }

  async removePresence(sessionId: string, runtimeId: string): Promise<void> {
    assertSafeId(sessionId, "session id");
    assertSafeId(runtimeId, "runtime id");
    await rm(this.presenceFile(sessionId, runtimeId), { force: true });

    try {
      await rmdir(path.join(this.root, sessionId));
    } catch {
      // A non-empty directory means another runtime for this session is still
      // present and therefore must remain discoverable.
    }
  }

  async removeSessionPresence(sessionId: string): Promise<void> {
    assertSafeId(sessionId, "session id");
    await rm(path.join(this.root, sessionId), { recursive: true, force: true });
  }

  async listPresence(): Promise<PresenceRecord[]> {
    let sessionDirs;
    try {
      sessionDirs = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }

    const values: PresenceRecord[] = [];
    for (const entry of sessionDirs) {
      if (!entry.isDirectory()) continue;
      values.push(...await listJson<PresenceRecord>(path.join(this.root, entry.name)));
    }
    return values;
  }

  /**
   * Delete presence files whose last heartbeat is older than `staleMs`. A live
   * runtime rewrites its file at least every few seconds, so file mtime is a
   * reliable liveness signal; the generous threshold protects slow or
   * suspended runtimes from being swept.
   */
  async sweepStale(staleMs: number): Promise<void> {
    let sessionDirs;
    try {
      sessionDirs = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }

    const cutoff = Date.now() - staleMs;
    for (const entry of sessionDirs) {
      if (!entry.isDirectory()) continue;
      const sessionDir = path.join(this.root, entry.name);

      let names: string[];
      try {
        names = await readdir(sessionDir);
      } catch {
        continue;
      }

      let remaining = false;
      for (const name of names) {
        if (!name.endsWith(".json")) {
          remaining = true;
          continue;
        }
        try {
          const info = await stat(path.join(sessionDir, name));
          if (info.mtimeMs < cutoff) await rm(path.join(sessionDir, name), { force: true });
          else remaining = true;
        } catch {
          remaining = true;
        }
      }

      if (!remaining) await rmdir(sessionDir).catch(() => {});
    }
  }

  private async ensureBucket(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    // A human-readable pointer makes orphaned buckets diagnosable; the hashed
    // directory name alone says nothing about which project it belongs to.
    try {
      await writeFile(
        path.join(this.root, "project.json"),
        `${JSON.stringify({ version: 1, projectRoot: this.projectRoot }, null, 2)}\n`,
        { flag: "wx", mode: 0o644 },
      );
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }

  private presenceFile(sessionId: string, runtimeId: string): string {
    assertSafeId(sessionId, "session id");
    assertSafeId(runtimeId, "runtime id");
    return path.join(this.root, sessionId, `${runtimeId}.json`);
  }
}
