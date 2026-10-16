import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const MAX_CONTRACT_BYTES = 64_000;
const MAX_STANDARD_SOURCE_BYTES = 128_000;
const MAX_TEXT_LENGTH = 4_000;
const CONTEXT_TYPES = new Set(["changed-code", "callers", "siblings", "project-guidance"]);
const RUBRIC_ID = /^[a-z0-9][a-z0-9-]*$/;

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT_LENGTH) {
    throw new Error(`${name} must be a non-empty string no longer than ${MAX_TEXT_LENGTH} characters`);
  }
  return value;
}

function packageRelativePath(value, name) {
  const path = requiredText(value, name).replaceAll("\\", "/");
  if (!path.startsWith("./") || isAbsolute(path) || path.split("/").includes("..")) {
    throw new Error(`${name} must be a package-relative path without traversal`);
  }
  return path.slice(2);
}

function insidePackage(packageRealPath, fileRealPath, name) {
  const pathFromPackage = relative(packageRealPath, fileRealPath);
  if (pathFromPackage.startsWith("..") || isAbsolute(pathFromPackage)) {
    throw new Error(`${name} must stay inside its package`);
  }
}

async function readPackageFile(packagePath, filePath, name, maxBytes) {
  const packageRealPath = await realpath(packagePath);
  const fileRealPath = await realpath(filePath);
  insidePackage(packageRealPath, fileRealPath, name);
  const contents = await readFile(fileRealPath);
  if (contents.byteLength > maxBytes) throw new Error(`${name} exceeded the ${maxBytes}-byte limit`);
  return { contents, fileRealPath };
}

function headingSlug(heading) {
  const explicitId = heading.match(/\{#([^}]+)\}\s*$/)?.[1];
  if (explicitId) return explicitId.toLowerCase();
  return heading
    .replace(/<[^>]*>/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

function sourceSection(contents, fragment) {
  const lines = contents.split(/\r?\n/);
  if (!fragment) return { text: contents, firstLine: 1, lastLine: lines.length };

  const expectedSlug = decodeURIComponent(fragment).toLowerCase();
  const headingIndex = lines.findIndex(line => {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)?.[1];
    return heading && headingSlug(heading) === expectedSlug;
  });
  if (headingIndex < 0) throw new Error(`standard source fragment #${fragment} does not identify a heading`);

  const headingLevel = lines[headingIndex].match(/^\s{0,3}(#+)/)[1].length;
  let sectionEnd = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const nextHeading = lines[index].match(/^\s{0,3}(#+)\s+/)?.[1];
    if (nextHeading && nextHeading.length <= headingLevel) {
      sectionEnd = index;
      break;
    }
  }
  return {
    text: lines.slice(headingIndex, sectionEnd).join("\n"),
    firstLine: headingIndex + 1,
    lastLine: sectionEnd,
  };
}

function validateContract(contract, checkId) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    throw new Error("agentic contract must be a JSON object");
  }
  if (contract.version !== 1) throw new Error("agentic contract version must be 1");
  const standardId = requiredText(contract.standardId, "standardId");
  if (standardId !== checkId) throw new Error("standardId must match the verification id");
  const gold = requiredText(contract.gold, "gold");

  if (!Array.isArray(contract.requiredContext) || contract.requiredContext.length === 0) {
    throw new Error("requiredContext must be a non-empty array");
  }
  const requiredContext = [...new Set(contract.requiredContext)];
  if (requiredContext.length !== contract.requiredContext.length || requiredContext.some(type => !CONTEXT_TYPES.has(type))) {
    throw new Error(`requiredContext entries must be unique supported values: ${[...CONTEXT_TYPES].join(", ")}`);
  }

  if (!Array.isArray(contract.rubric) || contract.rubric.length === 0) {
    throw new Error("rubric must be a non-empty array");
  }
  const rubric = contract.rubric.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`rubric[${index}] must be an object`);
    }
    const id = requiredText(item.id, `rubric[${index}].id`);
    if (!RUBRIC_ID.test(id)) throw new Error(`rubric[${index}].id must use lowercase identifiers`);
    return { id, question: requiredText(item.question, `rubric[${index}].question`) };
  });

  if (typeof contract.source !== "string" || !contract.source.trim()) {
    throw new Error("source must identify a package-relative standard file");
  }
  return { standardId, gold, requiredContext, rubric, sourceReference: contract.source };
}

export async function loadSemanticContract({ checkId, packageName, packageVersion, packagePath, contractReference }) {
  const contractRelativePath = packageRelativePath(contractReference, "contract");
  if (!contractRelativePath.endsWith(".json")) throw new Error("contract must identify a package-relative .json file");
  const contractPath = resolve(packagePath, contractRelativePath);
  const { contents: contractBytes, fileRealPath: contractRealPath } = await readPackageFile(
    packagePath,
    contractPath,
    "contract",
    MAX_CONTRACT_BYTES,
  );

  let parsedContract;
  try {
    parsedContract = JSON.parse(contractBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`agentic contract is not valid JSON: ${error.message}`);
  }
  const contract = validateContract(parsedContract, checkId);

  const sourceReference = contract.sourceReference;
  const fragmentIndex = sourceReference.indexOf("#");
  const sourcePathReference = fragmentIndex < 0 ? sourceReference : sourceReference.slice(0, fragmentIndex);
  const fragment = fragmentIndex < 0 ? undefined : sourceReference.slice(fragmentIndex + 1);
  if (fragmentIndex >= 0 && !fragment) throw new Error("source fragment must not be empty");
  const sourceRelativePath = packageRelativePath(sourcePathReference, "source");
  const sourcePath = resolve(packagePath, sourceRelativePath);
  const { contents: sourceBytes, fileRealPath: sourceRealPath } = await readPackageFile(
    packagePath,
    sourcePath,
    "standard source",
    MAX_STANDARD_SOURCE_BYTES,
  );
  const sourceContents = sourceBytes.toString("utf8");
  const section = sourceSection(sourceContents, fragment);
  const packageIdentity = `${packageName}${packageVersion ? `@${packageVersion}` : ""}`;
  const sourceIdentity = `${packageIdentity}:${sourceRelativePath}${fragment ? `#${fragment}` : ""}`;

  return {
    ...contract,
    source: sourceIdentity,
    sourceDetails: {
      package: packageName,
      ...(packageVersion ? { version: packageVersion } : {}),
      path: sourceRelativePath,
      ...(fragment ? { fragment } : {}),
      firstLine: section.firstLine,
      lastLine: section.lastLine,
      text: section.text,
    },
    contractPath: contractRealPath,
    contractRelativePath,
    contractHash: createHashFor(contractBytes),
    sourcePath: sourceRealPath,
    sourceHash: createHashFor(sourceBytes),
  };
}

function createHashFor(contents) {
  return createHash("sha256").update(contents).digest("hex");
}
