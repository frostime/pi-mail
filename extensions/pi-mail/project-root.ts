import { execFileSync } from "node:child_process";
import path from "node:path";

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
