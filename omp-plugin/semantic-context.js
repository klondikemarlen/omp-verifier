import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, opendir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { pinnedExternalSource, readExternalText } from "#root/omp-plugin/external-context.js";

const execFileAsync = promisify(execFile);
const MAX_INVENTORY_FILES = 1_200;
const MAX_INVENTORY_READ_BYTES = 8_000_000;
const MAX_FILE_EVIDENCE_BYTES = 16_000;
const MAX_INVENTORY_FILE_BYTES = 256_000;
const MAX_TOTAL_EVIDENCE_BYTES = 256_000;
const MAX_EVIDENCE_FILES = 40;
const MAX_LARGE_SCOPE_EVIDENCE_BYTES = 1_024_000;
const MAX_LARGE_SCOPE_EVIDENCE_FILES = 256;
const DEFAULT_MAX_SOURCE_BYTES = MAX_FILE_EVIDENCE_BYTES;
const MAX_SOURCE_BYTES = MAX_INVENTORY_FILE_BYTES;
const MAX_CONTEXT_PATHS = 30;
const CODE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".go", ".h", ".java", ".js", ".jsx", ".mjs", ".cjs", ".kt", ".mts", ".php",
  ".py", ".rb", ".rs", ".ts", ".tsx", ".vue", ".svelte",
]);
const SKIPPED_DIRECTORIES = new Set([
  ".git", "node_modules", "vendor", "dist", "build", "coverage", "target", ".next", ".cache", ".turbo",
]);
const PROJECT_GUIDANCE_NAMES = new Set([
  ".omp-verifier.json", "AGENTS.md", "CLAUDE.md", "WATCHDOG.md", "WATCHDOG.yml", "WATCHDOG.yaml", "CONTRIBUTING.md",
  "README.md", "copilot-instructions.md",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function validateSourceByteLimit(value = DEFAULT_MAX_SOURCE_BYTES) {
  if (!Number.isSafeInteger(value) || value < DEFAULT_MAX_SOURCE_BYTES || value > MAX_SOURCE_BYTES) {
    throw new RangeError(`maxSourceBytes must be a safe integer from ${DEFAULT_MAX_SOURCE_BYTES} through ${MAX_SOURCE_BYTES}`);
  }
  return value;
}

function validateSourceRecovery(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("sourceRecovery must be an object");
  }
  for (const [name, maximum] of [["chunkBytes", MAX_FILE_EVIDENCE_BYTES], ["maxSourceBytes", MAX_SOURCE_BYTES]]) {
    if (!Number.isSafeInteger(value[name]) || value[name] <= 0 || value[name] > maximum) {
      throw new RangeError(`sourceRecovery.${name} must be a positive safe integer no greater than ${maximum}`);
    }
  }
  return { chunkBytes: value.chunkBytes, maxSourceBytes: value.maxSourceBytes, modelContext: value.modelContext };
}

function sourceChunks(path, content, source, recovery, identity = {}) {
  if (Buffer.byteLength(content) > recovery.maxSourceBytes) {
    return { error: `source exceeds the ${recovery.maxSourceBytes}-byte automatic recovery whole-source limit` };
  }
  // Keep CRLF bytes intact so complete cached chunks can authenticate the original source.
  const lines = content.split("\n");
  const ranges = [];
  let startLine = 1;
  let bytes = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const lineBytes = Buffer.byteLength(lines[index]);
    if (lineBytes > recovery.chunkBytes) {
      return { error: `source line ${index + 1} exceeds the ${recovery.chunkBytes}-byte automatic recovery chunk limit` };
    }
    if (index + 1 > startLine && bytes + 1 + lineBytes > recovery.chunkBytes) {
      ranges.push([startLine, index]);
      startLine = index + 1;
      bytes = lineBytes;
    } else {
      bytes += (index + 1 > startLine ? 1 : 0) + lineBytes;
    }
  }
  ranges.push([startLine, lines.length]);
  const sourceHash = sha256(content);
  const records = ranges.map(([startLine, endLine]) => ({
    ...recordFor(path, {
      content: lines.slice(startLine - 1, endLine).join("\n"),
      sha256: sourceHash,
      lineCount: lines.length,
      startLine,
      endLine,
      partial: ranges.length > 1,
    }, source),
    ...identity,
  }));
  return { records, ranges, lineCount: lines.length };
}

function admitSourceChunks(records, chunks, budget) {
  const admittedRanges = [];
  for (let index = 0; index < chunks.records.length; index += 1) {
    if (!addRecord(records, chunks.records[index], budget)) break;
    admittedRanges.push(chunks.ranges[index]);
  }
  return { lineCount: chunks.lineCount, ...lineCoverage(admittedRanges, chunks.lineCount) };
}

function normalizedProjectPath(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty project-relative path`);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    throw new Error(`${name} is external evidence, not a project file; use review --external-context with a commit-pinned raw GitHub URL. Project-path capture never fetches URLs.`);
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

function sourceFile(path) {
  return CODE_EXTENSIONS.has(extname(path).toLowerCase()) || isGuidancePath(path);
}

function codeFile(path) {
  return CODE_EXTENSIONS.has(extname(path).toLowerCase());
}

async function gitInventory(root) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "ls-files", "-co", "--exclude-standard", "-z"], {
      encoding: "buffer",
      maxBuffer: 4_000_000,
    });
    return stdout.toString("utf8").split("\0").filter(Boolean);
  } catch {
    return undefined;
  }
}

async function directoryInventory(root) {
  const paths = [];
  async function visit(directory, relativeDirectory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name) && (!entry.name.startsWith(".") || entry.name === ".github" || entry.name === ".cursor")) {
          await visit(resolve(directory, entry.name), relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name);
        }
      } else if (entry.isFile()) {
        paths.push(relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name);
      }
    }
  }
  await visit(root, "");
  return paths;
}

async function inventoryPaths(root, changedPaths) {
  const trackedPaths = await gitInventory(root) ?? await directoryInventory(root);
  return [...new Set([
    ...trackedPaths.map(path => path.replaceAll("\\", "/").replace(/^\.\//, "")),
    ...changedPaths,
  ])]
    .filter(path => path && sourceFile(path))
    .sort();
}

async function renamedProjectPaths(root, revision) {
  const { stdout } = await execFileAsync("git", [
    "-C", root, "diff", "--no-ext-diff", "--no-textconv", "--find-renames",
    `-l${MAX_INVENTORY_FILES}`, "--diff-filter=R", "--name-status", "-z",
    ...(revision ? [revision] : []), "--",
  ], { maxBuffer: 4_000_000, timeout: 5_000 });
  const fields = stdout.split("\0");
  const renames = new Map();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    if (!/^R\d+$/.test(fields[index])) throw new Error("invalid Git rename inventory");
    renames.set(fields[index + 1], fields[index + 2]);
  }
  return renames;
}

async function historicalSiblingInventory(root, directory, changedPaths, deletedSources, maxSourceBytes, remainingEntries) {
  // Only genuinely absent directories may use history, not links or inaccessible paths.
  let ancestor = resolve(root, directory);
  while (true) {
    try {
      const entry = await lstat(ancestor);
      if (!entry.isDirectory() || !insideRoot(root, await realpath(ancestor))) {
        throw new Error("missing directory has an unsafe ancestor");
      }
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      ancestor = dirname(ancestor);
    }
  }

  const references = new Set();
  const boundaryPaths = changedPaths.filter(path => dirname(path) === directory);
  if (boundaryPaths.length > remainingEntries) throw new Error("sibling directory entry limit reached");
  for (const path of boundaryPaths) {
    const source = await deletedProjectSource(root, path, maxSourceBytes);
    deletedSources.set(path, source);
    if (typeof source?.content !== "string") {
      throw new Error(`historical sibling inventory cannot authenticate deleted source: ${path}`);
    }
    references.add(source.reference.slice(0, source.reference.indexOf(":")));
  }

  const files = new Set();
  const snapshots = [];
  const renames = [];
  let inspectedEntries = 0;
  for (const revision of references) {
    const args = revision
      ? ["ls-tree", "-z", `${revision}:${directory}`]
      : ["ls-files", "--stage", "-z", "--", `:(literal)${directory}/`];
    const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
      maxBuffer: 4_000_000,
      timeout: 5_000,
    });
    const entries = stdout.split("\0").filter(Boolean);
    inspectedEntries += entries.length;
    if (inspectedEntries > remainingEntries) throw new Error("sibling directory entry limit reached");
    if (!entries.length) throw new Error("historical sibling inventory is unavailable");
    snapshots.push({ revision: revision || "index", sha256: sha256(stdout) });
    const candidates = entries.map(entry => {
      const name = entry.slice(entry.indexOf("\t") + 1);
      return revision ? `${directory}/${name}` : name;
    }).filter(path => dirname(path) === directory && codeFile(path) && !changedPaths.includes(path));
    const currentPaths = candidates.length ? await renamedProjectPaths(root, revision) : new Map();
    for (const path of candidates) {
      const currentPath = currentPaths.get(path);
      files.add(currentPath ?? path);
      if (currentPath) renames.push({ from: path, to: currentPath, reference: `${revision}:${path}` });
    }
  }
  return { files: [...files], snapshots, renames, inspectedEntries };
}

async function siblingDirectoryInventory(root, changedPaths, deletedSources, maxSourceBytes) {
  const directories = [...new Set(changedPaths.map(path => dirname(path)))].sort();
  const inventories = [];
  let inspectedEntries = 0;
  for (const path of directories) {
    const inventory = { path, files: [], complete: false };
    inventories.push(inventory);
    try {
      const directory = await realpath(resolve(root, path));
      if (!insideRoot(root, directory)) throw new Error("directory resolves outside the project");
      if (inspectedEntries >= MAX_INVENTORY_FILES) throw new Error("sibling directory entry limit reached");

      const entries = await opendir(directory);
      let truncated = false;
      for await (const entry of entries) {
        if (inspectedEntries >= MAX_INVENTORY_FILES) {
          truncated = true;
          break;
        }
        inspectedEntries += 1;
        const filePath = path === "." ? entry.name : `${path}/${entry.name}`;
        if (codeFile(filePath) && !changedPaths.includes(filePath)
          && (entry.isFile() || entry.isSymbolicLink())) {
          inventory.files.push(filePath);
        }
      }
      inventory.complete = !truncated;
      if (truncated) inventory.reason = "sibling directory entry limit reached";
    } catch (error) {
      if (error.code === "ENOENT") {
        try {
          const historical = await historicalSiblingInventory(
            root, path, changedPaths, deletedSources, maxSourceBytes, MAX_INVENTORY_FILES - inspectedEntries,
          );
          inventory.files = historical.files;
          inventory.snapshots = historical.snapshots;
          if (historical.renames.length) inventory.renames = historical.renames;
          inventory.complete = true;
          inspectedEntries += historical.inspectedEntries;
        } catch (historicalError) {
          inventory.reason = historicalError.message;
        }
      } else {
        inventory.reason = error.message;
      }
    }
    inventory.files.sort();
  }
  return inventories;
}

function relevantGuidance(path, changedPaths) {
  if (!isGuidancePath(path)) return false;
  return changedPaths.some(changedPath => {
    const guidanceDirectory = dirname(path);
    return guidanceDirectory === "."
      || dirname(changedPath) === guidanceDirectory
      || changedPath.startsWith(`${guidanceDirectory}/`);
  });
}

function prioritizedInventory(paths, changedPaths, contextPaths) {
  const priority = path => {
    if (changedPaths.includes(path) || contextPaths.includes(path)) return 0;
    if (relevantGuidance(path, changedPaths)) return 1;
    if (codeFile(path) && changedPaths.some(changedPath => dirname(path) === dirname(changedPath))) return 2;
    return 3;
  };
  return [...paths].sort((left, right) => priority(left) - priority(right) || left.localeCompare(right));
}

function contextRange(value) {
  const match = /^(.*)#L([1-9]\d*)(?:-L?([1-9]\d*))?$/.exec(value);
  if (!match) return { path: value };
  const startLine = Number(match[2]);
  const endLine = Number(match[3] ?? match[2]);
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || endLine < startLine || endLine - startLine >= 500) {
    throw new Error("context line ranges must be ordered and contain at most 500 lines");
  }
  return { path: match[1], startLine, endLine };
}

async function readProjectText(root, path, maxBytes = MAX_FILE_EVIDENCE_BYTES, range) {
  const absolutePath = resolve(root, path);
  if (!insideRoot(root, absolutePath)) return { error: "path resolves outside the project" };
  let fileRealPath;
  try {
    fileRealPath = await realpath(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") return { missing: true };
    return { error: error.message };
  }
  if (!insideRoot(root, fileRealPath)) return { error: "path resolves outside the project" };

  let fileStat;
  try {
    fileStat = await stat(fileRealPath);
  } catch (error) {
    return { error: error.message };
  }
  if (!fileStat.isFile()) return { error: "path is not a regular file" };

  const sourceLimit = range ? MAX_INVENTORY_FILE_BYTES : maxBytes;
  if (fileStat.size > sourceLimit) {
    return {
      error: `file exceeds the ${sourceLimit}-byte context limit`,
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

  const fullContent = contents.toString("utf8");
  const identity = { sha256: sha256(contents), size: contents.byteLength };
  if (!range) return { content: fullContent, ...identity };

  const allLines = fullContent.split(/\r?\n/);
  const startLine = range.startLine;
  const endLine = range.endLine ?? Math.min(allLines.length, startLine + 119);
  if (startLine > allLines.length) return { error: `requested line ${startLine} is beyond end of file`, rangeRecovery: true };
  if (endLine > allLines.length) return { error: `requested line ${endLine} is beyond end of file`, rangeRecovery: true };

  const content = allLines.slice(startLine - 1, endLine).join("\n");
  if (Buffer.byteLength(content) > MAX_FILE_EVIDENCE_BYTES) {
    return { error: `excerpt exceeds the ${MAX_FILE_EVIDENCE_BYTES}-byte evidence limit; request a smaller line range`, rangeRecovery: true };
  }
  return {
    content,
    ...identity,
    lineCount: allLines.length,
    startLine,
    endLine,
    partial: startLine !== 1 || endLine < allLines.length,
  };
}

function recordFor(path, result, source) {
  return {
    path,
    state: "present",
    source,
    sha256: result.sha256,
    lineCount: result.lineCount ?? result.content.split(/\r?\n/).length,
    ...(result.startLine && result.startLine > 1 ? { startLine: result.startLine } : {}),
    ...(result.partial ? { partial: true, omittedRanges: [
      ...(result.startLine > 1 ? [[1, result.startLine - 1]] : []),
      ...(result.endLine < result.lineCount ? [[result.endLine + 1, result.lineCount]] : []),
    ] } : {}),
    content: result.content,
  };
}

function previousSource(previousContext, path) {
  const records = previousContext?.changedCode?.filter(record => record.path === path && typeof record.content === "string") ?? [];
  const coverage = previousContext?.changedCodeCoverage?.find(record => record.path === path);
  if (coverage) {
    if (!coverage.complete || !records.length) return undefined;
    const ordered = [...records].sort((left, right) => (left.startLine ?? 1) - (right.startLine ?? 1));
    let nextLine = 1;
    for (const record of ordered) {
      if ((record.startLine ?? 1) !== nextLine) return undefined;
      nextLine += record.content.split("\n").length;
    }
    const content = ordered.map(record => record.content).join("\n");
    const sourceHash = sha256(content);
    if (nextLine !== coverage.lineCount + 1
      || ordered.some(record => (record.previousSha256 ?? record.sha256) !== sourceHash)) return undefined;
    if (ordered.some(record => record.reference !== ordered[0].reference)) return undefined;
    return { content, ...(ordered[0].reference ? { reference: ordered[0].reference } : {}) };
  }
  if (records.length !== 1 || records[0].partial || records[0].startLine > 1) return undefined;
  return { content: records[0].content, ...(records[0].reference ? { reference: records[0].reference } : {}) };
}

function disjointLineRanges(selectors) {
  const ranges = selectors
    .map(({ startLine, endLine }) => [startLine, endLine])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const chunks = [];
  let coveredEnd = 0;
  for (const [start, end] of ranges) {
    if (end <= coveredEnd) continue;

    chunks.push([Math.max(start, coveredEnd + 1), end]);
    coveredEnd = end;
  }
  return chunks;
}

function lineCoverage(ranges, lineCount) {
  const coveredRanges = [];
  for (const [start, end] of ranges) {
    const previous = coveredRanges[coveredRanges.length - 1];
    if (previous && start <= previous[1] + 1) {
      previous[1] = Math.max(previous[1], Math.min(end, lineCount));
    } else {
      coveredRanges.push([start, Math.min(end, lineCount)]);
    }
  }
  const omittedRanges = [];
  let nextLine = 1;
  for (const [start, end] of coveredRanges) {
    if (start > nextLine) omittedRanges.push([nextLine, start - 1]);
    nextLine = Math.max(nextLine, end + 1);
  }
  if (nextLine <= lineCount) omittedRanges.push([nextLine, lineCount]);
  return { coveredRanges, omittedRanges, complete: omittedRanges.length === 0 };
}

async function gitSource(root, reference, maxSourceBytes) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "show", "--no-ext-diff", "--no-textconv", reference], {
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

async function deletedProjectSource(root, path, maxSourceBytes, { identifyOversized = true } = {}) {
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

function isGuidancePath(path) {
  const fileName = basename(path);
  return PROJECT_GUIDANCE_NAMES.has(fileName)
    || (path.startsWith(".cursor/rules/") && fileName.endsWith(".mdc"));
}

function addRecord(records, record, budget) {
  if (records.some(existing => existing.path === record.path
    && (existing.startLine ?? 1) === (record.startLine ?? 1)
    && existing.content === record.content)) return true;

  const bytes = Buffer.byteLength(record.content);

  // Required records are admitted before optional discovery. Grow only for
  // actual required bytes, including recovered chunks and authenticated deletions.
  const required = record.source !== "callers" && record.source !== "siblings";
  if (required && budget.used + bytes > MAX_TOTAL_EVIDENCE_BYTES) {
    budget.maxFiles = MAX_LARGE_SCOPE_EVIDENCE_FILES;
    budget.maxBytes = MAX_LARGE_SCOPE_EVIDENCE_BYTES;
  }

  const exceedsFiles = !budget.paths.has(record.path) && budget.paths.size >= budget.maxFiles;
  const exceedsBytes = budget.used + bytes > budget.maxBytes;
  if (exceedsFiles || exceedsBytes) {
    const limits = [];
    if (exceedsFiles) limits.push(`${budget.maxFiles}-file evidence limit`);
    if (exceedsBytes) limits.push(`${budget.maxBytes}-byte evidence limit`);
    budget.rejections.push({
      path: record.path,
      source: record.source,
      bytes,
      reason: `${limits.join(" and ")} reached; ${budget.used} bytes across ${budget.paths.size} files already admitted`,
    });
    budget.truncated = true;
    return false;
  }
  records.push(record);
  budget.paths.add(record.path);
  budget.used += bytes;
  budget.records.push({ path: record.path, source: record.source, bytes, startLine: record.startLine ?? 1 });
  return true;
}

function contextFingerprint(context, includeMaxSourceBytes = true) {
  const fingerprint = {
    changedPaths: context.changedPaths,
    changedCode: context.changedCode,
    changedCodeCoverage: context.changedCodeCoverage,
    callers: context.callers,
    siblings: context.siblings,
    siblingInventory: context.siblingInventory,
    projectGuidance: context.projectGuidance,
    targetedContext: context.targetedContext,
    sourceInventory: context.sourceInventory,
    callerContextPaths: context.callerContextPaths,
  };
  if (context.externalContext?.length) fingerprint.externalContext = context.externalContext;
  if (includeMaxSourceBytes) fingerprint.maxSourceBytes = context.evidenceBudget.maxSourceBytes;
  if (context.sourceRecovery) fingerprint.sourceRecovery = context.sourceRecovery;
  return sha256(JSON.stringify(fingerprint));
}

export async function captureSemanticContext({
  repositoryRoot,
  changedPaths,
  contextPaths = [],
  callerContextPaths = [],
  externalContextPaths = [],
  externalSnapshot,
  previousContext,
  maxSourceBytes = DEFAULT_MAX_SOURCE_BYTES,
  sourceRecovery,
  legacyRequest = false,
}) {
  const sourceByteLimit = validateSourceByteLimit(maxSourceBytes);
  const recovery = validateSourceRecovery(sourceRecovery);
  const requiredSourceLimit = recovery?.maxSourceBytes ?? sourceByteLimit;
  const root = await realpath(repositoryRoot);
  const normalizedChangedPaths = [...new Set(changedPaths.map(path => normalizedProjectPath(path, "changed path")))].sort();
  const callerSourcePaths = new Set(callerContextPaths.map(contextRange).map(context =>
    normalizedProjectPath(context.path, "caller context path")));
  if ([...callerSourcePaths].some(path => normalizedChangedPaths.includes(path))) {
    throw new Error("caller context must identify separate caller or runtime discovery source, not the changed file itself");
  }
  const selectors = [...new Set([...contextPaths, ...callerContextPaths])].map(contextRange).map(context => ({
    ...context,
    path: normalizedProjectPath(context.path, "context path"),
  }));
  const externalSelectors = [...new Set(externalContextPaths)].map(selector => {
    const range = contextRange(selector);
    return { selector, ...range, ...pinnedExternalSource(range.path) };
  });
  if (selectors.length + externalSelectors.length > MAX_CONTEXT_PATHS) {
    throw new Error(`local and external context must not exceed ${MAX_CONTEXT_PATHS} selectors`);
  }
  const requestedContext = selectors.filter(context =>
    context.startLine || !selectors.some(other => other.path === context.path && other.startLine));
  const normalizedContextPaths = [...new Set(requestedContext.map(context => context.path))].sort();

  const deletedSources = new Map();
  const siblingInventory = await siblingDirectoryInventory(root, normalizedChangedPaths, deletedSources, requiredSourceLimit);
  const paths = [...new Set([
    ...await inventoryPaths(root, [...normalizedChangedPaths, ...normalizedContextPaths]),
    ...siblingInventory.flatMap(inventory => inventory.files),
  ])].sort();

  // Filename matches are candidate callers, not a declaration of material dependencies.
  // Explicit context promotes those boundaries and their owning guidance together.
  const boundaryPaths = [
    ...normalizedChangedPaths,
    ...normalizedContextPaths,
    ...siblingInventory.flatMap(inventory => (inventory.renames ?? []).map(rename => rename.to)),
  ];
  const guidancePaths = paths.filter(path => relevantGuidance(path, boundaryPaths));
  const inventoryWasTruncated = paths.length > MAX_INVENTORY_FILES;
  const orderedInventoryPaths = prioritizedInventory(paths, normalizedChangedPaths, normalizedContextPaths);
  const selectedInventoryPaths = orderedInventoryPaths.slice(0, MAX_INVENTORY_FILES);
  const inventoryRecords = [];
  const availableText = new Map();
  let inventoryReadBytes = 0;
  let inventoryReadTruncated = false;

  for (const path of selectedInventoryPaths) {
    const remainingInventoryBytes = Math.max(0, MAX_INVENTORY_READ_BYTES - inventoryReadBytes);
    const result = await readProjectText(root, path, Math.min(MAX_INVENTORY_FILE_BYTES, remainingInventoryBytes));
    if (result.missing) continue;
    if (result.error) {
      inventoryReadTruncated = true;
      inventoryRecords.push({ path, unreadable: result.error });
      continue;
    }
    inventoryRecords.push({ path, size: result.size, sha256: result.sha256 });
    if (inventoryReadBytes + result.size > MAX_INVENTORY_READ_BYTES) {
      inventoryReadTruncated = true;
      continue;
    }
    inventoryReadBytes += result.size;
    availableText.set(path, result.content);
  }

  const requiredEvidencePaths = new Set([...normalizedChangedPaths, ...normalizedContextPaths, ...guidancePaths, ...externalSelectors.map(source => source.url)]);
  const largeScope = requiredEvidencePaths.size > MAX_EVIDENCE_FILES;
  const budget = {
    maxFiles: largeScope ? MAX_LARGE_SCOPE_EVIDENCE_FILES : MAX_EVIDENCE_FILES,
    maxBytes: largeScope ? MAX_LARGE_SCOPE_EVIDENCE_BYTES : MAX_TOTAL_EVIDENCE_BYTES,
    used: 0,
    paths: new Set(),
    truncated: false,
    records: [],
    rejections: [],
  };
  const changedCode = [];
  const missingChangedPaths = [];
  const changedCodeCoverage = [];
  const changedSelectors = new Map();
  for (const path of normalizedChangedPaths) {
    const selectorsForRecovery = requestedContext.filter(selector => selector.path === path && selector.startLine);
    const recoverWholeSource = recovery && !selectorsForRecovery.length;
    const changedSourceLimit = recoverWholeSource ? requiredSourceLimit : sourceByteLimit;
    const result = await readProjectText(root, path, changedSourceLimit);
    if (result.missing) {
      const cachedSource = previousSource(previousContext, path);
      const priorSource = cachedSource === undefined
        ? (deletedSources.has(path) ? deletedSources.get(path) : await deletedProjectSource(root, path, changedSourceLimit, {
          identifyOversized: !legacyRequest,
        }))
        : { ...cachedSource, oversized: Buffer.byteLength(cachedSource.content) > changedSourceLimit };
      if (!priorSource) {
        changedCode.push({ path, state: "unavailable", reason: "path is absent and no prior source confirms its deletion" });
        missingChangedPaths.push(path);
        continue;
      }
      if (priorSource.oversized || Buffer.byteLength(priorSource.content ?? "") > changedSourceLimit) {
        changedCode.push({
          path,
          state: "unavailable",
          reason: `deleted source exceeds the ${changedSourceLimit}-byte ${recoverWholeSource ? "automatic recovery whole-source" : "changed-source"} limit`,
        });
        missingChangedPaths.push(path);
        continue;
      }
      if (recoverWholeSource) {
        const chunks = sourceChunks(path, priorSource.content, "changed-code", recovery, {
          state: "deleted",
          previousSha256: sha256(priorSource.content),
          ...(priorSource.reference ? { reference: priorSource.reference } : {}),
        });
        const coverage = chunks.error ? undefined : admitSourceChunks(changedCode, chunks, budget);
        if (coverage) changedCodeCoverage.push({ path, ...coverage });
        if (!coverage?.complete) {
          changedCode.push({ path, state: "unavailable", reason: chunks.error ?? budget.rejections.at(-1)?.reason ?? "context evidence limit reached" });
          missingChangedPaths.push(path);
        }
        continue;
      }
      const deletedRecord = {
        path,
        source: "changed-code",
        state: "deleted",
        content: priorSource.content,
        previousSha256: sha256(priorSource.content),
        ...(priorSource.reference ? { reference: priorSource.reference } : {}),
      };
      if (!addRecord(changedCode, deletedRecord, budget)) {
        changedCode.push({ path, state: "unavailable", reason: "context evidence limit reached" });
        missingChangedPaths.push(path);
      }
      continue;
    }
    if (recoverWholeSource && typeof result.content === "string") {
      const chunks = sourceChunks(path, result.content, "changed-code", recovery);
      const coverage = chunks.error ? undefined : admitSourceChunks(changedCode, chunks, budget);
      if (coverage) changedCodeCoverage.push({ path, ...coverage });
      if (!coverage?.complete) {
        changedCode.push({ path, state: "unavailable", reason: chunks.error ?? budget.rejections.at(-1)?.reason ?? "context evidence limit reached" });
        missingChangedPaths.push(path);
      }
      continue;
    }
    if (recoverWholeSource && result.sizeLimitExceeded) {
      changedCode.push({ path, state: "unavailable", reason: `source exceeds the ${requiredSourceLimit}-byte automatic recovery whole-source limit` });
      missingChangedPaths.push(path);
      continue;
    }
    if (result.sizeLimitExceeded) {
      const selectorsForPath = requestedContext.filter(selector => selector.path === path && selector.startLine);
      if (selectorsForPath.length) changedSelectors.set(path, true);
      if (!selectorsForPath.length) {
        changedCode.push({ path, state: "unavailable", reason: result.error, ...(result.rangeRecovery ? { rangeRecovery: true } : {}) });
        missingChangedPaths.push(path);
        continue;
      }
      const chunks = [];
      let failed = false;
      let failureReason;
      let rangeRecovery = false;
      let identity;
      for (const [startLine, endLine] of disjointLineRanges(selectorsForPath)) {
        const chunk = await readProjectText(root, path, MAX_FILE_EVIDENCE_BYTES, { startLine, endLine });
        if (chunk.error || chunk.missing) {
          failed = true;
          failureReason = chunk.error ?? "source disappeared while selected ranges were being captured";
          rangeRecovery = chunk.rangeRecovery === true;
          break;
        }
        if (identity && (identity.sha256 !== chunk.sha256 || identity.size !== chunk.size || identity.lineCount !== chunk.lineCount)) {
          failed = true;
          failureReason = "full-source identity changed between selected ranges";
          break;
        }
        identity ??= { sha256: chunk.sha256, size: chunk.size, lineCount: chunk.lineCount };
        chunks.push({ chunk, startLine, endLine });
      }
      if (failed || !identity) {
        changedCode.push({
          path,
          state: "unavailable",
          reason: failureReason ?? "selected changed source ranges could not be captured consistently",
          ...(rangeRecovery ? { rangeRecovery: true } : {}),
        });
        missingChangedPaths.push(path);
        changedCodeCoverage.push({ path, lineCount: identity?.lineCount ?? null, coveredRanges: [], omittedRanges: identity?.lineCount ? [[1, identity.lineCount]] : [], complete: false });
        continue;
      }
      const records = chunks.map(({ chunk }) => recordFor(path, {
        ...chunk,
        lineCount: identity.lineCount,
        partial: true,
      }, "changed-code"));
      const admittedRanges = [];
      let admissionFailed = false;
      for (let index = 0; index < records.length; index += 1) {
        if (!addRecord(changedCode, records[index], budget)) {
          admissionFailed = true;
          break;
        }
        admittedRanges.push([chunks[index].startLine, chunks[index].endLine]);
      }
      const coverage = lineCoverage(admittedRanges, identity.lineCount);
      changedCodeCoverage.push({ path, lineCount: identity.lineCount, ...coverage });
      if (admissionFailed || !coverage.complete) {
        changedCode.push({
          path,
          state: "unavailable",
          reason: admissionFailed ? "context evidence limit reached" : "selected ranges do not cover the complete changed source",
          ...(!admissionFailed ? { rangeRecovery: true } : {}),
        });
        missingChangedPaths.push(path);
      }
      changedSelectors.set(path, true);
      continue;
    }
    if (result.error) {
      changedCode.push({ path, state: "unavailable", reason: result.error });
      missingChangedPaths.push(path);
      continue;
    }
    const record = recordFor(path, result, "changed-code");
    if (!addRecord(changedCode, record, budget)) {
      changedCode.push({ path, state: "unavailable", reason: "context evidence limit reached" });
      missingChangedPaths.push(path);
      continue;
    }
  }

  const targetedContext = [];
  const missingContextPaths = [];
  for (const selector of requestedContext) {
    const { path } = selector;
    if (changedSelectors.has(path)) continue;
    const result = await readProjectText(root, path, MAX_FILE_EVIDENCE_BYTES, selector.startLine ? selector : undefined);
    if (result.missing || result.error) {
      targetedContext.push({ path, state: "unavailable", reason: result.error ?? "path is absent" });
      missingContextPaths.push(path);
      continue;
    }
    let source = "targeted-context";
    if (callerSourcePaths.has(path)) source = "caller-context";
    if (!addRecord(targetedContext, recordFor(path, result, source), budget)) {
      targetedContext.push({ path, state: "unavailable", reason: "context evidence limit reached" });
      missingContextPaths.push(path);
    }
  }

  const callerPaths = new Set();
  const siblingPaths = new Set();
  for (const changedPath of normalizedChangedPaths) {
    const stem = basename(changedPath).replace(/\.[^.]+$/, "");
    for (const path of selectedInventoryPaths) {
      if (normalizedChangedPaths.includes(path) || !codeFile(path)) continue;
      const content = availableText.get(path);
      if (content === undefined) continue;
      if (dirname(path) === dirname(changedPath)) siblingPaths.add(path);
      if (stem && content.includes(stem)) callerPaths.add(path);
    }
  }

  const projectGuidance = [];
  // Authenticated deletions remain changed-source evidence, never live instructions.
  const guidanceRequirements = guidancePaths
    .filter(path => !changedCode.some(record => record.path === path && record.state === "deleted"))
    .map(path => ({
      path,
      requiredBy: boundaryPaths.filter(boundary => relevantGuidance(path, [boundary])),
    }));
  const missingGuidancePaths = [];
  for (const { path } of guidanceRequirements) {
    if (targetedContext.some(record => record.path === path && record.content)) continue;
    // A complete changed guide is already admitted; partial source cannot discharge its guidance requirement.
    if (!missingChangedPaths.includes(path)
      && changedCode.some(record => record.path === path && record.state === "present")) {
      continue;
    }
    if (recovery && !requestedContext.some(selector => selector.path === path && selector.startLine)) {
      const result = await readProjectText(root, path, requiredSourceLimit);
      const chunks = typeof result.content === "string" ? sourceChunks(path, result.content, "project-guidance", recovery) : undefined;
      const coverage = chunks && !chunks.error ? admitSourceChunks(projectGuidance, chunks, budget) : undefined;
      if (!coverage?.complete) {
        guidanceRequirements.find(requirement => requirement.path === path).reason = chunks?.error
          ?? (result.sizeLimitExceeded ? `source exceeds the ${requiredSourceLimit}-byte automatic recovery whole-source limit` : result.error)
          ?? (result.missing ? "path is absent" : budget.rejections.at(-1)?.reason ?? "context evidence limit reached");
        missingGuidancePaths.push(path);
      }
      continue;
    }
    let result = await readProjectText(root, path);
    if (result.error === `file exceeds the ${MAX_FILE_EVIDENCE_BYTES}-byte context limit`) {
      result = await readProjectText(root, path, MAX_FILE_EVIDENCE_BYTES, { startLine: 1 });
    }
    if (result.missing || result.error) {
      guidanceRequirements.find(requirement => requirement.path === path).reason = result.error ?? "path is absent";
      missingGuidancePaths.push(path);
      continue;
    }
    if (!addRecord(projectGuidance, recordFor(path, result, "project-guidance"), budget)) {
      guidanceRequirements.find(requirement => requirement.path === path).reason = budget.rejections.at(-1).reason;
      missingGuidancePaths.push(path);
    }
  }

  const externalContext = [];
  for (const source of externalSelectors) {
    // Stored requests are integrity-checked before reuse. Immutable remote snapshots
    // need no network access during page reads or final local-source freshness checks.
    const snapshot = externalSnapshot?.find(record => record.selector === source.selector);
    let record = snapshot;
    if (!record) {
      const result = await readExternalText(source, source.startLine ? source : undefined);
      const identity = { path: source.url, selector: source.selector, revision: source.revision, source: "external-context" };
      record = result.error
        ? { ...identity, state: "unavailable", reason: result.error }
        : { ...recordFor(source.url, result, "external-context"), ...identity };
    }
    if (record.state === "unavailable") {
      externalContext.push(record);
    } else if (!addRecord(externalContext, record, budget)) {
      externalContext.push({ path: source.url, selector: source.selector, revision: source.revision, source: "external-context", state: "unavailable", reason: "context evidence limit reached" });
    }
  }

  const callers = [];
  const siblings = [];
  const capturedOptionalPaths = new Set([...targetedContext, ...changedCode]
    .filter(record => typeof record.content === "string").map(record => record.path));
  const attemptedOptionalPaths = new Set();

  function captureOptionalSource(path, records, source) {
    if (capturedOptionalPaths.has(path)) return true;
    if (attemptedOptionalPaths.has(path)) return false;

    attemptedOptionalPaths.add(path);

    const content = availableText.get(path);
    if (content === undefined) return false;

    const bytes = Buffer.byteLength(content);
    if (bytes > MAX_FILE_EVIDENCE_BYTES) {
      budget.rejections.push({ path, source, bytes, reason: `source exceeds the ${MAX_FILE_EVIDENCE_BYTES}-byte per-file context limit; select material ranges with review --context` });
      budget.truncated = true;
      return false;
    }

    if (!addRecord(records, recordFor(path, { content, sha256: sha256(content) }, source), budget)) return false;

    capturedOptionalPaths.add(path);
    return true;
  }

  // Reserve one representative per changed boundary before broad filename-matched callers.
  // Explicit source already admitted for that boundary satisfies the same requirement.
  for (const inventory of siblingInventory) {
    if (inventory.files.some(path => capturedOptionalPaths.has(path))) continue;

    for (const path of inventory.files) {
      if (captureOptionalSource(path, siblings, "siblings")) break;
    }
  }

  for (const path of callerPaths) captureOptionalSource(path, callers, "callers");
  for (const path of siblingPaths) captureOptionalSource(path, siblings, "siblings");

  let siblingEvidence = siblings;
  if (!siblings.length) {
    const discovered = siblingInventory.flatMap(inventory => inventory.files);
    if (discovered.some(path => capturedOptionalPaths.has(path))) {
      siblingEvidence = { status: "captured-elsewhere", explanation: "Sibling source is captured in changed, targeted, or caller records; inspect siblingInventory for each boundary." };
    } else if (discovered.length) {
      siblingEvidence = { status: "not-captured", explanation: "Sibling source files were discovered but not admitted; inspect siblingInventory, sourceInventory, and evidenceBudget.rejections, then select material ranges with review --context." };
    } else if (siblingInventory.some(inventory => !inventory.complete)) {
      siblingEvidence = { status: "unavailable", explanation: "Sibling discovery is incomplete; inspect siblingInventory for the affected directories and retrieval failures." };
    } else {
      siblingEvidence = { status: "none-found", explanation: "No sibling source files were found in the completely inspected changed directories." };
    }
  }

  let callerEvidence = callers;
  if (!callers.length) {
    if ([...callerPaths].some(path => capturedOptionalPaths.has(path))) {
      callerEvidence = { status: "captured-elsewhere", explanation: "Filename-matched caller candidates are captured in sibling or targeted records; source relationships still require assessment." };
    } else if (callerPaths.size) {
      callerEvidence = { status: "not-captured", explanation: "Caller candidates were found but not admitted; inspect evidenceBudget.rejections and recover material source with review --context." };
    } else {
      callerEvidence = { status: "none-found", explanation: "No current project source file referenced the changed file names in the inspected inventory." };
    }
  }

  const sourceInventory = {
    files: inventoryRecords,
    complete: !inventoryWasTruncated && !inventoryReadTruncated,
    ...(inventoryWasTruncated ? { omittedFiles: paths.length - selectedInventoryPaths.length } : {}),
    ...(inventoryReadTruncated ? { note: "Some source inventory content could not be inspected within retrieval limits." } : {}),
  };
  const context = {
    changedPaths: normalizedChangedPaths,
    ...(recovery ? { sourceRecovery: recovery } : {}),
    changedCode,
    ...(changedCodeCoverage.length ? { changedCodeCoverage } : {}),
    callers: callerEvidence,
    siblings: siblingEvidence,
    siblingInventory,
    projectGuidance: projectGuidance.length ? projectGuidance : { status: "none-found", explanation: "No recognized project guidance files were found in the inspected inventory." },
    guidanceRequirements,
    targetedContext: targetedContext.length ? targetedContext : [],
    ...(externalContext.length ? { externalContext } : {}),
    sourceInventory,
    callerContextPaths: [...callerSourcePaths].sort(),
    callerRetrieval: {
      inventoryFileLimit: MAX_INVENTORY_FILES,
      inventoryReadByteLimit: MAX_INVENTORY_READ_BYTES,
      inspectedFiles: inventoryRecords.length,
      omittedFiles: Math.max(0, paths.length - selectedInventoryPaths.length),
      omittedPathExamples: orderedInventoryPaths.slice(MAX_INVENTORY_FILES, MAX_INVENTORY_FILES + 30),
      unreadable: inventoryRecords.filter(record => record.unreadable),
      recovery: "Use review --context for material source callers, or --caller-context for real runner configuration/discovery source. Assess runtime applicability from captured source; this does not establish global caller completeness.",
    },
    evidenceBudget: {
      maxBytes: budget.maxBytes,
      maxFiles: budget.maxFiles,
      requiredFiles: requiredEvidencePaths.size,
      maxSourceBytes: sourceByteLimit,
      usedBytes: budget.used,
      usedFiles: budget.paths.size,
      records: budget.records,
      rejections: budget.rejections,
    },
    evidenceTruncated: {
      callers: [...callerPaths].some(path => !capturedOptionalPaths.has(path)),
      siblings: [...siblingPaths].some(path => ![...siblings, ...callers, ...targetedContext].some(record => record.path === path && typeof record.content === "string")),
    },
    notes: [
      ...(budget.truncated ? ["Some context evidence was omitted within the bounded evidence-size or file-count limit; request material files or ranges explicitly."] : []),
      ...(!sourceInventory.complete ? ["Source inventory is incomplete; callers or siblings may be omitted."] : []),
    ],
    missingChangedPaths,
    missingContextPaths,
    missingGuidancePaths,
  };
  context.fingerprint = contextFingerprint(context, !legacyRequest);
  return { context, fingerprint: context.fingerprint };
}

export function semanticContextMissing(requiredContext, captured) {
  const missing = [];
  const { context } = captured;
  const { evidenceBudget } = context;
  const requiredRejections = evidenceBudget.rejections.filter(record =>
    (record.source === "changed-code" && requiredContext.includes("changed-code"))
    || (record.source === "project-guidance" && requiredContext.includes("project-guidance"))
    || ["targeted-context", "caller-context", "external-context"].includes(record.source));
  if (requiredRejections.length && evidenceBudget.requiredFiles > evidenceBudget.maxFiles) {
    missing.push(`required-scope capacity exceeded: ${evidenceBudget.requiredFiles} distinct required paths cannot fit the ${evidenceBudget.maxFiles}-file / ${evidenceBudget.maxBytes}-byte evidence budget. Smaller excerpts cannot reduce required file cardinality; no supported within-request recovery exists. Keep the complete scope BLOCKED rather than splitting it or dropping required evidence.`);
  } else if (requiredRejections.length) {
    missing.push(`required-scope evidence capacity reached within the ${evidenceBudget.maxFiles}-file / ${evidenceBudget.maxBytes}-byte budget; inspect evidenceBudget.rejections for exact required records and limits. Recover material context ranges with review --context while retaining complete changed-source coverage. If all required evidence still cannot coexist, keep the whole scope BLOCKED; optional caller/sibling omissions alone do not establish this failure.`);
  }

  if (requiredContext.includes("changed-code")) {
    if (context.changedPaths.length === 0) missing.push("changed-code scope was not supplied");
    if (context.missingChangedPaths.length) {
      missing.push(`could not capture changed files: ${context.missingChangedPaths.join(", ")}`);
      if (context.sourceRecovery) {
        const failures = context.changedCode.filter(record => record.state === "unavailable");
        missing.push(`Automatic source recovery prerequisites: ${failures.map(record => `${record.path} (${record.reason})`).join("; ")}. Unavailable required evidence keeps the review BLOCKED; automatic capture does not establish a verdict.`);
      }
      if (context.changedCode.some(record => record.rangeRecovery)) {
        missing.push("Changed-source range recovery remains available. Before adding replacements, remove each oversized or invalid retained selector from scope.contextPaths with review --remove-context '<exact-selector>'; do not retain the failed selection alongside smaller overlaps. Add bounded --context '<path#Lstart-Lend>' replacements and every omitted line in changedCodeCoverage, including the final line. Keep the complete changed scope and limits, inspect all renewed pages, then submit one assessment. If supported recovery cannot obtain the required evidence, submit explicit BLOCKED naming the prerequisite.");
      }
    }
  }

  const targetedRecords = Array.isArray(context.targetedContext)
    ? context.targetedContext.filter(record => record.content)
    : [];
  const hasCallerEvidence = (Array.isArray(context.callers) && context.callers.length > 0)
    || [...(Array.isArray(context.siblings) ? context.siblings : []), ...targetedRecords].some(record => record.source === "caller-context"
      || context.changedPaths.some(changedPath => {
        const stem = basename(changedPath).replace(/\.[^.]+$/, "");
        return stem && record.content.includes(stem);
      }));
  const siblingRecords = [
    ...(Array.isArray(context.siblings) ? context.siblings : []),
    ...(Array.isArray(context.callers) ? context.callers : []),
    ...targetedRecords.filter(record => codeFile(record.path) && !context.changedPaths.includes(record.path)),
    ...context.changedCode.filter(record => record.state === "present" && typeof record.content === "string"),
  ];
  const incompleteSiblingBoundaries = context.siblingInventory.filter(inventory =>
    !inventory.complete || (inventory.files.length > 0
      && !siblingRecords.some(record => inventory.files.includes(record.path))));
  if (requiredContext.includes("callers") && !hasCallerEvidence
    && (!context.sourceInventory.complete || context.evidenceTruncated?.callers)) {
    const retrieval = context.callerRetrieval;
    const limits = `${retrieval.inventoryFileLimit}-file inventory / ${retrieval.inventoryReadByteLimit}-byte read limits`;
    missing.push(`caller retrieval is incomplete within the bounded project evidence (${limits}; ${retrieval.omittedFiles} files omitted; ${retrieval.unreadable.length} unreadable). Inspect context.callerRetrieval for omitted paths and exact read failures. ${retrieval.recovery}`);
  }
  if (requiredContext.includes("siblings") && incompleteSiblingBoundaries.length) {
    const boundaries = incompleteSiblingBoundaries.map(inventory => {
      const candidates = inventory.files.slice(0, 3).join(", ");
      return `${inventory.path} (${inventory.reason ?? "no representative sibling source captured"}${candidates ? `; candidates: ${candidates}` : ""})`;
    });
    missing.push(`sibling retrieval is incomplete for changed boundaries: ${boundaries.join("; ")}. Inspect siblingInventory and evidenceBudget.rejections; recover material source with review --context <path[#Lstart-Lend]> without narrowing the changed scope.`);
  }
  if (requiredContext.includes("project-guidance")) {
    const unavailableGuidance = context.missingGuidancePaths.filter(path =>
      !targetedRecords.some(record => record.path === path));
    if (unavailableGuidance.length) {
      const details = unavailableGuidance.map(path => {
        const requirement = context.guidanceRequirements.find(record => record.path === path);
        return `${path} (${requirement.reason}; required by ${requirement.requiredBy.join(", ")})`;
      });
      missing.push(`could not capture project guidance: ${details.join("; ")}. Inspect context.evidenceBudget for competing records; recover material ranges with review --context. If required records cannot coexist, the review remains BLOCKED.`);
    }
  }
  if (context.missingContextPaths.length) {
    missing.push(`could not capture targeted context: ${context.missingContextPaths.join(", ")}`);
  }
  for (const record of context.externalContext ?? []) {
    if (record.state === "unavailable") {
      missing.push(`could not capture external evidence ${record.selector}: ${record.reason}. This is an evidence prerequisite, not a proved source defect.`);
    }
  }
  return missing;
}

export function validateSemanticCitations(citations, context) {
  if (!Array.isArray(citations) || citations.length === 0) throw new Error("PASS and FAIL assessments require at least one citation");
  const records = new Map();
  for (const group of [context.changedCode, context.callers, context.siblings, context.projectGuidance, context.targetedContext, context.externalContext]) {
    if (Array.isArray(group)) {
      for (const record of group) {
        if (!record.content) continue;
        const excerpts = records.get(record.path) ?? [];
        excerpts.push(record);
        records.set(record.path, excerpts);
      }
    }
  }

  return citations.map((citation, index) => {
    if (!citation || typeof citation !== "object" || Array.isArray(citation)) {
      throw new Error(`citations[${index}] must be an object`);
    }
    const path = context.externalContext?.some(record => record.path === citation.path)
      ? citation.path
      : normalizedProjectPath(citation.path, `citations[${index}].path`);
    if (!Number.isInteger(citation.line) || citation.line < 1) {
      throw new Error(`citations[${index}].line must be a positive integer`);
    }
    if (typeof citation.quote !== "string" || !citation.quote.trim() || citation.quote.length > 2_000) {
      throw new Error(`citations[${index}].quote must be a non-empty excerpt no longer than 2,000 characters`);
    }
    const excerpts = records.get(path);
    if (!excerpts) throw new Error(`citation ${path}:${citation.line} is not in the captured evidence`);
    const quote = citation.quote.replaceAll("\r\n", "\n");
    const quoteLines = quote.split("\n");
    const record = excerpts.find(excerpt => {
      const capturedLine = citation.line - (excerpt.startLine ?? 1);
      if (capturedLine < 0) return false;
      const actualLines = excerpt.content.split(/\r?\n/).slice(capturedLine, capturedLine + quoteLines.length);
      return actualLines.length === quoteLines.length && actualLines.join("\n").includes(quote);
    });
    if (!record) throw new Error(`citation ${path}:${citation.line} does not match the captured source excerpt`);
    return { path, line: citation.line, quote: citation.quote, ...(record.state === "deleted" ? { state: "deleted" } : {}) };
  });
}
