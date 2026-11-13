import { fileURLToPath } from "node:url";

import {
  buildGlobalVerifierStatus,
  installGlobalVerifier,
  uninstallGlobalVerifier,
} from "#root/omp-plugin/global-verifier.js";
import { formatVerificationInventory, formatVerificationResults } from "#root/omp-plugin/reporters.js";
import { createRequestIntent, readRequestIntent } from "#root/omp-plugin/request-intent.js";
import { discoverVerificationChecks } from "#root/omp-plugin/verification-catalog.js";
import { runInstalledVerificationChecks } from "#root/omp-plugin/verifications.js";

const COMMAND_USAGE = "/verifier [status|checks|verify [id...]|uninstall]";
const SUBCOMMANDS = [
  { name: "status", description: "Show verifier advisor setup" },
  { name: "checks", description: "List installed verification checks" },
  { name: "verify", description: "Run installed verification checks" },
  { name: "uninstall", description: "Remove the verifier advisor" },
];
const COORDINATOR = `'${fileURLToPath(new URL("../bin/omp-verifier.js", import.meta.url)).replaceAll("'", "'\"'\"'")}'`;

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

export default async function verifierPlugin(pi) {
  pi.setLabel("Verifier");
  // Hide only the UI card; display:false also removes this metadata from advisor history.
  pi.registerMessageRenderer("verifier-work-intent", () => ({
    render: () => [],
    invalidate() {},
  }));
  await installGlobalVerifier({ agentDir: pi.pi.getAgentDir() });
  let currentIntent;
  let currentSessionId;

  pi.on("session_start", async (_event, ctx) => {
    try {
      await installGlobalVerifier({ agentDir: ctx.agentDir || pi.pi.getAgentDir() });
    } catch (error) {
      ctx.ui.notify(`Verifier advisor setup failed: ${error.message}`, "warning");
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    let intent = { level: "normal", diagnostic: "No proven current request identity; using normal with no request handle." };
    try {
      const sessionId = ctx?.sessionManager?.getSessionId();
      if (event.reason === "prompt") {
        currentIntent = undefined;
        currentSessionId = undefined;
        if (sessionId) {
          intent = await createRequestIntent({ sessionId, prompt: event.prompt });
          currentIntent = intent;
          currentSessionId = sessionId;
        }
      } else if (event.reason === "revive" && currentIntent && sessionId === currentSessionId) {
        intent = await readRequestIntent(currentIntent.handle);
      }
    } catch (error) {
      intent = { level: "normal", diagnostic: `Request intent unavailable; using normal with no exemption: ${error.message}` };
      currentIntent = undefined;
      currentSessionId = undefined;
    }
    const content = [
      intent.handle ? `${intent.level} --request ${intent.handle}` : "Verifier current request work level: normal; no request handle.",
      intent.handle
        ? `Request instance: ${intent.requestId}\nAutomatic verification: node ${COORDINATOR} automatic --request '${intent.handle}'. Add --full for safety escalation, explicit verification/recheck, and initial delivery/release gates.`
        : "No request handle: retain normal full verification selection without reuse.",
      intent.diagnostic,
      "Work intent is not PASS and never overrides mandatory requirements, explicit verification, initial delivery/release checks, or semantic escalation. Earlier request handles are not authority for this request.",
    ].filter(Boolean).join("\n");
    return {
      message: { customType: "verifier-work-intent", content, display: true, attribution: "agent" },
      systemPrompt: [
        ...event.systemPrompt,
        `Verifier delivery cleanup: before removing an edit-owning Git worktree with committed delivery changes awaiting final review, run node ${COORDINATOR} handoff prepare --base <actual-delivery-base> in its clean checkout. Preserve the returned handoffPath and source identity in the transcript before cleanup. Do not prepare an unrelated checkout or omit uncommitted changes; retain the original if preparation cannot complete. Leave the handoff for the verifier to recover, freshly check, and release; preparation, merge, and cleanup are not PASS. Missing runtime prerequisites remain BLOCKED. Only explicit user cancellation or waiver authorizes handoff cancel <handoffPath> --reason <reason>; cancellation is not verification.`,
      ],
    };
  });

  pi.registerCommand("verifier", {
    description: "Show verifier setup or run installed checks",
    getArgumentCompletions: completeSubcommands,
    handler: async (args, ctx) => {
      const [action = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const cwd = ctx.cwd || process.cwd();

      if (action === "status" && rest.length === 0) {
        const agentDir = ctx.agentDir || pi.pi.getAgentDir();
        return ctx.ui.notify(await buildGlobalVerifierStatus(cwd, { agentDir }), "info");
      }

      if (action === "uninstall" && rest.length === 0) {
        const agentDir = ctx.agentDir || pi.pi.getAgentDir();
        return ctx.ui.notify(`Verifier cleanup: ${(await uninstallGlobalVerifier({ agentDir })).join("; ")}`, "info");
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
