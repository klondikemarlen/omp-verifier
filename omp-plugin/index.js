import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
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
const LOCAL_RULES_PREFIX = `# Local Verifier Rules

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
- Do not approve these from compile/type checks alone.`;
const SEMANTIC_STYLE_TEMPLATE = `

## Human-readable code

- Enforced style rules: <formatter, linter, static-analysis command, or local style doc>
- Gold examples: <one or two relevant paths that demonstrate the desired shape>
- Conditional/control-flow rule: <e.g. prefer guard clauses and named intermediate values over nested ternaries>
- Decomposition rule: <e.g. keep each semantic decision or transformation in its own statement>
- Transformation rule: <e.g. split layered map/filter/reduce/callback chains when intermediate meaning is not obvious>
- Style concern evidence: <changed-file lines plus the local rule or Gold example>`;
const LOCAL_RULES_SUFFIX = `

## Local PASS / FAIL / BLOCKED

- PASS: observed evidence proves the changed behavior or invariant.
- FAIL: observed evidence shows a regression, broken invariant, or wrong behavior.
- BLOCKED: a required command, service, seed, credential, or route is unavailable.
`;
const PREVIOUS_LOCAL_RULES_TEMPLATE = `${LOCAL_RULES_PREFIX}${LOCAL_RULES_SUFFIX}`;
const LEGACY_LOCAL_RULES_TEMPLATE = `${LOCAL_RULES_PREFIX}${SEMANTIC_STYLE_TEMPLATE}${LOCAL_RULES_SUFFIX}`;
const LOCAL_RULES_TEMPLATE = `# Local Verifier Rules

Add only explicit project-specific verifier requirements. Each requirement must name:

- the change or release condition that triggers it;
- the behavior or invariant to prove;
- the narrow command or action that proves it; and
- the PASS evidence to observe.

The verifier ignores placeholders and generic guidance.
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

const VERIFIER_ADVISOR_START = "  # omp-verifier: advisor begin\n";
const VERIFIER_ADVISOR_END = "  # omp-verifier: advisor end\n";
const VERIFIER_GUIDANCE_PATH = "@~/.omp/plugins/node_modules/omp-verifier/WATCHDOG.md";
const VERIFIER_ADVISOR = `${VERIFIER_ADVISOR_START}  - name: verifier
    instructions: |
      ${VERIFIER_GUIDANCE_PATH}
      @./WATCHDOG.local.md
${VERIFIER_ADVISOR_END}`;
const WATCHDOG_ROSTER = `${GENERATED_WATCHDOG_MARKER}
instructions: |
  Everyone: keep advice concrete, evidence-first, and non-repetitive.

advisors:
${VERIFIER_ADVISOR}`;

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

const LEGACY_WATCHDOG_ROSTER = WATCHDOG_ROSTER.replace("- name: verifier", "- name: default");
const PREVIOUS_WATCHDOG_ROSTER = WATCHDOG_ROSTER
  .replace(VERIFIER_ADVISOR_START, "")
  .replace(VERIFIER_ADVISOR_END, "");
const GENERATED_WATCHDOGS = [WATCHDOG_ROSTER, LEGACY_WATCHDOG_ROSTER, PREVIOUS_WATCHDOG_ROSTER, OLD_WATCHDOG_ROSTER, SERIALIZED_WATCHDOG_ROSTER];
const GENERATED_LOCAL_RULES = [LOCAL_RULES_TEMPLATE, LEGACY_LOCAL_RULES_TEMPLATE, PREVIOUS_LOCAL_RULES_TEMPLATE, OLD_LOCAL_RULES_TEMPLATE];


function isGeneratedWatchdog(content) {
  return GENERATED_WATCHDOGS.includes(content);
}
function refreshVerifierAdvisor(content) {
  if (!content.startsWith(`${GENERATED_WATCHDOG_MARKER}\n`)) return null;

  const start = content.indexOf(VERIFIER_ADVISOR_START);
  const end = content.indexOf(VERIFIER_ADVISOR_END);
  if (start !== -1 && end !== -1 && end >= start) {
    return `${content.slice(0, start)}${VERIFIER_ADVISOR}${content.slice(end + VERIFIER_ADVISOR_END.length)}`;
  }
  let refreshedLegacy = false;
  const refreshedLegacyAdvisor = content.replace(
    /^  - name: default\n(?:(?: {4,}.*)?\n)*(?=^  (?:- name:|#)|(?![\s\S]))/gm,
    advisor => {
      if (!advisor.includes(VERIFIER_GUIDANCE_PATH)) return advisor;
      refreshedLegacy = true;
      return VERIFIER_ADVISOR;
    },
  );
  if (refreshedLegacy) return refreshedLegacyAdvisor;

  return content.replace("\nadvisors:\n", `\nadvisors:\n${VERIFIER_ADVISOR}`);
}

async function writeWatchdogFile(path, replace = false) {
  const current = await readText(path);
  if (current === null) {
    await writeFile(path, WATCHDOG_ROSTER, { flag: "wx" });
    return `created ${path}`;
  }
  if (replace && !isGeneratedWatchdog(current)) {
    await writeFile(path, WATCHDOG_ROSTER, { flag: "w" });
    return `replaced customized ${path}`;
  }
  const refreshed = refreshVerifierAdvisor(current);
  if (refreshed && refreshed !== current) {
    await writeFile(path, refreshed, { flag: "w" });
    return `refreshed verifier advisor ${path}`;
  }
  if (current === WATCHDOG_ROSTER) return `kept generated ${path}`;
  if (isGeneratedWatchdog(current)) {
    await writeFile(path, WATCHDOG_ROSTER, { flag: "w" });
    return `replaced generated ${path}`;
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
  return `kept customized local rules ${path}`;
}

function removeVerifierAdvisor(content) {
  const start = content.indexOf(VERIFIER_ADVISOR_START);
  const end = content.indexOf(VERIFIER_ADVISOR_END);
  if (start === -1 || end === -1 || end < start) return null;
  return `${content.slice(0, start)}${content.slice(end + VERIFIER_ADVISOR_END.length)}`;
}


async function removeWatchdogFile(path) {
  const current = await readText(path);
  if (current === null) return `already absent ${path}`;
  if (isGeneratedWatchdog(current)) {
    await unlink(path);
    return `removed ${path}`;
  }
  const withoutVerifierAdvisor = removeVerifierAdvisor(current);
  if (withoutVerifierAdvisor !== null) {
    await writeFile(path, withoutVerifierAdvisor, { flag: "w" });
    return `removed verifier advisor ${path}`;
  }
  return `kept customized ${path} (remove verifier block manually)`;
}

export async function installGlobalVerifier(ctx, options = {}) {
  const agentDir = resolveAgentDir(ctx);
  await mkdir(agentDir, { recursive: true });
  return [
    await writeWatchdogFile(join(agentDir, "WATCHDOG.yml"), options.replace),
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
function advisorConfigState(config) {
  if (config === null) return { summary: "absent", enabled: "unknown", model: "unknown" };

  const enabled = /\badvisor:\s*\n(?:.*\n)*?\s+enabled:\s*true\b/.test(config) ? "enabled" : "not enabled";
  const model = /\bmodelRoles:\s*\n(?:.*\n)*?\s+advisor:\s*\S+/.test(config) ? "configured" : "missing";
  return {
    summary: `exists; advisor ${enabled}; modelRoles.advisor ${model}`,
    enabled,
    model,
  };
}
function advisorLabel(advisor, projectConfig) {
  if (projectConfig === "generated" && advisor.summary === "absent") return "enabled via project config; global config absent";
  const global = advisor.summary === "absent" ? "global config absent" : `global ${advisor.enabled}, model ${advisor.model}`;
  return `${global}; project config ${projectConfig}`;
}

async function statusFile(path, generatedContent) {
  return { path, state: await fileState(path, generatedContent) };
}
async function collectStatus(cwd, ctx) {
  const agentDir = resolveAgentDir(ctx);
  const globalConfigPath = join(agentDir, "config.yml");
  const [globalWatchdog, projectWatchdog, projectConfig, globalLocalRules, projectLocalRules, globalConfig] = await Promise.all([
    statusFile(join(agentDir, "WATCHDOG.yml"), GENERATED_WATCHDOGS),
    statusFile(join(cwd, "WATCHDOG.yml"), GENERATED_WATCHDOGS),
    statusFile(join(cwd, ".omp", "config.yml"), ADVISOR_CONFIG),
    statusFile(join(agentDir, LOCAL_RULES_FILE), GENERATED_LOCAL_RULES),
    statusFile(join(cwd, LOCAL_RULES_FILE), GENERATED_LOCAL_RULES),
    readText(globalConfigPath),
  ]);
  const advisor = advisorConfigState(globalConfig);
  const files = {
    globalWatchdog,
    globalConfig: { path: globalConfigPath, summary: advisor.summary },
    globalLocalRules,
    projectWatchdog,
    projectConfig,
    projectLocalRules,
  };

  return {
    cwd,
    agentDir,
    source: sourceLabel(globalWatchdog.state, projectWatchdog.state),
    projectOverride: projectWatchdog.state === "absent" ? "none" : projectWatchdog.state,
    advisor: advisorLabel(advisor, projectConfig.state),
    rules: rulesLabel(globalWatchdog.state, projectWatchdog.state, globalLocalRules.state, projectLocalRules.state),
    files,
  };
}
function formatStatus(status, version) {
  const { cwd, agentDir, source, projectOverride, advisor, rules, files } = status;
  return [
    "Verifier status:",
    `plugin version: ${version}`,
    "static command metadata: global auto-install enabled",
    "runtime advisor state: not directly observable from plugin command; file/config checks below are readiness evidence",
    "",
    `project: ${cwd}`,
    `active agent dir: ${agentDir}`,
    "",
    `verifier source: ${source}`,
    `project override: ${projectOverride}`,
    `advisor: ${advisor}`,
    `rules: ${rules}`,
    "",
    "files:",
    `  global WATCHDOG.yml: ${files.globalWatchdog.state} — ${files.globalWatchdog.path}`,
    `  global config.yml: ${files.globalConfig.summary} — ${files.globalConfig.path}`,
    `  global ${LOCAL_RULES_FILE}: ${files.globalLocalRules.state} — ${files.globalLocalRules.path}`,
    `  project WATCHDOG.yml: ${files.projectWatchdog.state} — ${files.projectWatchdog.path}`,
    `  project .omp/config.yml: ${files.projectConfig.state} — ${files.projectConfig.path}`,
    `  project ${LOCAL_RULES_FILE}: ${files.projectLocalRules.state} — ${files.projectLocalRules.path}`,
  ].join("\n");
}
async function buildStatus(cwd, ctx) {
  const [status, version] = await Promise.all([collectStatus(cwd, ctx), packageVersion()]);
  return formatStatus(status, version);
}

async function packageVersion() {
  try {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}


const COMMAND_USAGE = "/verifier [status|uninstall]";

const SUBCOMMANDS = [
  { name: "status", description: "Show verifier setup status" },
  { name: "uninstall", description: "Safely remove generated verifier files" },
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

export async function uninstall(ctx) {
  return uninstallGlobalVerifier(ctx);
}

export default function verifierPlugin(pi) {
  pi.setLabel("Verifier");

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(`Verifier plugin loaded; ${(await installGlobalVerifier(ctx)).join("; ")}`, "info");
  });

  pi.registerCommand("verifier", {
    description: "Show verifier status or safely remove generated setup",
    getArgumentCompletions: completeSubcommands,
    handler: async (args, ctx) => {
      const [action = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const cwd = ctx.cwd || process.cwd();

      if (action === "status") {
        if (rest.length) ctx.ui.notify(`Usage: ${COMMAND_USAGE}`, "error");
        else ctx.ui.notify(await buildStatus(cwd, ctx), "info");
        return;
      }

      if (action === "uninstall") {
        if (rest.length) ctx.ui.notify(`Usage: ${COMMAND_USAGE}`, "error");
        else ctx.ui.notify(`Safe cleanup complete: ${(await uninstall(ctx)).join("; ")}. Next run: omp plugin uninstall omp-verifier`, "info");
        return;
      }

      ctx.ui.notify(`Usage: ${COMMAND_USAGE}`, "error");
    },
  });
}
