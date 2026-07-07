export function formatPrComment({ verdict, evidence = [], risks = [] }) {
  return [
    `## Verifier verdict: ${verdict}`,
    "",
    "### Evidence",
    ...(evidence.length ? evidence.map((item) => `- ${item}`) : ["- none recorded"]),
    "",
    "### Risks",
    ...(risks.length ? risks.map((item) => `- ${item}`) : ["- none recorded"]),
  ].join("\n");
}
