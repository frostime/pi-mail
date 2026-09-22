import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

export function assertSafeId(value: string, label = "id"): void {
  if (!SAFE_ID.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
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

export async function listJson<T>(dir: string): Promise<T[]> {
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
