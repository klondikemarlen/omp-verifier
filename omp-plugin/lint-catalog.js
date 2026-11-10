export const LINTER_CATALOG = [
  {
    id: "javascript",
    label: "JavaScript and TypeScript",
    sources: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue"],
    tools: [
      { id: "eslint", configs: ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", ".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml"] },
      { id: "oxlint", configs: [".oxlintrc.json", "oxlint.config.ts"] },
    ],
  },
  {
    id: "ruby",
    label: "Ruby",
    sources: [".rb", ".rake", ".gemspec"],
    tools: [{ id: "rubocop", configs: [".rubocop.yml"] }],
  },
  {
    id: "go",
    label: "Go",
    sources: [".go"],
    tools: [{ id: "golangci-lint", configs: [".golangci.yml", ".golangci.yaml"] }],
  },
  {
    id: "python",
    label: "Python",
    sources: [".py", ".pyi"],
    tools: [
      { id: "ruff", configs: ["ruff.toml", ".ruff.toml", "pyproject.toml"] },
      { id: "pyflakes", configs: [] },
    ],
  },
  {
    id: "shell",
    label: "Shell",
    sources: [".sh", ".bash", ".ksh"],
    tools: [{ id: "shellcheck", configs: [".shellcheckrc"] }],
  },
];
