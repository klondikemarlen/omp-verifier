import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { opendir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const MAX_INVENTORY_FILES = 1_200;
const MAX_INVENTORY_READ_BYTES = 8_000_000;
const MAX_FILE_EVIDENCE_BYTES = 16_000;
const MAX_INVENTORY_FILE_BYTES = 256_000;
const MAX_TOTAL_EVIDENCE_BYTES = 256_000;
const MAX_EVIDENCE_FILES = 40;
const MAX_LARGE_SCOPE_EVIDENCE_BYTES = 1_024_000;
const MAX_LARGE_SCOPE_EVIDENCE_FILES = 256;
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

async function siblingDirectoryInventory(root, changedPaths) {
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
      inventory.reason = error.message;
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
  const records = previousContext?.changedCode?.filter(record => record.path === path && typeof record.content === "string") ?? [];
  const coverage = previousContext?.changedCodeCoverage?.find(record => record.path === path);
  if (records.length !== 1 || coverage || records[0].partial || records[0].startLine > 1) return undefined;
  return records[0].content;
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

async function gitSource(root, reference) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "show", "--no-ext-diff", "--no-textconv", reference], {
      encoding: "buffer",
      maxBuffer: MAX_FILE_EVIDENCE_BYTES,
      timeout: 5_000,
    });
    if (stdout.includes(0)) return undefined;

    return stdout.toString("utf8");
  } catch {
    return undefined;
  }
}

async function deletedProjectSource(root, path) {
  for (const reference of [`:${path}`, `HEAD:${path}`]) {
    const content = await gitSource(root, reference);
    if (content !== undefined) return content;
  }

  try {
    const { stdout } = await execFileAsync("git", [
      "-C", root, "log", "--first-parent", "--diff-merges=first-parent",
      "--format=%H", "--no-patch", "--diff-filter=D", "-1", "HEAD", "--", `:(literal)${path}`,
    ], { maxBuffer: 128, timeout: 5_000 });
    const deletionCommit = stdout.trim();
    if (!/^[a-f0-9]{40,64}$/.test(deletionCommit)) return undefined;

    return gitSource(root, `${deletionCommit}^:${path}`);
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

function contextFingerprint(context) {
  return sha256(JSON.stringify({
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
  }));
}

export async function captureSemanticContext({ repositoryRoot, changedPaths, contextPaths = [], callerContextPaths = [], previousContext }) {
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
  if (selectors.length > MAX_CONTEXT_PATHS) {
    throw new Error(`contextPaths must not exceed ${MAX_CONTEXT_PATHS} selectors`);
  }
  const requestedContext = selectors.filter(context =>
    context.startLine || !selectors.some(other => other.path === context.path && other.startLine));
  const normalizedContextPaths = [...new Set(requestedContext.map(context => context.path))].sort();

  const siblingInventory = await siblingDirectoryInventory(root, normalizedChangedPaths);
  const paths = [...new Set([
    ...await inventoryPaths(root, [...normalizedChangedPaths, ...normalizedContextPaths]),
    ...siblingInventory.flatMap(inventory => inventory.files),
  ])].sort();

  // Filename matches are candidate callers, not a declaration of material dependencies.
  // Explicit context promotes those boundaries and their owning guidance together.
  const boundaryPaths = [...normalizedChangedPaths, ...normalizedContextPaths];
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

  const requiredEvidencePaths = new Set([...normalizedChangedPaths, ...normalizedContextPaths, ...guidancePaths]);
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
    const result = await readProjectText(root, path);
    if (result.missing) {
      const priorContent = previousSource(previousContext, path) ?? await deletedProjectSource(root, path);
      if (typeof priorContent !== "string") {
        changedCode.push({ path, state: "unavailable", reason: "path is absent and no prior source confirms its deletion" });
        missingChangedPaths.push(path);
        continue;
      }
      const deletedRecord = {
        path,
        source: "changed-code",
        state: "deleted",
        content: priorContent,
        previousSha256: sha256(priorContent),
      };
      if (!addRecord(changedCode, deletedRecord, budget)) {
        changedCode.push({ path, state: "unavailable", reason: "context evidence limit reached" });
        missingChangedPaths.push(path);
      }
      continue;
    }
    if (result.error === `file exceeds the ${MAX_FILE_EVIDENCE_BYTES}-byte context limit`) {
      const selectorsForPath = requestedContext.filter(selector => selector.path === path && selector.startLine);
      if (selectorsForPath.length) changedSelectors.set(path, true);
      if (!selectorsForPath.length) {
        changedCode.push({ path, state: "unavailable", reason: result.error });
        missingChangedPaths.push(path);
        continue;
      }
      const chunks = [];
      let failed = false;
      let failureReason;
      let identity;
      for (const [startLine, endLine] of disjointLineRanges(selectorsForPath)) {
        const chunk = await readProjectText(root, path, MAX_FILE_EVIDENCE_BYTES, { startLine, endLine });
        if (chunk.error || chunk.missing) {
          failed = true;
          failureReason = chunk.error ?? "source disappeared while selected ranges were being captured";
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
        changedCode.push({ path, state: "unavailable", reason: failureReason ?? "selected changed source ranges could not be captured consistently" });
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
  const guidanceRequirements = guidancePaths.map(path => ({
    path,
    requiredBy: boundaryPaths.filter(boundary => relevantGuidance(path, [boundary])),
  }));
  const missingGuidancePaths = [];
  for (const path of guidancePaths) {
    if (targetedContext.some(record => record.path === path && record.content)) continue;
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

  const callers = [];
  const siblings = [];
  const capturedOptionalPaths = new Set(targetedContext.filter(record => typeof record.content === "string").map(record => record.path));
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
      siblingEvidence = { status: "captured-elsewhere", explanation: "Sibling source is captured in targeted context or caller records; inspect siblingInventory for each boundary." };
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
    changedCode,
    ...(changedCodeCoverage.length ? { changedCodeCoverage } : {}),
    callers: callerEvidence,
    siblings: siblingEvidence,
    siblingInventory,
    projectGuidance: projectGuidance.length ? projectGuidance : { status: "none-found", explanation: "No recognized project guidance files were found in the inspected inventory." },
    guidanceRequirements,
    targetedContext: targetedContext.length ? targetedContext : [],
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
  context.fingerprint = contextFingerprint(context);
  return { context, fingerprint: context.fingerprint };
}

export function semanticContextMissing(requiredContext, captured) {
  const missing = [];
  const { context } = captured;
  const { evidenceBudget } = context;
  const requiredRejections = evidenceBudget.rejections.filter(record =>
    (record.source === "changed-code" && requiredContext.includes("changed-code"))
    || (record.source === "project-guidance" && requiredContext.includes("project-guidance"))
    || record.source === "targeted-context" || record.source === "caller-context");
  if (requiredRejections.length && evidenceBudget.requiredFiles > evidenceBudget.maxFiles) {
    missing.push(`required-scope capacity exceeded: ${evidenceBudget.requiredFiles} distinct required paths cannot fit the ${evidenceBudget.maxFiles}-file / ${evidenceBudget.maxBytes}-byte evidence budget. Smaller excerpts cannot reduce required file cardinality; no supported within-request recovery exists. Keep the complete scope BLOCKED rather than splitting it or dropping required evidence.`);
  } else if (requiredRejections.length) {
    missing.push(`required-scope evidence capacity reached within the ${evidenceBudget.maxFiles}-file / ${evidenceBudget.maxBytes}-byte budget; inspect evidenceBudget.rejections for exact required records and limits. Recover material context ranges with review --context while retaining complete changed-source coverage. If all required evidence still cannot coexist, keep the whole scope BLOCKED; optional caller/sibling omissions alone do not establish this failure.`);
  }

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
    || [...(Array.isArray(context.siblings) ? context.siblings : []), ...targetedRecords].some(record => record.source === "caller-context"
      || context.changedPaths.some(changedPath => {
        const stem = basename(changedPath).replace(/\.[^.]+$/, "");
        return stem && record.content.includes(stem);
      }));
  const siblingRecords = [
    ...(Array.isArray(context.siblings) ? context.siblings : []),
    ...(Array.isArray(context.callers) ? context.callers : []),
    ...targetedRecords.filter(record => codeFile(record.path) && !context.changedPaths.includes(record.path)),
  ];
  const incompleteSiblingBoundaries = context.siblingInventory.filter(inventory =>
    !inventory.complete || (inventory.files.length > 0
      && !siblingRecords.some(record => dirname(record.path) === inventory.path)));
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
