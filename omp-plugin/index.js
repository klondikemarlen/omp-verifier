import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const WATCHDOG_FILE = "WATCHDOG.yml";
const VERIFIER_ADVISOR_START = "# omp-verifier: advisor begin";
const VERIFIER_ADVISOR_END = "# omp-verifier: advisor end";
const LEGACY_GENERATED_MARKER = "# omp-verifier: generated";
const VERIFIER_ADVISOR = [
  VERIFIER_ADVISOR_START,
  "  - name: verifier",
  "    instructions: |",
  "      @~/.omp/plugins/node_modules/omp-verifier/WATCHDOG.md",
  VERIFIER_ADVISOR_END,
];

function resolveAgentDir(ctx) {
  return ctx.agentDir || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
}

function withoutVerifierAdvisor(content) {
  return content
    .replace(new RegExp(`${VERIFIER_ADVISOR_START}[\\s\\S]*?${VERIFIER_ADVISOR_END}\\n?`, "g"), "")
    .replace(/\n{3,}/g, "\n\n");
}

function withoutLegacyGeneratedPreamble(content) {
  if (!content.startsWith(`${LEGACY_GENERATED_MARKER}\n`)) return content;
  return content
    .replace(`${LEGACY_GENERATED_MARKER}\n`, "")
    .replace(/^instructions: \|\n(?:  .*\n)*\n/, "");
}

function withVerifierAdvisor(content) {
  const base = withoutLegacyGeneratedPreamble(withoutVerifierAdvisor(content)).trimEnd();
  const lines = (base || "advisors:\n  - name: default").split("\n");
  let advisors = lines.findIndex(line => /^advisors:\s*$/.test(line));

  if (advisors === -1) {
    lines.push("", "advisors:", "  - name: default");
    advisors = lines.length - 2;
  }

  let end = lines.findIndex((line, index) => index > advisors && /^\S/.test(line));
  if (end === -1) end = lines.length;
  let defaultIndex = lines.slice(advisors + 1, end).findIndex(line => /^  - name: default\s*$/.test(line));
  if (defaultIndex === -1) {
    lines.splice(advisors + 1, 0, "  - name: default");
    defaultIndex = 0;
    end += 1;
  }
  defaultIndex += advisors + 1;

  const nextBlock = lines.findIndex((line, index) => index > defaultIndex && line && !/^ {4}/.test(line));
  lines.splice(nextBlock === -1 ? end : nextBlock, 0, "", ...VERIFIER_ADVISOR, "");
  return `${lines.join("\n").replace(/\s*$/, "")}\n`;
}

async function readText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeWatchdogFile(path) {
  const current = await readText(path);
  const next = withVerifierAdvisor(current || "");
  if (next === current) return `kept verifier advisor ${path}`;

  await writeFile(path, next, { flag: current === null ? "wx" : "w" });
  return `${current === null ? "created" : "refreshed"} verifier advisor ${path}`;
}

function removeVerifierAdvisor(content) {
  const next = withoutLegacyGeneratedPreamble(withoutVerifierAdvisor(content));
  return next === content ? null : `${next.trimEnd()}\n`;
}

async function removeWatchdogFile(path) {
  const current = await readText(path);
  if (current === null) return `already absent ${path}`;

  const next = removeVerifierAdvisor(current);
  if (next === null) return `kept setup without verifier advisor ${path}`;
  await writeFile(path, next, { flag: "w" });
  return `removed verifier advisor ${path}`;
}

export async function installGlobalVerifier(ctx) {
  const agentDir = resolveAgentDir(ctx);
  await mkdir(agentDir, { recursive: true });
  return [await writeWatchdogFile(join(agentDir, WATCHDOG_FILE))];
}

export async function uninstall(ctx) {
  return [await removeWatchdogFile(join(resolveAgentDir(ctx), WATCHDOG_FILE))];
}

function advisorNames(content) {
  return [...content.matchAll(/^  - name: (.+)$/gm)].map(([, name]) => name);
}

async function buildStatus(cwd, ctx) {
  const agentDir = resolveAgentDir(ctx);
  const globalPath = join(agentDir, WATCHDOG_FILE);
  const projectPath = join(cwd, WATCHDOG_FILE);
  const [global, project, version] = await Promise.all([
    readText(globalPath),
    readText(projectPath),
    packageVersion(),
  ]);
  const names = global === null ? [] : advisorNames(global);

  return [
    "Verifier status:",
    `plugin version: ${version}`,
    `global roster: ${global === null ? "absent" : names.join(", ") || "no advisors"} — ${globalPath}`,
    `project roster: ${project === null ? "absent" : advisorNames(project).join(", ") || "no advisors"} — ${projectPath}`,
    "runtime state: run /advisor status",
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

const COMMAND_USAGE = "/verifier [status|uninstall]";
const SUBCOMMANDS = [
  { name: "status", description: "Show verifier advisor setup" },
  { name: "uninstall", description: "Remove the verifier advisor" },
];

function completeSubcommands(argumentPrefix) {
  if (argumentPrefix.includes(" ")) return null;
  return SUBCOMMANDS
    .filter(command => command.name.startsWith(argumentPrefix.toLowerCase()))
    .map(command => ({ value: `${command.name} `, label: command.name, description: command.description }));
}

export default function verifierPlugin(pi) {
  pi.setLabel("Verifier");

  pi.on("session_start", async (_event, ctx) => {
    try {
      ctx.ui.notify(`Verifier plugin loaded; ${(await installGlobalVerifier(ctx)).join("; ")}`, "info");
    } catch (error) {
      ctx.ui.notify(`Verifier advisor setup failed: ${error.message}`, "warning");
    }
  });

  pi.registerCommand("verifier", {
    description: "Show verifier advisor setup or remove it",
    getArgumentCompletions: completeSubcommands,
    handler: async (args, ctx) => {
      const [action = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (rest.length) return ctx.ui.notify(`Usage: ${COMMAND_USAGE}`, "error");

      if (action === "status") return ctx.ui.notify(await buildStatus(ctx.cwd || process.cwd(), ctx), "info");
      if (action === "uninstall") return ctx.ui.notify(`Verifier cleanup: ${(await uninstall(ctx)).join("; ")}`, "info");
      return ctx.ui.notify(`Usage: ${COMMAND_USAGE}`, "error");
    },
  });
}
