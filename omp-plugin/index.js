import { mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
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

      You are the always-on verifier for this session.
      Review completed code-change turns as untrusted until evidence proves them.
      Raise a blocker when work is called done without observed evidence.
      Raise a concern when checks are too broad, too narrow, or ignore local setup.
      Stay silent when the evidence is sufficient.

      Project-specific rules can live in downstream WATCHDOG files: setup commands,
      test commands, database/service details, browser routes, and "done means" checks.
`;

function resolveAgentDir(ctx) {
  return ctx.agentDir || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
}

async function writeBootstrapFile(path, content, replace, forceHint = true) {
  try {
    let existed = false;
    if (replace) {
      try { await readFile(path, "utf8"); existed = true; }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    await writeFile(path, content, { flag: replace ? "w" : "wx" });
    return `${replace && existed ? "replaced" : "created"} ${path}`;
  } catch (error) {
    if (error?.code === "EEXIST") return `kept existing ${path}${forceHint ? " (remove it manually to replace)" : " (merge advisor keys manually)"}`;
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

async function installVerifier(cwd) {
  const configDir = join(cwd, ".omp");
  await mkdir(configDir, { recursive: true });
  return [
    await writeBootstrapFile(join(configDir, "config.yml"), ADVISOR_CONFIG, false, false),
    await writeBootstrapFile(join(cwd, "WATCHDOG.yml"), WATCHDOG_ROSTER, true),
    "restart OMP from this repo or run /advisor on",
  ];
}

async function installGlobalVerifier(ctx) {
  const agentDir = resolveAgentDir(ctx);
  await mkdir(agentDir, { recursive: true });
  return [
    await writeBootstrapFile(join(agentDir, "WATCHDOG.yml"), WATCHDOG_ROSTER, true),
    "restart OMP or run /advisor on; ensure modelRoles.advisor is configured",
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

async function uninstallGlobalVerifier(ctx, force) {
  return [await removeBootstrapFile(join(resolveAgentDir(ctx), "WATCHDOG.yml"), WATCHDOG_ROSTER, force)];
}

function parseOptions(tokens, allowForce = true) {
  const allowed = allowForce ? ["local", "global", "--force"] : ["local", "global"];
  const invalid = tokens.find(token => !allowed.includes(token));
  if (invalid) return { error: `unknown option ${invalid}` };
  const scopes = tokens.filter(token => token === "local" || token === "global");
  if (scopes.length > 1) return { error: "choose local or global" };
  return {
    force: allowForce && tokens.includes("--force"),
    global: scopes[0] === "global",
  };
}

const COMMAND_USAGE = "/verifier install [local|global] | /verifier uninstall [local|global] [--force] | /verifier info";


const SUBCOMMANDS = [
  { name: "install", description: "Install verifier advisor files", usage: "[local|global]" },
  { name: "uninstall", description: "Remove generated verifier advisor files", usage: "[local|global] [--force]" },
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
      const options = parseOptions(rest, action !== "install");
      if (options.error) {
        ctx.ui.notify(`Usage: ${COMMAND_USAGE}`, "error");
        return;
      }
      const cwd = ctx.cwd || process.cwd();

      if (action === "install") {
        ctx.ui.notify((await (options.global ? installGlobalVerifier(ctx) : installVerifier(cwd))).join("; "), "info");
        return;
      }

      if (action === "uninstall") {
        ctx.ui.notify((await (options.global ? uninstallGlobalVerifier(ctx, options.force) : uninstallVerifier(cwd, options.force))).join("; "), "info");
        return;
      }

      if (action === "info") {
        ctx.ui.notify(`Verifier: ${COMMAND_USAGE}`, "info");
        return;
      }

      ctx.ui.notify(`Usage: ${COMMAND_USAGE}`, "error");
    },
  });
}
