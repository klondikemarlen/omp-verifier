import { basename, dirname, extname } from "node:path";

const CODE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".go", ".h", ".java", ".js", ".jsx", ".mjs", ".cjs", ".kt", ".mts", ".php",
  ".py", ".rb", ".rs", ".ts", ".tsx", ".vue", ".svelte",
]);

export function codeFile(path) {
  return CODE_EXTENSIONS.has(extname(path).toLowerCase());
}

export function discoverSourceCandidates({ changedPaths, selectedInventoryPaths, availableText }) {
  const callerMatches = new Set();
  const siblingPaths = new Set();

  for (const changedPath of changedPaths) {
    const stem = basename(changedPath).replace(/\.[^.]+$/, "");
    const changedDirectory = dirname(changedPath);

    for (const path of selectedInventoryPaths) {
      if (changedPaths.includes(path) || !codeFile(path)) continue;
      const content = availableText.get(path);
      if (content === undefined) continue;
      if (dirname(path) === changedDirectory) siblingPaths.add(path);
      if (stem && content.includes(stem)) callerMatches.add(path);
    }
  }
  return { callerMatches, siblingPaths };
}
