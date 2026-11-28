import { isUtf8 } from "node:buffer";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { readSourceRange } from "#root/omp-plugin/source-range.js";

const execFileAsync = promisify(execFile);
export const MAX_FILE_EVIDENCE_BYTES = 16_000;
export const MAX_INVENTORY_FILE_BYTES = 256_000;
export const ROOT_REVIEW_CONFIG = ".omp-verifier.json";

async function gitSource(root, reference, maxSourceBytes, env) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "show", "--no-ext-diff", "--no-textconv", reference], {
      env,
      encoding: "buffer",
      maxBuffer: maxSourceBytes,
      timeout: 5_000,
    });
    if (stdout.byteLength > maxSourceBytes) return { oversized: true };
    if (stdout.includes(0)) return undefined;

    return { content: stdout.toString("utf8"), reference };
  } catch (error) {
    if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return { oversized: true };
    return undefined;
  }
}

async function deletedProjectSource(root, path, maxSourceBytes, { identifyOversized = true, delivery } = {}) {
  if (delivery) {
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
    const env = {
      ...inherited,
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
    };
    return gitSource(root, `${delivery.mergeBaseCommit}:${path}`, maxSourceBytes, env);
  }
  for (const reference of [`:${path}`, `HEAD:${path}`]) {
    const source = await gitSource(root, reference, maxSourceBytes);
    if (source === undefined) continue;
    if (source.oversized && !identifyOversized) continue;
    return source;
  }

  try {
    const { stdout } = await execFileAsync("git", [
      "-C", root, "log", "--first-parent", "--diff-merges=first-parent",
      "--format=%H", "--no-patch", "--no-renames", "--diff-filter=D", "-1", "HEAD", "--", `:(literal)${path}`,
    ], { maxBuffer: 128, timeout: 5_000 });
    const deletionCommit = stdout.trim();
    if (!/^[a-f0-9]{40,64}$/.test(deletionCommit)) return undefined;

    const source = await gitSource(root, `${deletionCommit}^:${path}`, maxSourceBytes);
    return source?.oversized && !identifyOversized ? undefined : source;
  } catch {
    // Absent history, including shallow boundaries, cannot authenticate prior source.
    return undefined;
  }
}

function normalizedProjectPath(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty project-relative path`);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    throw new Error(`${name} is external evidence, not a project file; use review --external-context with a commit-pinned raw GitHub or local Git URL. Project-path capture never fetches URLs.`);
  }
  const path = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!path || path === "." || isAbsolute(path) || path.startsWith("//") || /^[a-zA-Z]:/.test(path) || path.split("/").includes("..")) {
    throw new Error(`${name} must stay inside the project`);
  }
  return path;
}

function insideRoot(root, filePath) {
  const pathFromRoot = relative(root, filePath);
  return !pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readDeliveryProjectText(root, path, maxBytes, range, maxRangeBytes) {
  return readProjectText(root, path, maxBytes, range, maxRangeBytes, true);
}

async function readProjectText(root, path, maxBytes = MAX_FILE_EVIDENCE_BYTES, range, maxRangeBytes = MAX_INVENTORY_FILE_BYTES, exactPath = false) {
  const absolutePath = resolve(root, path);
  if (!insideRoot(root, absolutePath)) return { error: "path resolves outside the project" };
  let fileRealPath;
  try {
    fileRealPath = await realpath(absolutePath);
  } catch (error) {
    if (error.code === "ENOENT" || (exactPath && error.code === "ENOTDIR")) return { missing: true };
    return { error: error.message };
  }
  if (!insideRoot(root, fileRealPath)) return { error: "path resolves outside the project" };
  if (exactPath && fileRealPath !== absolutePath) {
    return { error: "delivery evidence cannot follow a symbolic file or directory; select the target explicitly if authorized" };
  }

  let fileStat;
  try {
    fileStat = await stat(fileRealPath);
  } catch (error) {
    return { error: error.message };
  }
  if (!fileStat.isFile()) return { error: "path is not a regular file" };

  if (range) return readSourceRange(fileRealPath, range, maxRangeBytes);
  if (fileStat.size > maxBytes) {
    return {
      error: `file exceeds the ${maxBytes}-byte context limit`,
      sizeLimitExceeded: true,
      ...(fileStat.size <= MAX_INVENTORY_FILE_BYTES ? { rangeRecovery: true } : {}),
    };
  }

  let contents;
  try {
    contents = await readFile(fileRealPath);
  } catch (error) {
    return { error: error.message };
  }
  if (contents.includes(0)) return { error: "file is not text" };

  return {
    content: contents.toString("utf8"),
    sha256: sha256(contents),
    size: contents.byteLength,
    referenceSelectionEligible: fileRealPath === absolutePath
      && contents.byteLength <= maxBytes
      && (path !== ROOT_REVIEW_CONFIG || isUtf8(contents)),
  };
}

export { deletedProjectSource, insideRoot, normalizedProjectPath, readDeliveryProjectText, readProjectText };
