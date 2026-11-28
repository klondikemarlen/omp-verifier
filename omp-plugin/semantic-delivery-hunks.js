import { isUtf8 } from "node:buffer";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { deliveryGit, gitFields } from "#root/omp-plugin/delivery-git.js";
import { normalizedProjectPath } from "#root/omp-plugin/semantic-project-source.js";

const execFileAsync = promisify(execFile);
const MAX_BLOB_SCAN_BYTES = 8_000_000;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export async function readDeliveryHunks(root, path, delivery, maxBytes) {
  const { comparisonCommit, headCommit, deletedPaths, lineRanges, removedLineRanges } = delivery;
  if (!GIT_OBJECT_ID.test(comparisonCommit) || !GIT_OBJECT_ID.test(headCommit)) {
    throw new Error("changed hunks require pinned comparison and head revisions");
  }
  const deleted = deletedPaths.includes(path);
  const sourcePath = delivery.renames?.find(rename => rename.to === path)?.from ?? path;
  if (normalizedProjectPath(sourcePath, "rename source") !== sourcePath
    || sourcePath.split("/").some(part => !part || part === ".") || sourcePath.includes("\0")) {
    throw new Error("unsupported Git rename source path");
  }
  const beforeRanges = scopedRanges(removedLineRanges, path);
  const afterRanges = scopedRanges(lineRanges, path);
  const beforeObject = await treeBlob(root, comparisonCommit, sourcePath);
  const afterObject = await treeBlob(root, headCommit, path);
  if (deleted !== !afterObject || ((!afterObject || sourcePath !== path) && !beforeObject)
    || (beforeRanges.length && !beforeObject) || (afterRanges.length && !afterObject)
    || (afterObject && !Object.hasOwn(lineRanges, path))) {
    throw new Error("changed hunk metadata does not match the committed source paths");
  }
  if (beforeObject === afterObject && (beforeRanges.length || afterRanges.length)) {
    throw new Error("changed hunk metadata names ranges in identical source");
  }

  const after = afterObject ? await textBlob(root, afterObject) : null;
  const before = beforeObject === afterObject ? after : beforeObject ? await textBlob(root, beforeObject) : null;
  if (!beforeRanges.length && !afterRanges.length && beforeObject !== afterObject
    && ((before?.length ?? 0) > 0 || (after?.length ?? 0) > 0)) {
    throw new Error("changed source has no supported text hunk coordinates");
  }

  const afterSource = {
    path,
    state: "present",
    reference: `${headCommit}:${path}`,
  };
  const beforeSource = {
    path,
    state: "deleted",
    reference: `${comparisonCommit}:${sourcePath}`,
  };
  const budget = { remainingBytes: maxBytes, maxBytes };
  const records = [
    ...excerptRecords(after, afterRanges, afterSource, budget),
    ...excerptRecords(before, beforeRanges, beforeSource, budget),
  ];
  if (!records.length) {
    return [{ path, state: "no-text-hunks", source: "changed-code" }];
  }
  return records;
}

function scopedRanges(ranges, path) {
  if (!ranges || typeof ranges !== "object" || Array.isArray(ranges)) {
    throw new Error("changed hunk range metadata is unavailable");
  }
  if (!Object.hasOwn(ranges, path)) return [];

  const selected = ranges[path];
  if (!Array.isArray(selected)) throw new Error("invalid changed hunk ranges");

  let last = 0;
  for (const range of selected) {
    if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isSafeInteger)
      || range[0] <= last || range[1] < range[0]) {
      throw new Error("invalid changed hunk range coordinates");
    }
    last = range[1];
  }
  return selected;
}

async function treeBlob(root, revision, path) {
  const entries = gitFields(await deliveryGit(root, ["ls-tree", "-z", revision, "--", path]));
  if (!entries.length) return null;

  const match = /^100(?:644|755) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(entries[0]);
  if (entries.length !== 1 || !match || !GIT_OBJECT_ID.test(match[1]) || match[2] !== path) {
    throw new Error(`changed hunk source is not a supported regular Git blob: ${path}`);
  }
  return match[1];
}

async function textBlob(root, object) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  let stdout;
  try {
    ({ stdout } = await execFileAsync("git", ["cat-file", "blob", object], {
      cwd: root,
      env: { ...inherited, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" },
      encoding: "buffer",
      maxBuffer: MAX_BLOB_SCAN_BYTES,
      timeout: 5_000,
    }));
  } catch (error) {
    if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new Error(`committed source exceeds the ${MAX_BLOB_SCAN_BYTES}-byte hunk scan limit`, { cause: error });
    }
    throw new Error("required committed source blob is unavailable", { cause: error });
  }
  if (stdout.includes(0) || !isUtf8(stdout)) {
    throw new Error("changed hunk source is binary or is not UTF-8 text");
  }
  return stdout;
}

function excerptRecords(blob, ranges, identity, budget) {
  let line = 1;
  let offset = 0;
  const records = [];
  for (const [startLine, endLine] of ranges) {
    while (line < startLine) {
      const newline = blob.indexOf(10, offset);
      if (newline === -1) throw new Error("changed hunk coordinates are outside the committed source");
      offset = newline + 1;
      line += 1;
    }
    const start = offset;
    let crlfCount = 0;
    while (line <= endLine) {
      if (offset >= blob.length) throw new Error("changed hunk coordinates are outside the committed source");

      const newline = blob.indexOf(10, offset);
      const end = newline === -1 ? blob.length : newline;
      offset = newline === -1 ? blob.length : newline + 1;
      const crlf = newline !== -1 && blob[end - 1] === 13;
      if (crlf) crlfCount += 1;
      if (line === endLine) {
        budget.remainingBytes -= end - start - crlfCount;
        if (budget.remainingBytes < 0) {
          throw new Error(`changed hunks exceed the ${budget.maxBytes}-byte changed-source evidence limit`);
        }
        const contentEnd = crlf ? end - 1 : end;
        const content = blob.toString("utf8", start, contentEnd).replaceAll("\r\n", "\n");
        records.push({
          ...identity,
          source: "changed-code",
          partial: true,
          startLine,
          endLine,
          content,
        });
      }
      line += 1;
    }
  }
  return records;
}

export default readDeliveryHunks;
