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

async function readProjectText(root, path, maxBytes = MAX_FILE_EVIDENCE_BYTES) {
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
  if (fileStat.size > maxBytes) return { error: `file exceeds the ${maxBytes}-byte context limit` };

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
  };
}

function recordFor(path, result, source) {
  return {
    path,
    state: "present",
    source,
    sha256: result.sha256,
    lineCount: result.content.split(/\r?\n/).length,
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
  if (records.some(existing => existing.path === record.path)) return true;
  if (records.length >= MAX_EVIDENCE_FILES || budget.used + record.content.length > MAX_TOTAL_EVIDENCE_BYTES) {
    budget.truncated = true;
    return false;
  }
  records.push(record);
  budget.used += record.content.length;
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
  const normalizedContextPaths = [...new Set(contextPaths.map(path => normalizedProjectPath(path, "context path")))].sort();
  if (normalizedContextPaths.length > MAX_CONTEXT_PATHS) {
    throw new Error(`contextPaths must not exceed ${MAX_CONTEXT_PATHS} files`);
  }

  const paths = await inventoryPaths(root, normalizedChangedPaths);
  const inventoryWasTruncated = paths.length > MAX_INVENTORY_FILES;
  const selectedInventoryPaths = paths.slice(0, MAX_INVENTORY_FILES);
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

  const budget = { used: 0, truncated: false };
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

  const callers = [];
  const siblings = [];
  for (const changedPath of normalizedChangedPaths) {
    const stem = basename(changedPath).replace(/\.[^.]+$/, "");
    const changedDirectory = dirname(changedPath);
    for (const path of selectedInventoryPaths) {
      if (path === changedPath || !codeFile(path)) continue;
      const content = availableText.get(path);
      if (content === undefined) continue;
      if (dirname(path) === changedDirectory) {
        addRecord(siblings, recordFor(path, {
          content,
          sha256: sha256(content),
        }, "siblings"), budget);
      }
      if (stem && content.includes(stem)) {
        addRecord(callers, recordFor(path, {
          content,
          sha256: sha256(content),
        }, "callers"), budget);
      }
    }
  }

  const projectGuidance = [];
  const guidancePaths = paths.filter(isGuidancePath);
  const missingGuidancePaths = [];
  for (const path of guidancePaths) {
    const content = availableText.get(path);
    if (content === undefined) {
      missingGuidancePaths.push(path);
      continue;
    }
    if (!addRecord(projectGuidance, recordFor(path, {
      content,
      sha256: sha256(content),
    }, "project-guidance"), budget)) {
      missingGuidancePaths.push(path);
    }
  }

  const targetedContext = [];
  const missingContextPaths = [];
  for (const path of normalizedContextPaths) {
    const result = await readProjectText(root, path);
    if (result.missing) {
      targetedContext.push({ path, state: "missing" });
      missingContextPaths.push(path);
      continue;
    }
    if (result.error) {
      targetedContext.push({ path, state: "unavailable", reason: result.error });
      missingContextPaths.push(path);
      continue;
    }
    const record = recordFor(path, result, "targeted-context");
    if (!addRecord(targetedContext, record, budget)) {
      targetedContext.push({ path, state: "unavailable", reason: "context evidence limit reached" });
      missingContextPaths.push(path);
      continue;
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
    notes: [
      ...(budget.truncated ? ["Context retrieval reached its evidence-size or file-count limit."] : []),
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
  if (!context.sourceInventory.complete) {
    if (requiredContext.includes("callers") && !hasCallerEvidence) {
      missing.push("caller retrieval is incomplete within the bounded project inventory");
    }
    if (requiredContext.includes("siblings") && !hasSiblingEvidence) {
      missing.push("sibling retrieval is incomplete within the bounded project inventory");
    }
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
  if (context.notes.some(note => note.startsWith("Context retrieval reached"))) {
    missing.push("required context exceeded the bounded evidence limit");
  }
  return missing;
}

export function validateSemanticCitations(citations, context) {
  if (!Array.isArray(citations) || citations.length === 0) throw new Error("PASS and FAIL assessments require at least one citation");
  const records = new Map();
  for (const group of [context.changedCode, context.callers, context.siblings, context.projectGuidance, context.targetedContext]) {
    if (Array.isArray(group)) {
      for (const record of group) {
        if (record.content) records.set(record.path, record);
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
    const record = records.get(path);
    if (!record) throw new Error(`citation ${path}:${citation.line} is not in the captured evidence`);
    const lines = record.content.split(/\r?\n/);
    const quoteLines = citation.quote.replaceAll("\r\n", "\n").split("\n");
    const actualLines = lines.slice(citation.line - 1, citation.line - 1 + quoteLines.length);
    if (actualLines.length !== quoteLines.length || !actualLines.join("\n").includes(citation.quote.replaceAll("\r\n", "\n"))) {
      throw new Error(`citation ${path}:${citation.line} does not match the captured source excerpt`);
    }
    return { path, line: citation.line, quote: citation.quote, ...(record.state === "deleted" ? { state: "deleted" } : {}) };
  });
}
