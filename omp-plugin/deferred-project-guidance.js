import { posix } from "node:path";

const REFERENCE_GUIDE_NAMES = new Set(["README.md", "WATCHDOG.md", "CONTRIBUTING.md"]);
const MAX_HEADINGS_PER_GUIDE = 8;
const MAX_TOTAL_HEADINGS = 24;
const MAX_HEADING_LENGTH = 120;

export function deferredProjectGuidance({ config, guidancePaths, changedPaths, selectedPaths, availableText, includeHeadings = true }) {
  const referenceGuides = declaredReferenceGuides(config);
  if (!referenceGuides?.size) return undefined;

  const bindingPaths = new Set([...changedPaths, ...selectedPaths].map(path => posix.normalize(path)));
  const guides = new Map();
  let remainingHeadings = MAX_TOTAL_HEADINGS;
  for (const path of guidancePaths) {
    if (!referenceGuides.has(path) || bindingPaths.has(path)) continue;
    if (!includeHeadings) {
      guides.set(path, { path });
      continue;
    }

    const content = availableText.get(path);
    if (content === undefined) continue;

    const headings = sectionHeadings(content, Math.min(MAX_HEADINGS_PER_GUIDE, remainingHeadings));
    remainingHeadings -= headings.length;
    guides.set(path, { path, headings });
  }
  if (!guides.size) return undefined;

  return guides;
}

function declaredReferenceGuides(config) {
  let paths;
  try {
    paths = JSON.parse(config)?.review?.referenceGuides;
  } catch {
    return undefined;
  }
  if (!Array.isArray(paths) || !paths.every(isReferenceGuidePath)) return undefined;

  return new Set(paths);
}

function isReferenceGuidePath(path) {
  if (typeof path !== "string" || !REFERENCE_GUIDE_NAMES.has(posix.basename(path))) return false;
  if (/^[a-z]:|\p{Cc}/iu.test(path) || ["\\", "*", "?", "[", "]", "{", "}"].some(character => path.includes(character))) {
    return false;
  }

  return path === path.trim() && path.split("/").every(part => part && part !== "." && part !== "..");
}

function sectionHeadings(content, limit) {
  const headings = [];
  if (!limit) return headings;

  let activeFence;
  let inComment = false;
  let line = 0;
  for (const text of content.split(/\r?\n/)) {
    line += 1;
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (activeFence) {
      if (fence && fence[1][0] === activeFence[0] && fence[1].length >= activeFence.length && !fence[2].trim()) {
        activeFence = undefined;
      }
      continue;
    }
    if (inComment || text.includes("<!--")) {
      inComment = !text.includes("-->");
      continue;
    }
    if (fence) {
      activeFence = fence[1];
      continue;
    }
    const match = /^ {0,3}#{1,6}[ \t]+(.+)$/.exec(text);
    if (!match) continue;

    const heading = match[1].replace(/(?:^|[ \t]+)#+[ \t]*$/, "").trim();
    if (!heading || heading.length > MAX_HEADING_LENGTH) continue;

    headings.push({ line, heading });
    if (headings.length === limit) break;
  }
  return headings;
}

export default deferredProjectGuidance;
