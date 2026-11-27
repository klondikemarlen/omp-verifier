import { basename, dirname, extname } from "node:path";

export const MAX_CALLER_LINE_BYTES = 600;

const CODE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".go", ".h", ".java", ".js", ".jsx", ".mjs", ".cjs", ".kt", ".mts", ".php",
  ".py", ".rb", ".rs", ".ts", ".tsx", ".vue", ".svelte",
]);

export function codeFile(path) {
  return CODE_EXTENSIONS.has(extname(path).toLowerCase());
}

export function discoverSourceCandidates({ changedPaths, selectedInventoryPaths, availableText }) {
  const callerMatches = new Map();
  const siblingPaths = new Set();
  const changedStems = changedPaths.map(path => basename(path).replace(/\.[^.]+$/, ""));

  for (const [index, changedPath] of changedPaths.entries()) {
    const stem = changedStems[index];
    const changedDirectory = dirname(changedPath);
    const multiLineStem = stem.includes("\n");

    for (const path of selectedInventoryPaths) {
      if (changedPaths.includes(path) || !codeFile(path)) continue;
      const content = availableText.get(path);
      if (content === undefined) continue;
      if (dirname(path) === changedDirectory) siblingPaths.add(path);
      if (!stem) continue;

      const matchOffset = content.indexOf(stem);
      if (matchOffset === -1) continue;

      // Keep multiline matches discoverable without treating them as excerptable.
      const lineMatchOffset = multiLineStem ? Infinity : matchOffset;
      const previousMatch = callerMatches.get(path);
      if (previousMatch === undefined || lineMatchOffset < previousMatch) {
        callerMatches.set(path, lineMatchOffset);
      }
    }
  }
  return { callerMatches, siblingPaths, changedStems };
}

export function callerLineExcerpt(content, matchOffset, sourceHash) {
  if (matchOffset === Infinity) {
    return { bytes: 0, error: "filename stem spans multiple lines; select material ranges with review --context" };
  }

  const start = matchOffset === 0 ? 0 : content.lastIndexOf("\n", matchOffset - 1) + 1;
  const newline = content.indexOf("\n", matchOffset);
  let end = newline === -1 ? content.length : newline;
  if (newline !== -1 && content[end - 1] === "\r") end -= 1;

  const line = content.slice(start, end);
  const bytes = Buffer.byteLength(line);
  if (bytes > MAX_CALLER_LINE_BYTES) {
    return { bytes, error: `first matching source line exceeds the ${MAX_CALLER_LINE_BYTES}-byte caller excerpt limit; select material ranges with review --context` };
  }

  let startLine = 1;
  let lineCount = 1;
  for (let offset = content.indexOf("\n"); offset !== -1; offset = content.indexOf("\n", offset + 1)) {
    if (offset < start) startLine += 1;
    lineCount += 1;
  }
  return { content: line, sha256: sourceHash, lineCount, startLine, endLine: startLine, partial: lineCount > 1 };
}
