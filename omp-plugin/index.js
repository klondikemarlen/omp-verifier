import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const WATCHDOG_FILE = "WATCHDOG.md";
const ROSTER_FILE = "WATCHDOG.yml";
const VERIFIER_DIR = "verifier";
const VERIFIER_ADVISOR_START = "# omp-verifier: advisor begin";
const VERIFIER_ADVISOR_END = "# omp-verifier: advisor end";
const LEGACY_GENERATED_MARKER = "# omp-verifier: generated";

function resolveAgentDir(ctx) {
  return ctx.agentDir || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
}

function verifierAdvisor(guidancePath) {
  return [
    VERIFIER_ADVISOR_START,
    "  - name: verifier",
    "    instructions: |",
    `      @${guidancePath}`,
    VERIFIER_ADVISOR_END,
  ];
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

function withVerifierAdvisor(content, guidancePath) {
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
  lines.splice(nextBlock === -1 ? end : nextBlock, 0, "", ...verifierAdvisor(guidancePath), "");
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

async function shippedGuidance() {
  return readFile(new URL("../WATCHDOG.md", import.meta.url), "utf8");
}

async function writeGuidanceFile(path) {
  const content = await shippedGuidance();
  const current = await readText(path);
  if (current === content) return `kept verifier guidance ${path}`;

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { flag: current === null ? "wx" : "w", mode: 0o600 });
  return `${current === null ? "created" : "refreshed"} verifier guidance ${path}`;
}

async function removeGuidanceFile(path) {
  const current = await readText(path);
  if (current === null) return `already absent verifier guidance ${path}`;
  if (current !== await shippedGuidance()) return `kept customized verifier guidance ${path}`;

  await unlink(path);
  return `removed verifier guidance ${path}`;
}

async function writeWatchdogFile(path, guidancePath) {
  const current = await readText(path);
  const next = withVerifierAdvisor(current || "", guidancePath);
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
  const guidancePath = join(agentDir, VERIFIER_DIR, WATCHDOG_FILE);
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  return [
    await writeGuidanceFile(guidancePath),
    await writeWatchdogFile(join(agentDir, ROSTER_FILE), guidancePath),
  ];
}

export async function uninstall(ctx) {
  const agentDir = resolveAgentDir(ctx);
  return [
    await removeWatchdogFile(join(agentDir, ROSTER_FILE)),
    await removeGuidanceFile(join(agentDir, VERIFIER_DIR, WATCHDOG_FILE)),
  ];
}

function advisorNames(content) {
  return [...content.matchAll(/^  - name: (.+)$/gm)].map(([, name]) => name);
}

async function buildStatus(cwd, ctx) {
  const agentDir = resolveAgentDir(ctx);
  const globalPath = join(agentDir, ROSTER_FILE);
  const projectPath = join(cwd, ROSTER_FILE);
  const guidancePath = join(agentDir, VERIFIER_DIR, WATCHDOG_FILE);
  const [global, project, guidance, version] = await Promise.all([
    readText(globalPath),
    readText(projectPath),
    readText(guidancePath),
    packageVersion(),
  ]);
  const names = global === null ? [] : advisorNames(global);

  return [
    "Verifier status:",
    `plugin version: ${version}`,
    `global roster: ${global === null ? "absent" : names.join(", ") || "no advisors"} — ${globalPath}`,
    `project roster: ${project === null ? "absent" : advisorNames(project).join(", ") || "no advisors"} — ${projectPath}`,
    `guidance: ${guidance === null ? "absent" : "installed"} — ${guidancePath}`,
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
