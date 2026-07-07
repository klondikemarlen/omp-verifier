import { mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ADVISOR_CONFIG = `advisor:
  enabled: true
  subagents: true
  syncBacklog: 1
`;

const WATCHDOG_ROSTER = `instructions: |
  Everyone: keep advice concrete, evidence-first, and non-repetitive.

advisors:
  - name: default

  - name: Verifier
    tools: [read, grep, glob]
    instructions: |
      @~/.omp/plugins/node_modules/omp-verifier/WATCHDOG.md

      You are the always-on verifier for this project.
      Review completed code-change turns as untrusted until evidence proves them.
      Raise a blocker when work is called done without observed evidence.
      Raise a concern when checks are too broad, too narrow, or ignore local setup.
      Stay silent when the evidence is sufficient.

      Downstream project rules belong below this import: setup commands, test commands,
      database/service details, browser routes, and project-specific "done means" checks.
`;

async function writeBootstrapFile(path, content, force, forceHint = true) {
  try {
    await writeFile(path, content, { flag: force ? "w" : "wx" });
    return `${force ? "replaced" : "created"} ${path}`;
  } catch (error) {
    if (error?.code === "EEXIST") return `kept existing ${path}${forceHint ? " (rerun with --force to replace)" : " (merge advisor keys manually)"}`;
    throw error;
  }
}

async function removeBootstrapFile(path, expectedContent, force = false) {
  try {
    const current = await readFile(path, "utf8");
    if (current === expectedContent || force) {
      await unlink(path);
      return `removed ${path}`;
    }
    return `kept customized ${path} (remove verifier block manually)`;
  } catch (error) {
    if (error?.code === "ENOENT") return `already absent ${path}`;
    throw error;
  }
}

async function installVerifier(cwd, force) {
  const configDir = join(cwd, ".omp");
  await mkdir(configDir, { recursive: true });
  return [
    await writeBootstrapFile(join(configDir, "config.yml"), ADVISOR_CONFIG, false, false),
    await writeBootstrapFile(join(cwd, "WATCHDOG.yml"), WATCHDOG_ROSTER, force),
    "restart OMP from this repo or run /advisor on",
  ];
}

async function uninstallVerifier(cwd, force) {
  const configDir = join(cwd, ".omp");
  const results = [
    await removeBootstrapFile(join(cwd, "WATCHDOG.yml"), WATCHDOG_ROSTER, force),
    await removeBootstrapFile(join(configDir, "config.yml"), ADVISOR_CONFIG, false),
  ];

  try { await rmdir(configDir); results.push(`removed empty ${configDir}`); }
  catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes(error?.code)) throw error; }

  return results;
}

const SUBCOMMANDS = [
  { name: "install", description: "Install verifier advisor files", usage: "[--force]" },
  { name: "uninstall", description: "Remove generated verifier advisor files", usage: "[--force]" },
  { name: "info", description: "Show verifier command help" },
];

function completeSubcommands(argumentPrefix) {
  if (argumentPrefix.includes(" ")) return null;
  const lower = argumentPrefix.toLowerCase();
  const matches = SUBCOMMANDS
    .filter(command => command.name.startsWith(lower))
    .map(command => ({
      value: `${command.name} `,
      label: command.name,
      description: command.description,
      hint: command.usage,
    }));
  return matches.length ? matches : null;
}

export default function verifierPlugin(pi) {
  pi.setLabel("Verifier");

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Verifier plugin loaded", "info");
  });

  pi.registerCommand("verifier", {
    description: "Install or uninstall omp-verifier advisor injection",
    getArgumentCompletions: completeSubcommands,
    handler: async (args, ctx) => {
      const [action = "info", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const force = rest.includes("--force");
      const cwd = ctx.cwd || process.cwd();

      if (action === "install") {
        ctx.ui.notify((await installVerifier(cwd, force)).join("; "), "info");
        return;
      }

      if (action === "uninstall") {
        ctx.ui.notify((await uninstallVerifier(cwd, force)).join("; "), "info");
        return;
      }

      if (action === "info") {
        ctx.ui.notify("Verifier: /verifier install [--force] | /verifier uninstall [--force] | /verifier info", "info");
        return;
      }

      ctx.ui.notify("Usage: /verifier install [--force] | /verifier uninstall [--force] | /verifier info", "error");
    },
  });
}
