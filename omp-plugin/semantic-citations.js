import { normalizedProjectPath } from "#root/omp-plugin/semantic-project-source.js";

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

export default validateSemanticCitations;
