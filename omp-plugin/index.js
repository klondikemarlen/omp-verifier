import { mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const ADVISOR_CONFIG = `advisor:
  enabled: true
  subagents: true
  syncBacklog: 1
`;

const GENERATED_WATCHDOG_MARKER = "# omp-verifier: generated";
const LOCAL_RULES_FILE = "WATCHDOG.local.md";
const OLD_LOCAL_RULES_TEMPLATE = `# Local Verifier Rules

Add project-specific verifier rules here: setup commands, test commands, services, database details, browser routes, seed data, and local definitions of done.
`;
const LOCAL_RULES_TEMPLATE = `# Local Verifier Rules

Replace placeholders with commands from this repo. Keep uncertain entries as suggestions.

## Project setup

- Install dependencies: <repo command>
- Start services: <repo command for database/cache/queue/app server>
- Apply migrations: <repo command>
- Seed data: <repo command or fixture/account name>

## Targeted checks

- Unit or API change: <focused test command>
- Typecheck/build: <typecheck or build command>
- Migration change: <migration verification command>

## Browser/UI smoke

- Route: <local route>
- Action: <user-visible flow>
- Expected evidence: <visible label, URL, screenshot path, or state>

## High-risk areas

- Auth, billing, migrations, permissions, admin flows, and data deletion require focused checks.
- Do not approve these from compile/type checks alone.

## Local PASS / FAIL / BLOCKED

- PASS: observed evidence proves the changed behavior or invariant.
- FAIL: observed evidence shows a regression, broken invariant, or wrong behavior.
- BLOCKED: a required command, service, seed, credential, or route is unavailable.
`;

const OLD_WATCHDOG_ROSTER = `instructions: |
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

const WATCHDOG_ROSTER = `${GENERATED_WATCHDOG_MARKER}
instructions: |
  Everyone: keep advice concrete, evidence-first, and non-repetitive.

advisors:
  - name: default
    tools: [read, grep, glob]
    instructions: |
      @~/.omp/plugins/node_modules/omp-verifier/WATCHDOG.md
      @./WATCHDOG.local.md

      You are the always-on verifier for this session.
      Review completed code-change turns as untrusted until evidence proves them.
      Raise a blocker when work is called done without observed evidence.
      Raise a concern when checks are too broad, too narrow, or ignore local setup.
      When the evidence is sufficient, do not call the advice tool; reply with "No advice."

      Project-specific rules can live in downstream WATCHDOG files: setup commands,
      test commands, database/service details, browser routes, and "done means" checks.
`;

function resolveAgentDir(ctx) {
  return ctx.agentDir || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
}


const SERIALIZED_WATCHDOG_ROSTER = `instructions: "Everyone: keep advice concrete, evidence-first, and non-repetitive.\\n"
advisors: 
  - name: default
    tools: 
      - read
      - grep
      - glob
    instructions: "@~/.omp/plugins/node_modules/omp-verifier/WATCHDOG.md\\n\\nYou are the always-on verifier for this session.\\nReview completed code-change turns as untrusted until evidence proves them.\\nRaise a blocker when work is called done without observed evidence.\\nRaise a concern when checks are too broad, too narrow, or ignore local setup.\\nStay silent when the evidence is sufficient.\\n\\nProject-specific rules can live in downstream WATCHDOG files: setup commands,\\ntest commands, database/service details, browser routes, and \\"done means\\" checks.\\n"
`;

const GENERATED_WATCHDOGS = [WATCHDOG_ROSTER, OLD_WATCHDOG_ROSTER, SERIALIZED_WATCHDOG_ROSTER];
const GENERATED_LOCAL_RULES = [LOCAL_RULES_TEMPLATE, OLD_LOCAL_RULES_TEMPLATE];


function isGeneratedWatchdog(content) {
  return GENERATED_WATCHDOGS.includes(content);
}

async function writeWatchdogFile(path, replace = false) {
  const current = await readText(path);
  if (current === null) {
    await writeFile(path, WATCHDOG_ROSTER, { flag: "wx" });
    return `created ${path}`;
  }
  if (current === WATCHDOG_ROSTER) return `kept generated ${path}`;
  if (isGeneratedWatchdog(current) || replace) {
    await writeFile(path, WATCHDOG_ROSTER, { flag: "w" });
    return `${replace && !isGeneratedWatchdog(current) ? "replaced customized" : "replaced generated"} ${path}`;
  }
  return `kept customized ${path} (rerun with replace to overwrite)`;
}
async function writeLocalRulesFile(path, replace = false) {
  const current = await readText(path);
  if (current === null) {
    await writeFile(path, LOCAL_RULES_TEMPLATE, { flag: "wx" });
    return `created local rules ${path}`;
  }
  if (current === LOCAL_RULES_TEMPLATE) return `kept generated local rules ${path}`;
  if (GENERATED_LOCAL_RULES.includes(current) || replace) {
    await writeFile(path, LOCAL_RULES_TEMPLATE, { flag: "w" });
    return `${replace && !GENERATED_LOCAL_RULES.includes(current) ? "replaced customized" : "replaced generated"} local rules ${path}`;
  }
  return `kept customized local rules ${path} (rerun /verifier init-local replace to overwrite)`;
}


async function removeWatchdogFile(path) {
  const current = await readText(path);
  if (current === null) return `already absent ${path}`;
  if (isGeneratedWatchdog(current)) {
    await unlink(path);
    return `removed ${path}`;
  }
  return `kept customized ${path} (remove verifier block manually)`;
}

async function installGlobalVerifier(ctx, options = {}) {
  const agentDir = resolveAgentDir(ctx);
  await mkdir(agentDir, { recursive: true });
  return [
    await writeWatchdogFile(join(agentDir, "WATCHDOG.yml"), options.replace ?? true),
    await writeLocalRulesFile(join(agentDir, LOCAL_RULES_FILE)),
    "restart OMP or run /advisor on; ensure modelRoles.advisor is configured",
  ];
}

async function removeLocalRulesFile(path) {
  const current = await readText(path);
  if (current === null) return `already absent local rules ${path}`;
  if (GENERATED_LOCAL_RULES.includes(current)) {
    await unlink(path);
    return `removed local rules ${path}`;
  }
  return `kept customized local rules ${path}`;
}

async function uninstallGlobalVerifier(ctx) {
  const agentDir = resolveAgentDir(ctx);
  return [
    await removeWatchdogFile(join(agentDir, "WATCHDOG.yml")),
    await removeLocalRulesFile(join(agentDir, LOCAL_RULES_FILE)),
  ];
}

async function readText(path) {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
async function fileState(path, generatedContent) {
  const content = await readText(path);
  const generated = Array.isArray(generatedContent) ? generatedContent.includes(content) : generatedContent && content === generatedContent;
  if (content === null) return "absent";
  if (generated) return "generated";
  return "customized";
}

function sourceLabel(globalState, projectState) {
  if (globalState !== "absent" && projectState !== "absent") return `global + project ${projectState} override`;
  if (projectState !== "absent") return "project";
  if (globalState !== "absent") return "global";
  return "none";
}

function rulesLabel(...states) {
  if (states.includes("customized")) return "customized";
  if (states.includes("generated")) return "generated";
  return "none";
}
function advisorLabel(globalConfig, advisorEnabled, advisorModel, projectConfig) {
  if (projectConfig === "generated" && globalConfig === null) return "enabled via project config; global config absent";
  const global = globalConfig === null ? "global config absent" : `global ${advisorEnabled}, model ${advisorModel}`;
  return `${global}; project config ${projectConfig}`;
}

async function buildStatus(cwd, ctx) {
  const agentDir = resolveAgentDir(ctx);
  const globalWatchdogPath = join(agentDir, "WATCHDOG.yml");
  const globalConfigPath = join(agentDir, "config.yml");
  const projectWatchdogPath = join(cwd, "WATCHDOG.yml");
  const projectConfigPath = join(cwd, ".omp", "config.yml");
  const globalWatchdog = await fileState(globalWatchdogPath, GENERATED_WATCHDOGS);
  const projectWatchdog = await fileState(projectWatchdogPath, GENERATED_WATCHDOGS);
  const projectConfig = await fileState(projectConfigPath, ADVISOR_CONFIG);
  const globalLocalRulesPath = join(agentDir, LOCAL_RULES_FILE);
  const projectLocalRulesPath = join(cwd, LOCAL_RULES_FILE);
  const globalLocalRules = await fileState(globalLocalRulesPath, GENERATED_LOCAL_RULES);
  const projectLocalRules = await fileState(projectLocalRulesPath, GENERATED_LOCAL_RULES);
  const globalConfig = await readText(globalConfigPath);
  const advisorEnabled = globalConfig === null ? "unknown" : /\badvisor:\s*\n(?:.*\n)*?\s+enabled:\s*true\b/.test(globalConfig) ? "enabled" : "not enabled";
  const advisorModel = globalConfig === null ? "unknown" : /\bmodelRoles:\s*\n(?:.*\n)*?\s+advisor:\s*\S+/.test(globalConfig) ? "configured" : "missing";
  const globalConfigSummary = globalConfig === null ? "absent" : `exists; advisor ${advisorEnabled}; modelRoles.advisor ${advisorModel}`;
  return [
    "Verifier status:",
    `plugin version: ${await packageVersion()}`,
    "static command metadata: global auto-install enabled",
    "runtime advisor state: not directly observable from plugin command; file/config checks below are readiness evidence",
    "",
    `project: ${cwd}`,
    `active agent dir: ${agentDir}`,
    "",
    `verifier source: ${sourceLabel(globalWatchdog, projectWatchdog)}`,
    `project override: ${projectWatchdog === "absent" ? "none" : projectWatchdog}`,
    `advisor: ${advisorLabel(globalConfig, advisorEnabled, advisorModel, projectConfig)}`,
    `rules: ${rulesLabel(globalWatchdog, projectWatchdog, globalLocalRules, projectLocalRules)}`,
    "",
    "files:",
    `  global WATCHDOG.yml: ${globalWatchdog} — ${globalWatchdogPath}`,
    `  global config.yml: ${globalConfigSummary} — ${globalConfigPath}`,
    `  global ${LOCAL_RULES_FILE}: ${globalLocalRules} — ${globalLocalRulesPath}`,
    `  project WATCHDOG.yml: ${projectWatchdog} — ${projectWatchdogPath}`,
    `  project .omp/config.yml: ${projectConfig} — ${projectConfigPath}`,
    `  project ${LOCAL_RULES_FILE}: ${projectLocalRules} — ${projectLocalRulesPath}`,
  ].join("\n");
}

async function packageVersion() {
  try {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}



function parseInstallOptions(tokens) {
  const invalid = tokens.find(token => !["global", "replace"].includes(token));
  if (invalid) return { error: `unknown option ${invalid}` };
  return { replace: true };
}
function parseUninstallOptions(tokens) {
  const invalid = tokens.find(token => token !== "global");
  if (invalid) return { error: `unknown option ${invalid}` };
  return {};
}
function parseInitLocalOptions(tokens) {
  const replace = tokens.includes("replace");
  const invalid = tokens.find(token => token !== "replace");
  if (invalid) return { error: `unknown option ${invalid}` };
  return { replace };
}


const COMMAND_USAGE = "/verifier install [replace] | /verifier init-local [replace] | /verifier uninstall | /verifier status";


const SUBCOMMANDS = [
  { name: "install", description: "Install global verifier advisor files", usage: "[replace]" },
  { name: "init-local", description: "Scaffold project-local verifier guidance", usage: "[replace]" },
  { name: "uninstall", description: "Remove global verifier advisor files" },
  { name: "status", description: "Show verifier setup status" },
];

function completeSubcommands(argumentPrefix) {
  if (argumentPrefix.includes(" ")) {
    const tokens = argumentPrefix.split(/\s+/);
    const [action] = tokens;
    if (["install", "init-local"].includes(action)) {
      if (tokens.length <= 2) {
        return "replace".startsWith((tokens[1] || "").toLowerCase()) ? [{ value: `${action} replace `, label: "replace", description: action === "install" ? "Refresh global WATCHDOG.yml" : "Overwrite customized WATCHDOG.local.md" }] : null;
      }
      return null;
    }
    return null;
  }

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

export async function uninstall(ctx) {
  await uninstallGlobalVerifier(ctx);
}

export default function verifierPlugin(pi) {
  pi.setLabel("Verifier");

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(`Verifier plugin loaded; ${(await installGlobalVerifier(ctx, { replace: true })).join("; ")}`, "info");
  });

  pi.registerCommand("verifier", {
    description: "Install or uninstall omp-verifier advisor injection",
    getArgumentCompletions: completeSubcommands,
    handler: async (args, ctx) => {
      const [action = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const cwd = ctx.cwd || process.cwd();

      if (action === "status") {
        if (rest.length) ctx.ui.notify(`Usage: ${COMMAND_USAGE}`, "error");
        else ctx.ui.notify(await buildStatus(cwd, ctx), "info");
        return;
      }

      if (action === "init-local") {
        const options = parseInitLocalOptions(rest);
        if (options.error) ctx.ui.notify(`Usage: ${COMMAND_USAGE}`, "error");
        else ctx.ui.notify(await writeLocalRulesFile(join(cwd, LOCAL_RULES_FILE), options.replace), "info");
        return;
      }

      if (action === "install") {
        const options = parseInstallOptions(rest);
        if (options.error) ctx.ui.notify(`Usage: ${COMMAND_USAGE}`, "error");
        else ctx.ui.notify((await installGlobalVerifier(ctx, options)).join("; "), "info");
        return;
      }

      if (action === "uninstall") {
        const options = parseUninstallOptions(rest);
        if (options.error) ctx.ui.notify(`Usage: ${COMMAND_USAGE}`, "error");
        else ctx.ui.notify((await uninstallGlobalVerifier(ctx)).join("; "), "info");
        return;
      }

      ctx.ui.notify(`Usage: ${COMMAND_USAGE}`, "error");
    },
  });
}
