export const LINTER_CATALOG = [
  {
    id: "javascript",
    label: "JavaScript and TypeScript",
    tool: "eslint",
    sources: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue"],
    configs: ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", ".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml"],
  },
  {
    id: "ruby",
    label: "Ruby",
    tool: "rubocop",
    sources: [".rb", ".rake", ".gemspec"],
    configs: [".rubocop.yml"],
  },
  {
    id: "go",
    label: "Go",
    tool: "golangci-lint",
    sources: [".go"],
    configs: [".golangci.yml", ".golangci.yaml"],
  },
  {
    id: "python",
    label: "Python",
    tool: "ruff",
    sources: [".py", ".pyi"],
    configs: ["ruff.toml", ".ruff.toml", "pyproject.toml"],
  },
  {
    id: "shell",
    label: "Shell",
    tool: "shellcheck",
    sources: [".sh", ".bash", ".ksh"],
    configs: [".shellcheckrc"],
  },
];
