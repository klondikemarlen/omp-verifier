import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { changedEntries, deliveryGit, gitFields, workingFileRanges } from "#root/omp-plugin/delivery-git.js";

const MAX_SCOPE_PATHS = 2_000;
const MAX_PATH_ARGUMENT_BYTES = 96_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SCOPE_BYTES = 512 * 1024 * 1024;
const MAX_SCOPE_RANGES = 100_000;
const FILE_CONCURRENCY = 8;

function normalizePaths(paths, name) {
  if (!Array.isArray(paths) || paths.length > MAX_SCOPE_PATHS) {
    throw new Error(`delivery ${name} must be an array of at most ${MAX_SCOPE_PATHS} paths`);
  }
  const normalized = paths.map(value => {
    if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
      throw new Error(`delivery ${name} requires non-empty project-relative file paths`);
    }
    const path = value.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
    if (/^[a-z]:/i.test(path) || path.split("/").some(part => !part || part === "." || part === "..")) {
      throw new Error(`delivery ${name} requires project-relative file paths without traversal: ${value}`);
    }
    return path;
  });
  return [...new Set(normalized)].sort();
}

function checkScopeSize(paths) {
  if (paths.length > MAX_SCOPE_PATHS
    || paths.reduce((bytes, path) => bytes + Buffer.byteLength(path) + 1, 0) > MAX_PATH_ARGUMENT_BYTES) {
    throw new Error("delivery scope exceeds its changed-path limits");
  }
}

function gitEntry(mode, object) {
  if (mode === "000000") {
    return undefined;
  }
  return {
    mode,
    object,
  };
}

function isRegular(entry) {
  return entry?.mode === "100644" || entry?.mode === "100755";
}

function sameSource(left, right) {
  if (!left || !right) {
    return left === right;
  }
  if (isRegular(left) && isRegular(right)) {
    return left.object === right.object;
  }
  return left.mode === right.mode && (left.mode === "160000" || left.object === right.object);
}

async function baseEntries(repositoryRoot, mergeBaseCommit, paths) {
  const entries = new Map();
  if (!paths.length) {
    return entries;
  }
  const output = await deliveryGit(repositoryRoot, ["ls-tree", "-z", mergeBaseCommit, "--", ...paths]);
  for (const field of gitFields(output)) {
    const match = /^(\d{6}) \w+ ([\da-f]+)\t([\s\S]+)$/.exec(field);
    if (!match) {
      throw new Error("delivery scope cannot read Git base tree metadata");
    }
    const [, mode, object, path] = match;
    if (mode === "040000") {
      throw new Error(`delivery scope requires an exact file, not a directory: ${path}`);
    }
    entries.set(path, gitEntry(mode, object));
  }
  return entries;
}

function fileHash(algorithm, size) {
  return createHash(algorithm).update(`blob ${size}\0`);
}

async function workspaceEntry(repositoryRoot, path, { algorithm, gitlink, candidate, reserveBytes }) {
  const target = resolve(repositoryRoot, path);
  const parent = dirname(target);
  try {
    if (await realpath(parent) !== parent) {
      throw new Error(`delivery scope cannot follow a symbolic parent directory for ${path}`);
    }
    const stats = await lstat(target, {
      bigint: true,
    });
    if (stats.isDirectory() && candidate && !gitlink) {
      throw new Error(`delivery scope requires an exact file, not a directory: ${path}`);
    }
    if (stats.isDirectory()) {
      if (!gitlink) {
        return undefined;
      }
      return {
        mode: "160000",
      };
    }
    if (stats.isSymbolicLink()) {
      const link = await readlink(target, {
        encoding: "buffer",
      });
      const object = fileHash(algorithm, link.length).update(link).digest("hex");
      return gitEntry("120000", object);
    }
    if (!stats.isFile() || stats.size > BigInt(MAX_FILE_BYTES)) {
      throw new Error(`delivery scope cannot read non-regular or oversized source: ${path}`);
    }
    reserveBytes(Number(stats.size));
    const hash = fileHash(algorithm, stats.size);
    let binary = false;
    for await (const chunk of createReadStream(target)) {
      hash.update(chunk);
      binary ||= chunk.includes(0);
    }
    await requireUnchangedFile(target, stats);
    const mode = (stats.mode & 0o100n) !== 0n ? "100755" : "100644";
    return {
      mode,
      object: hash.digest("hex"),
      binary,
      target,
      stats,
    };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
}

async function requireUnchangedFile(target, previous) {
  const current = await lstat(target, {
    bigint: true,
  });
  if (previous.ino !== current.ino || previous.dev !== current.dev || previous.ctimeNs !== current.ctimeNs) {
    throw new Error(`working source changed while capturing delivery scope: ${target}`);
  }
}

async function mapPaths(paths, capture) {
  const values = new Map();
  let next = 0;
  let failed = false;
  async function worker() {
    while (!failed && next < paths.length) {
      const path = paths[next++];
      try {
        values.set(path, await capture(path));
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }
  await Promise.all(Array.from({
    length: Math.min(FILE_CONCURRENCY, paths.length),
  }, worker));
  return values;
}

function committedScope(entries) {
  const base = new Map();
  const head = new Map();
  const renames = new Map();
  for (const entry of entries) {
    base.set(entry.oldPath, gitEntry(entry.oldMode, entry.oldObject));
    head.set(entry.path, gitEntry(entry.newMode, entry.newObject));
    if (entry.status === "R") {
      head.set(entry.oldPath, undefined);
      renames.set(entry.path, entry.oldPath);
    }
  }
  return {
    base,
    head,
    renames,
  };
}

async function candidateScope(repositoryRoot, mergeBaseCommit, paths, base, committed, worktree) {
  const trackedPaths = new Set();
  const renamed = new Map(committed.renames);
  const modeChanges = new Set();
  let trustFileMode = false;
  if (paths.length) {
    const mode = await deliveryGit(repositoryRoot, ["config", "--bool", "--default=true", "--get", "core.filemode"]);
    trustFileMode = mode.trim() === "true";
    const known = await deliveryGit(repositoryRoot, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...paths]);
    for (const path of gitFields(known)) {
      trackedPaths.add(path);
    }
    const changes = await changedEntries(repositoryRoot, ["--cached", mergeBaseCommit], paths);
    for (const entry of changes) {
      if (entry.oldMode === "160000") {
        modeChanges.add(entry.path);
      }
      if (entry.status === "R" && !worktree.get(entry.oldPath)) {
        renamed.set(entry.path, entry.oldPath);
      }
    }
  }
  return {
    base,
    trackedPaths,
    modeChanges,
    trustFileMode,
    renamed,
  };
}

function recoverExactUntrackedRenames({ paths, changed, base, worktree, renamed }) {
  const removed = new Map();
  const renameSources = presentRenameSources(renamed, worktree);
  for (const path of changed) {
    const entry = base.get(path);
    if (!worktree.get(path) && isRegular(entry) && !renameSources.has(path)) {
      const sources = removed.get(entry.object) ?? [];
      sources.push(path);
      removed.set(entry.object, sources);
    }
  }
  for (const path of paths) {
    const entry = worktree.get(path);
    if (!changed.has(path) || base.get(path) || renamed.has(path) || !isRegular(entry)) {
      continue;
    }
    const source = removed.get(entry.object)?.shift();
    if (source) {
      renamed.set(path, source);
    }
  }
}

function presentRenameSources(renamed, worktree) {
  const sources = new Set();
  for (const [destination, source] of renamed) {
    if (worktree.get(destination)) {
      sources.add(source);
    }
  }
  return sources;
}

async function capturePresentRanges(repositoryRoot, workspace, baseline, reserveBytes) {
  if (!isRegular(workspace) || workspace.binary || sameSource(workspace, baseline)) {
    return [];
  }
  const oldObject = isRegular(baseline) ? baseline.object : undefined;
  const ranges = await workingFileRanges(repositoryRoot, workspace.target, oldObject, reserveBytes);
  await requireUnchangedFile(workspace.target, workspace.stats);
  return ranges;
}

function reconcileCandidateChanges(paths, candidates, worktree, changed) {
  for (const path of paths) {
    const workspace = worktree.get(path);
    const baseline = candidates.base.get(path);
    const isKnown = baseline || (workspace && (candidates.trackedPaths.has(path) || changed.has(path)));
    const modeChanged = candidates.trustFileMode && isRegular(baseline) && isRegular(workspace)
      && baseline.mode !== workspace.mode;
    if (isKnown && (!sameSource(baseline, workspace) || modeChanged || (workspace && candidates.modeChanges.has(path)))) {
      changed.add(path);
    } else {
      changed.delete(path);
    }
  }
}

function presentBaseline(path, base, renamed) {
  return base.get(renamed.get(path) ?? path);
}

function dirtyOverlay(path) {
  return new Error(`working source differs from committed delivery at ${path}; commit or restore it before PR review, or explicitly include the path in a direct manual audit`);
}

function checkOverlays(head, worktree, selected) {
  for (const [path, entry] of head) {
    if (!selected.has(path) && !sameSource(entry, worktree.get(path))) {
      throw dirtyOverlay(path);
    }
  }
}

function wholeFileSelection(changed, worktree, wholeFilePaths) {
  for (const path of wholeFilePaths) {
    if (!changed.has(path) || !isRegular(worktree.get(path)) || worktree.get(path).binary) {
      throw new Error(`whole-file cleanup must target a changed delivery path with present text: ${path}`);
    }
  }
}

async function capturePaths({ repositoryRoot, mergeBaseCommit, headCommit, candidatePaths: paths, wholeFilePaths }) {
  checkScopeSize(paths);
  const entries = await changedEntries(repositoryRoot, [mergeBaseCommit, headCommit]);
  const committed = committedScope(entries);
  const allPaths = [...new Set([...committed.head.keys(), ...paths])].sort();
  checkScopeSize(allPaths);
  const algorithm = headCommit.length === 64 ? "sha256" : "sha1";
  const candidateBase = await baseEntries(repositoryRoot, mergeBaseCommit, paths);
  const base = new Map([...committed.base, ...candidateBase]);
  const selected = new Set(paths);
  let sourceBytes = 0;
  function reserveBytes(bytes) {
    sourceBytes += bytes;
    if (sourceBytes > MAX_SCOPE_BYTES) {
      throw new Error("delivery scope exceeds its source byte limits");
    }
  }

  const worktree = await mapPaths(allPaths, path => workspaceEntry(repositoryRoot, path, {
    algorithm,
    gitlink: committed.head.get(path)?.mode === "160000" || base.get(path)?.mode === "160000",
    candidate: selected.has(path),
    reserveBytes,
  }));

  const candidates = await candidateScope(repositoryRoot, mergeBaseCommit, paths, candidateBase, committed, worktree);
  const changed = new Set(committed.head.keys());
  checkOverlays(committed.head, worktree, selected);
  reconcileCandidateChanges(paths, candidates, worktree, changed);
  wholeFileSelection(changed, worktree, wholeFilePaths);
  recoverExactUntrackedRenames({
    paths,
    changed,
    base,
    worktree,
    renamed: candidates.renamed,
  });
  const changedPaths = [...changed].sort();
  const renameSources = presentRenameSources(candidates.renamed, worktree);
  const deletedPaths = changedPaths.filter(path => !worktree.get(path) && isRegular(base.get(path)) && !renameSources.has(path));
  let rangeCount = 0;
  const ranges = await mapPaths(changedPaths, async path => {
    const workspace = worktree.get(path);
    const baseline = presentBaseline(path, base, candidates.renamed);
    const pathRanges = await capturePresentRanges(repositoryRoot, workspace, baseline, reserveBytes);
    rangeCount += pathRanges.length;
    if (rangeCount > MAX_SCOPE_RANGES) {
      throw new Error("delivery scope exceeds its Git hunk coordinate limits");
    }
    return pathRanges;
  });
  const lineRanges = Object.fromEntries(changedPaths.filter(path => worktree.get(path)).map(path => [path, ranges.get(path)]));
  const renames = changedPaths.filter(path => worktree.get(path) && changed.has(candidates.renamed.get(path)))
    .map(to => ({ from: candidates.renamed.get(to), to }));
  return {
    changedPaths,
    deletedPaths,
    ...(renames.length ? { renames } : {}),
    lineRanges,
  };
}

export async function captureDeliveryScope({ repositoryRoot, baseRef, candidatePaths = [], wholeFilePaths = [] }) {
  if (typeof baseRef !== "string" || !baseRef.trim()) {
    throw new Error("delivery scope requires a base reference");
  }
  const normalizedCandidates = normalizePaths(candidatePaths, "candidates");
  const normalizedWholeFiles = normalizePaths(wholeFilePaths, "whole-file selectors");
  const root = await realpath(repositoryRoot);
  const baseCommit = (await deliveryGit(root, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`])).trim();
  const headCommit = (await deliveryGit(root, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"])).trim();
  const mergeBaseCommit = (await deliveryGit(root, ["merge-base", baseCommit, headCommit])).trim();
  const paths = await capturePaths({
    repositoryRoot: root,
    mergeBaseCommit,
    headCommit,
    candidatePaths: normalizedCandidates,
    wholeFilePaths: normalizedWholeFiles,
  });
  return {
    baseRef,
    baseCommit,
    mergeBaseCommit,
    headCommit,
    candidatePaths: normalizedCandidates,
    wholeFilePaths: normalizedWholeFiles,
    ...paths,
  };
}
