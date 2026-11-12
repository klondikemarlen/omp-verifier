import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(repositoryRoot, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  const { stdout } = await execFileAsync("git", ["--literal-pathspecs", "-C", repositoryRoot, ...args], {
    env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" },
    encoding: "buffer",
    timeout: 5_000,
    maxBuffer: 64_000,
  });
  const text = stdout.toString("utf8");
  if (!Buffer.from(text).equals(stdout)) throw new Error("delivery scope requires UTF-8 Git paths");
  return text;
}

function paths(output) {
  return output ? output.slice(0, -1).split("\0") : [];
}

async function exists(repositoryRoot, path) {
  try {
    await lstat(resolve(repositoryRoot, path));
    return true;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

// The caller validates project-relative candidates; Git owns whether they still represent changes.
export async function captureDeliveryScope({ repositoryRoot, baseRef, candidatePaths = [] }) {
  if (typeof baseRef !== "string" || !baseRef.trim()) throw new Error("delivery scope requires a base reference");
  const normalizedCandidates = [...new Set(candidatePaths.map(path => path.replaceAll("\\", "/").replace(/^\.\//, "")))].sort();
  const baseCommit = (await git(repositoryRoot, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`])).trim();
  const headCommit = (await git(repositoryRoot, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"])).trim();
  const mergeBaseCommit = (await git(repositoryRoot, ["merge-base", baseCommit, headCommit])).trim();
  const diffOptions = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=none", "--name-only", "-z"];
  const committedPaths = paths(await git(repositoryRoot, [...diffOptions, mergeBaseCommit, headCommit, "--"]));
  const changedPaths = new Set(committedPaths);

  if (normalizedCandidates.length) {
    const trackedChanges = new Set(paths(await git(repositoryRoot, [...diffOptions, mergeBaseCommit, "--", ...normalizedCandidates])));
    const basePaths = new Set(paths(await git(repositoryRoot, ["ls-tree", "-r", "--name-only", "-z", mergeBaseCommit, "--", ...normalizedCandidates])));
    const untrackedPaths = new Set(paths(await git(repositoryRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...normalizedCandidates])));

    for (const path of normalizedCandidates) {
      // An indexed addition removed from disk can still appear in diff-index's output.
      // It is not a net change when neither the base tree nor the working tree contains it.
      if (untrackedPaths.has(path) || (trackedChanges.has(path) && (basePaths.has(path) || await exists(repositoryRoot, path)))) {
        changedPaths.add(path);
      }
    }
  }

  return {
    baseRef,
    baseCommit,
    mergeBaseCommit,
    headCommit,
    candidatePaths: normalizedCandidates,
    changedPaths: [...changedPaths].sort(),
  };
}
