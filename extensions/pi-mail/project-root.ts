import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Resolve the project root that owns Pi Mail's shared runtime directory.
 *
 * Linked Git worktrees intentionally resolve to the main checkout: Git's
 * common directory is shared by the whole worktree family, so all sessions in
 * that family must see the same mailbox namespace.
 */
export function resolveProjectRoot(cwd: string): string {
  const absoluteCwd = path.resolve(cwd);

  try {
    const topLevel = execFileSync(
      "git",
      ["-C", absoluteCwd, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();

    const commonRaw = execFileSync(
      "git",
      ["-C", absoluteCwd, "rev-parse", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();

    const commonDir = path.isAbsolute(commonRaw)
      ? path.normalize(commonRaw)
      : path.resolve(topLevel, commonRaw);

    if (path.basename(commonDir) === ".git") {
      return path.dirname(commonDir);
    }

    // Non-standard Git layouts are kept local rather than guessing a parent
    // that might accidentally merge unrelated communication namespaces.
    return path.resolve(topLevel);
  } catch {
    return absoluteCwd;
  }
}

export function resolveMailRoot(cwd: string): string {
  return path.join(resolveProjectRoot(cwd), ".pi", "mails");
}

/** Base directory for Pi Mail's project-keyed ephemeral runtime data. */
const PRESENCE_BASE_OVERRIDE_ENV = "PI_MAIL_PRESENCE_ROOT";

function presenceBase(): string {
  const override = process.env[PRESENCE_BASE_OVERRIDE_ENV]?.trim();
  if (override) return override;
  // Pi's own agent-directory resolution (PI_CODING_AGENT_DIR override, forked
  // configDir) is the sanctioned "Pi home" anchor; keep ephemeral data with it.
  return path.join(getAgentDir(), "tmp", "pi-mail");
}

/**
 * Resolve the ephemeral presence bucket for a project: a hashed directory
 * under the user's Pi temp area.
 *
 * The key must be derived from the same canonicalization that picks the mail
 * store location, so presence splitting can never diverge more than the store
 * itself does. realpathSync resolves the remaining aliasing layer (symbolic
 * links, junctions, path case) on top of the Git-based root; exotic aliases
 * such as subst drives are explicitly out of scope.
 */
export function resolvePresenceRoot(cwd: string): { root: string; projectRoot: string } {
  const logicalRoot = resolveProjectRoot(cwd);

  // The project root contains cwd and therefore exists; realpath it to strip
  // symbolic links, junctions, and path-case spelling differences.
  let canonical: string;
  try {
    canonical = realpathSync.native(logicalRoot);
  } catch {
    canonical = logicalRoot;
  }

  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return { root: path.join(presenceBase(), hash), projectRoot: canonical };
}
