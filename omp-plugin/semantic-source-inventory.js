import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, opendir, readdir, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";

import {
  deletedProjectSource,
  insideRoot,
  MAX_INVENTORY_FILE_BYTES,
  readDeliveryProjectText,
  readProjectText,
  ROOT_REVIEW_CONFIG,
} from "#root/omp-plugin/semantic-project-source.js";
import { codeFile } from "#root/omp-plugin/semantic-source-candidates.js";

const execFileAsync = promisify(execFile);
const MAX_INVENTORY_FILES = 1_200;
const MAX_INVENTORY_READ_BYTES = 8_000_000;
const SKIPPED_DIRECTORIES = new Set([
  ".git", "node_modules", "vendor", "dist", "build", "coverage", "target", ".next", ".cache", ".turbo",
]);
const PROJECT_GUIDANCE_NAMES = new Set([
  ROOT_REVIEW_CONFIG, "AGENTS.md", "CLAUDE.md", "WATCHDOG.md", "WATCHDOG.yml", "WATCHDOG.yaml", "CONTRIBUTING.md",
  "README.md", "copilot-instructions.md",
]);

export async function deliveryGuidance(root, changedPaths, contextPaths) {
  const boundaryPaths = [...new Set([...changedPaths, ...contextPaths])];
  const directories = new Set();
  for (const path of boundaryPaths) {
    for (let directory = dirname(path); !directories.has(directory); directory = dirname(directory)) {
      directories.add(directory);
      if (directory === ".") break;
    }
  }

  // Probe recognized guidance names only. Do not list directory entries or Git trees.
  const candidates = [...directories].flatMap(directory => Array.from(PROJECT_GUIDANCE_NAMES, name =>
    directory === "." ? name : `${directory}/${name}`));
  const guidancePaths = new Set(boundaryPaths.filter(isGuidancePath));
  for (let offset = 0; offset < candidates.length; offset += 64) {
    const presentPaths = await Promise.all(candidates.slice(offset, offset + 64).map(async path => {
      try {
        await lstat(resolve(root, path));
        return path;
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") return path;
        return undefined;
      }
    }));
    for (const path of presentPaths) {
      if (path !== undefined) guidancePaths.add(path);
    }
  }

  const availableText = new Map();
  if (guidancePaths.has(ROOT_REVIEW_CONFIG)) {
    const config = await readDeliveryProjectText(root, ROOT_REVIEW_CONFIG, MAX_INVENTORY_FILE_BYTES);
    if (typeof config.content === "string") {
      availableText.set(ROOT_REVIEW_CONFIG, config.content);
    }
  }
  return { boundaryPaths, guidancePaths: [...guidancePaths].sort(), availableText };
}

export async function inventoryProjectSource(root, {
  changedPaths,
  contextPaths,
  requiredSourceLimit,
}) {
  const deletedSources = new Map();
  const siblingInventory = await inventorySiblingDirectories(root, changedPaths, deletedSources, requiredSourceLimit);
  const paths = [...new Set([
    ...await inventoryPaths(root, [...changedPaths, ...contextPaths]),
    ...siblingInventory.flatMap(inventory => inventory.files),
  ])].sort();

  // Explicit selections and rename destinations extend the boundary for binding guidance.
  const renamedBoundaryPaths = siblingInventory.flatMap(inventory => (inventory.renames ?? []).map(rename => rename.to));
  const boundaryPaths = [...changedPaths, ...contextPaths, ...renamedBoundaryPaths];
  const guidancePaths = paths.filter(path => relevantGuidance(path, boundaryPaths));
  const orderedPaths = prioritizedInventory(paths, changedPaths, contextPaths);
  const selectedPaths = orderedPaths.slice(0, MAX_INVENTORY_FILES);
  const files = [];
  const availableText = new Map();
  let readBytes = 0;
  let readTruncated = false;

  for (const path of selectedPaths) {
    const remainingBytes = Math.max(0, MAX_INVENTORY_READ_BYTES - readBytes);
    const result = await readProjectText(root, path, Math.min(MAX_INVENTORY_FILE_BYTES, remainingBytes));
    if (result.missing) continue;
    if (result.error) {
      readTruncated = true;
      files.push({ path, unreadable: result.error });
      continue;
    }

    files.push({ path, size: result.size, sha256: result.sha256 });
    if (readBytes + result.size > MAX_INVENTORY_READ_BYTES) {
      readTruncated = true;
      continue;
    }

    readBytes += result.size;
    if (result.referenceSelectionEligible || codeFile(path)) {
      availableText.set(path, result.content);
    }
  }

  const omittedFiles = paths.length - selectedPaths.length;
  return {
    deletedSources,
    siblingInventory,
    boundaryPaths,
    guidancePaths,
    selectedPaths,
    availableText,
    sourceInventory: {
      files,
      complete: !omittedFiles && !readTruncated,
      ...(omittedFiles ? { omittedFiles } : {}),
      ...(readTruncated ? { note: "Some source inventory content could not be inspected within retrieval limits." } : {}),
    },
    callerInventory: {
      inventoryFileLimit: MAX_INVENTORY_FILES,
      inventoryReadByteLimit: MAX_INVENTORY_READ_BYTES,
      inspectedFiles: files.length,
      omittedFiles,
      omittedPathExamples: orderedPaths.slice(MAX_INVENTORY_FILES, MAX_INVENTORY_FILES + 30),
      unreadable: files.filter(record => record.unreadable),
    },
  };
}

export function relevantGuidance(path, changedPaths) {
  if (!isGuidancePath(path)) {
    return false;
  }

  const guidanceDirectory = dirname(path);
  return changedPaths.some(changedPath => guidanceDirectory === "."
    || dirname(changedPath) === guidanceDirectory
    || changedPath.startsWith(`${guidanceDirectory}/`));
}

export async function readUnavailableSourceStates(root, paths) {
  return Promise.all(paths.map(async path => {
    try {
      const entry = await lstat(resolve(root, path), { bigint: true });
      return {
        path,
        state: "present",
        size: String(entry.size),
        mode: String(entry.mode),
        inode: String(entry.ino),
        device: String(entry.dev),
        modified: String(entry.mtimeNs),
        changed: String(entry.ctimeNs),
      };
    } catch (error) {
      return { path, state: "unavailable", reason: error.code ?? error.message };
    }
  }));
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

async function inventoryPaths(root, boundaryPaths) {
  const trackedPaths = await gitInventory(root) ?? await directoryInventory(root);
  return [...new Set([
    ...trackedPaths.map(path => path.replaceAll("\\", "/").replace(/^\.\//, "")),
    ...boundaryPaths,
  ])]
    .filter(path => path && (codeFile(path) || isGuidancePath(path)))
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

async function inventoryHistoricalSiblings(root, directory, remainingEntries, { changedPaths, deletedSources, maxSourceBytes }) {
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

    snapshots.push({ revision: revision || "index", sha256: createHash("sha256").update(stdout).digest("hex") });
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

async function inventorySiblingDirectories(root, changedPaths, deletedSources, maxSourceBytes) {
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
          const historical = await inventoryHistoricalSiblings(root, path, MAX_INVENTORY_FILES - inspectedEntries, {
            changedPaths,
            deletedSources,
            maxSourceBytes,
          });
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

function prioritizedInventory(paths, changedPaths, contextPaths) {
  const priority = path => {
    if (changedPaths.includes(path) || contextPaths.includes(path)) return 0;
    if (relevantGuidance(path, changedPaths)) return 1;
    if (codeFile(path) && changedPaths.some(changedPath => dirname(path) === dirname(changedPath))) return 2;
    return 3;
  };
  return [...paths].sort((left, right) => priority(left) - priority(right) || left.localeCompare(right));
}

function isGuidancePath(path) {
  const fileName = basename(path);
  return PROJECT_GUIDANCE_NAMES.has(fileName)
    || (path.startsWith(".cursor/rules/") && fileName.endsWith(".mdc"));
}
