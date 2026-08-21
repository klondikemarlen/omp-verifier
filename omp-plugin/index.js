import {
  buildGlobalVerifierStatus,
  installGlobalVerifier,
  uninstallGlobalVerifier,
} from "#@/omp-plugin/global-verifier.js";
import { discoverVerificationChecks, runVerificationChecks } from "#@/omp-plugin/verifications.js";

const COMMAND_USAGE = "/verifier [status|checks|verify [id...]|uninstall]";
const SUBCOMMANDS = [
  { name: "status", description: "Show verifier advisor setup" },
  { name: "checks", description: "List installed verification checks" },
  { name: "verify", description: "Run installed verification checks" },
  { name: "uninstall", description: "Remove the verifier advisor" },
];

function formatVerificationResult(result) {
  const lines = [`${result.status} ${result.id} — ${result.summary}`];
  if (result.matches) {
    for (const match of result.matches) lines.push(`  trigger: ${match.path} matched ${match.trigger}`);
  }
  if (result.evidence) lines.push(`  evidence: ${result.evidence}`);
  if (result.nextCheck) lines.push(`  next check: ${result.nextCheck}`);
  return lines;
}

async function buildChecks(packageDirectory) {
  const { checks, blockedResults } = await discoverVerificationChecks({ packageDirectory });
  const lines = ["Verifier checks:", `discovered: ${checks.length}`];
  for (const check of checks) lines.push(`${check.id} — ${check.label}: ${check.description}`);
  for (const result of blockedResults) lines.push(...formatVerificationResult(result));
  if (checks.length === 0 && blockedResults.length === 0) lines.push("none installed");
  return lines.join("\n");
}

async function buildVerification(cwd, ids, packageDirectory) {
  const { checks, blockedResults } = await discoverVerificationChecks({ packageDirectory });
  const selectedBlocked = ids.length === 0 ? blockedResults : blockedResults.filter(result => ids.includes(result.id));
  const results = [
    ...selectedBlocked,
    ...(await runVerificationChecks(checks, cwd, ids)),
  ];
  if (results.length === 0) {
    results.push({ id: "verifier", status: "BLOCKED", summary: "No verification checks are installed" });
  }
  return ["Verifier verification:", ...results.flatMap(formatVerificationResult)].join("\n");
}

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
      await installGlobalVerifier(ctx);
    } catch (error) {
      ctx.ui.notify(`Verifier advisor setup failed: ${error.message}`, "warning");
    }
  });

  pi.registerCommand("verifier", {
    description: "Show verifier setup or run installed checks",
    getArgumentCompletions: completeSubcommands,
    handler: async (args, ctx) => {
      const [action = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const cwd = ctx.cwd || process.cwd();
      if (action === "status" && rest.length === 0) {
        return ctx.ui.notify(await buildGlobalVerifierStatus(cwd, ctx), "info");
      }
      if (action === "uninstall" && rest.length === 0) {
        return ctx.ui.notify(`Verifier cleanup: ${(await uninstallGlobalVerifier(ctx)).join("; ")}`, "info");
      }
      if (action === "checks" && rest.length === 0) {
        return ctx.ui.notify(await buildChecks(ctx.verificationPackageDirectory), "info");
      }
      if (action === "verify") {
        return ctx.ui.notify(await buildVerification(cwd, rest, ctx.verificationPackageDirectory), "info");
      }
      return ctx.ui.notify(`Usage: ${COMMAND_USAGE}`, "error");
    },
  });
}
