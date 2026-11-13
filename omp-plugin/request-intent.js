import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const INTENT_DIRECTORY = resolve(tmpdir(), `omp-verifier-requests-${process.getuid?.() ?? "user"}`);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const LEVELS = new Map([["quick tweak", "quick-tweak"], ["normal", "normal"], ["rearchitecture", "rearchitecture"]]);
const PREFIX = "Verifier work level: ";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseIntent(prompt) {
  const lines = prompt.split("\n");
  const declarations = lines.filter(line => line.startsWith("Verifier work level:"));
  if (declarations.length > 1) {
    return { level: "normal", diagnostic: "Multiple work-level declarations are ambiguous; using normal with no exemption." };
  }
  const firstLine = lines[0].replace(/\r$/, "");
  if (!firstLine.startsWith("Verifier work level:")) return { level: "normal" };
  const level = firstLine.startsWith(PREFIX) ? LEVELS.get(firstLine.slice(PREFIX.length)) : undefined;
  return level ? { level } : { level: "normal", diagnostic: "Unknown explicit work-level declaration; using normal with no exemption." };
}

async function privateEntry(path, directory) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) ||
      (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()) ||
      (!directory && (info.nlink !== 1 || info.size > 4_096)) || await realpath(path) !== resolve(path)) {
    throw new Error("request intent path is not privately owned and canonical");
  }
}

async function ensureDirectory(path) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await privateEntry(path, true);
}

function descriptor(record, path) {
  return { handle: `${hash(record.sessionId).slice(0, 32)}.${record.requestId}`, path, level: record.level, requestId: record.requestId, ...(record.diagnostic ? { diagnostic: record.diagnostic } : {}) };
}

// Only an actual host prompt creates an instance. Identical text is still a new request.
export async function createRequestIntent({ sessionId, prompt }) {
  if (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 512) {
    throw new Error("request intent requires a session identity");
  }
  if (typeof prompt !== "string") throw new Error("request intent requires the actual prompt");
  await ensureDirectory(INTENT_DIRECTORY);
  const directory = join(INTENT_DIRECTORY, hash(sessionId).slice(0, 32));
  await ensureDirectory(directory);
  const requestId = randomUUID();
  const record = { version: 1, sessionId, requestId, promptHash: hash(prompt), ...parseIntent(prompt) };
  const text = JSON.stringify(record);
  const path = join(directory, `${requestId}.json`);
  await writeFile(path, text, { mode: 0o400, flag: "wx" });
  const currentPath = join(directory, "current.json");
  let previous;
  try {
    await privateEntry(currentPath, false);
    previous = JSON.parse(await readFile(currentPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporaryPath = join(directory, `${requestId}.current`);
  await writeFile(temporaryPath, JSON.stringify({ requestId, sha256: hash(text) }), { mode: 0o600, flag: "wx" });
  await rename(temporaryPath, currentPath);
  if (previous && UUID_PATTERN.test(previous.requestId)) {
    await rm(join(directory, `${previous.requestId}.json`), { force: true });
  }
  return descriptor(record, path);
}

export async function readRequestIntent(handle) {
  const match = typeof handle === "string" && /^([0-9a-f]{32})\.([0-9a-f-]{36})$/.exec(handle);
  if (!match || !UUID_PATTERN.test(match[2])) throw new Error("invalid request intent handle");
  const path = join(INTENT_DIRECTORY, match[1], `${match[2]}.json`);
  await privateEntry(INTENT_DIRECTORY, true);
  await privateEntry(dirname(path), true);
  await privateEntry(path, false);
  const currentPath = join(dirname(path), "current.json");
  await privateEntry(currentPath, false);
  const text = await readFile(path, "utf8");
  const record = JSON.parse(text);
  const current = JSON.parse(await readFile(currentPath, "utf8"));
  if (record.version !== 1 || !UUID_PATTERN.test(record.requestId) ||
      typeof record.sessionId !== "string" || !record.sessionId.trim() || record.sessionId.length > 512 ||
      !HASH_PATTERN.test(record.promptHash) || ![...LEVELS.values()].includes(record.level) ||
      (record.diagnostic !== undefined && typeof record.diagnostic !== "string") ||
      hash(record.sessionId).slice(0, 32) !== basename(dirname(path)) || basename(path) !== `${record.requestId}.json` ||
      current.requestId !== record.requestId || current.sha256 !== hash(text)) {
    throw new Error("request intent is changed, invalid, or superseded");
  }
  return descriptor(record, path);
}
