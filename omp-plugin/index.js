import {
  buildGlobalVerifierStatus,
  installGlobalVerifier,
  uninstallGlobalVerifier,
} from "#root/omp-plugin/global-verifier.js";
import { formatVerificationInventory, formatVerificationResults } from "#root/omp-plugin/reporters.js";
import { discoverVerificationChecks, runInstalledVerificationChecks } from "#root/omp-plugin/verifications.js";

const COMMAND_USAGE = "/verifier [status|checks|verify [id...]|uninstall]";
const SUBCOMMANDS = [
  { name: "status", description: "Show verifier advisor setup" },
  { name: "checks", description: "List installed verification checks" },
  { name: "verify", description: "Run installed verification checks" },
  { name: "uninstall", description: "Remove the verifier advisor" },
];

async function buildChecks(packageDirectory) {
  return formatVerificationInventory(await discoverVerificationChecks({ packageDirectory }));
}

async function buildVerification(cwd, ids, packageDirectory) {
  const results = await runInstalledVerificationChecks({ cwd, ids, packageDirectory });
  return `Verifier verification:\n${formatVerificationResults(results)}`;
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
