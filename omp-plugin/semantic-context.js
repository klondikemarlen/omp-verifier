import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const MAX_INVENTORY_FILES = 1_200;
const MAX_INVENTORY_READ_BYTES = 8_000_000;
const MAX_FILE_EVIDENCE_BYTES = 16_000;
const MAX_INVENTORY_FILE_BYTES = 256_000;
const MAX_TOTAL_EVIDENCE_BYTES = 128_000;
const MAX_EVIDENCE_FILES = 40;
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

function normalizedProjectPath(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty project-relative path`);
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
  if (fileStat.size > sourceLimit) return { error: `file exceeds the ${sourceLimit}-byte context limit` };

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
  if (startLine > allLines.length) return { error: `requested line ${startLine} is beyond end of file` };
  if (endLine > allLines.length) return { error: `requested line ${endLine} is beyond end of file` };

  const content = allLines.slice(startLine - 1, endLine).join("\n");
  if (Buffer.byteLength(content) > MAX_FILE_EVIDENCE_BYTES) {
    return { error: `excerpt exceeds the ${MAX_FILE_EVIDENCE_BYTES}-byte evidence limit; request a smaller line range` };
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
  return previousContext?.changedCode?.find(record => record.path === path && typeof record.content === "string")?.content;
}

async function deletedProjectSource(root, path) {
  for (const reference of [`:${path}`, `HEAD:${path}`]) {
    try {
      const { stdout } = await execFileAsync("git", ["-C", root, "show", "--no-ext-diff", "--no-textconv", reference], {
        encoding: "buffer",
        maxBuffer: MAX_FILE_EVIDENCE_BYTES,
      });
      if (stdout.includes(0)) return undefined;
      return stdout.toString("utf8");
    } catch {
      // A new, untracked file may have no prior Git version.
    }
  }
  return undefined;
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
  if ((!budget.paths.has(record.path) && budget.paths.size >= MAX_EVIDENCE_FILES)
    || budget.used + bytes > MAX_TOTAL_EVIDENCE_BYTES) {
    budget.truncated = true;
    return false;
  }
  records.push(record);
  budget.paths.add(record.path);
  budget.used += bytes;
  return true;
}

function contextFingerprint(context) {
  return sha256(JSON.stringify({
    changedPaths: context.changedPaths,
    changedCode: context.changedCode,
    callers: context.callers,
    siblings: context.siblings,
    projectGuidance: context.projectGuidance,
    targetedContext: context.targetedContext,
    sourceInventory: context.sourceInventory,
  }));
}

export async function captureSemanticContext({ repositoryRoot, changedPaths, contextPaths = [], previousContext }) {
  const root = await realpath(repositoryRoot);
  const normalizedChangedPaths = [...new Set(changedPaths.map(path => normalizedProjectPath(path, "changed path")))].sort();
  const selectors = contextPaths.map(contextRange).map(context => ({
    ...context,
    path: normalizedProjectPath(context.path, "context path"),
  }));
  if (selectors.length > MAX_CONTEXT_PATHS) {
    throw new Error(`contextPaths must not exceed ${MAX_CONTEXT_PATHS} selectors`);
  }
  const requestedContext = selectors.filter(context =>
    context.startLine || !selectors.some(other => other.path === context.path && other.startLine));
  const normalizedContextPaths = [...new Set(requestedContext.map(context => context.path))].sort();

  const paths = await inventoryPaths(root, [...normalizedChangedPaths, ...normalizedContextPaths]);
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

  const budget = { used: 0, paths: new Set(), truncated: false };
  const changedCode = [];
  const missingChangedPaths = [];
  for (const path of normalizedChangedPaths) {
    const result = await readProjectText(root, path);
    if (result.missing) {
      const priorContent = previousSource(previousContext, path) ?? await deletedProjectSource(root, path);
      if (typeof priorContent !== "string") {
        changedCode.push({ path, state: "unavailable", reason: "path is absent and no prior source confirms its deletion" });
        missingChangedPaths.push(path);
        continue;
      }
      changedCode.push({
        path,
        state: "deleted",
        content: priorContent,
        previousSha256: sha256(priorContent),
      });
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
    const result = await readProjectText(root, path, MAX_FILE_EVIDENCE_BYTES, selector.startLine ? selector : undefined);
    if (result.missing || result.error) {
      targetedContext.push({ path, state: "unavailable", reason: result.error ?? "path is absent" });
      missingContextPaths.push(path);
      continue;
    }
    if (!addRecord(targetedContext, recordFor(path, result, "targeted-context"), budget)) {
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
  const boundaryPaths = [...normalizedChangedPaths, ...normalizedContextPaths, ...callerPaths];
  const guidancePaths = paths.filter(path => relevantGuidance(path, boundaryPaths));
  const missingGuidancePaths = [];
  for (const path of guidancePaths) {
    if (targetedContext.some(record => record.path === path && record.content)) continue;
    let result = await readProjectText(root, path);
    if (result.error === `file exceeds the ${MAX_FILE_EVIDENCE_BYTES}-byte context limit`) {
      result = await readProjectText(root, path, MAX_FILE_EVIDENCE_BYTES, { startLine: 1 });
    }
    if (result.missing || result.error) {
      missingGuidancePaths.push(path);
      continue;
    }
    if (!addRecord(projectGuidance, recordFor(path, result, "project-guidance"), budget)) {
      missingGuidancePaths.push(path);
    }
  }

  const callers = [];
  const siblings = [];
  for (const [pathsToCapture, records, source] of [
    [callerPaths, callers, "callers"],
    [siblingPaths, siblings, "siblings"],
  ]) {
    for (const path of pathsToCapture) {
      const content = availableText.get(path);
      addRecord(records, recordFor(path, { content, sha256: sha256(content) }, source), budget);
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
    changedCode,
    callers: callers.length ? callers : { status: "none-found", explanation: "No current project source file referenced the changed file names in the inspected inventory." },
    siblings: siblings.length ? siblings : { status: "none-found", explanation: "No sibling source files were found in the changed files' directories." },
    projectGuidance: projectGuidance.length ? projectGuidance : { status: "none-found", explanation: "No recognized project guidance files were found in the inspected inventory." },
    targetedContext: targetedContext.length ? targetedContext : [],
    sourceInventory,
    evidenceTruncated: {
      callers: callers.length < callerPaths.size,
      siblings: siblings.length < siblingPaths.size,
    },
    notes: [
      ...(budget.truncated ? ["Some context evidence was omitted within the bounded evidence-size or file-count limit; request material files or ranges explicitly."] : []),
      ...(!sourceInventory.complete ? ["Source inventory is incomplete; callers or siblings may be omitted."] : []),
    ],
    missingChangedPaths,
    missingContextPaths,
    missingGuidancePaths,
  };
  context.fingerprint = contextFingerprint(context);
  return { context, fingerprint: context.fingerprint };
}

export function semanticContextMissing(requiredContext, captured) {
  const missing = [];
  const { context } = captured;
  if (requiredContext.includes("changed-code")) {
    if (context.changedPaths.length === 0) missing.push("changed-code scope was not supplied");
    if (context.missingChangedPaths.length) {
      missing.push(`could not capture changed files: ${context.missingChangedPaths.join(", ")}`);
    }
  }

  const targetedRecords = Array.isArray(context.targetedContext)
    ? context.targetedContext.filter(record => record.content)
    : [];
  const hasCallerEvidence = (Array.isArray(context.callers) && context.callers.length > 0)
    || targetedRecords.some(record => context.changedPaths.some(changedPath => {
      const stem = basename(changedPath).replace(/\.[^.]+$/, "");
      return stem && record.content.includes(stem);
    }));
  const hasSiblingEvidence = (Array.isArray(context.siblings) && context.siblings.length > 0)
    || targetedRecords.some(record => codeFile(record.path)
      && context.changedPaths.some(changedPath => dirname(changedPath) === dirname(record.path)));
  if (requiredContext.includes("callers") && !hasCallerEvidence
    && (!context.sourceInventory.complete || context.evidenceTruncated?.callers)) {
    missing.push("caller retrieval is incomplete within the bounded project evidence");
  }
  if (requiredContext.includes("siblings") && !hasSiblingEvidence
    && (!context.sourceInventory.complete || context.evidenceTruncated?.siblings)) {
    missing.push("sibling retrieval is incomplete within the bounded project evidence");
  }
  if (requiredContext.includes("project-guidance")) {
    const unavailableGuidance = context.missingGuidancePaths.filter(path =>
      !targetedRecords.some(record => record.path === path));
    if (unavailableGuidance.length) {
      missing.push(`could not capture project guidance: ${unavailableGuidance.join(", ")}`);
    }
  }
  if (context.missingContextPaths.length) {
    missing.push(`could not capture targeted context: ${context.missingContextPaths.join(", ")}`);
  }
  return missing;
}

export function validateSemanticCitations(citations, context) {
  if (!Array.isArray(citations) || citations.length === 0) throw new Error("PASS and FAIL assessments require at least one citation");
  const records = new Map();
  for (const group of [context.changedCode, context.callers, context.siblings, context.projectGuidance, context.targetedContext]) {
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
    const path = normalizedProjectPath(citation.path, `citations[${index}].path`);
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
