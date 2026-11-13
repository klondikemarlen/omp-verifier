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

const COMMAND_USAGE = "/verifier [status|checks|verify [id...]|demo|uninstall]";
const SUBCOMMANDS = [
  { name: "status", description: "Show verifier advisor setup" },
  { name: "checks", description: "List installed verification checks" },
  { name: "verify", description: "Run installed verification checks" },
  { name: "demo", description: "Preview actual advisor cards without running checks" },
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

async function showDemo(ctx) {
  if (!ctx.hasUI) {
    return ctx.ui.notify("Verifier demo requires an interactive OMP terminal.", "warning");
  }

  let advisor;
  let ui;
  try {
    [advisor, ui] = await Promise.all([
      import("@oh-my-pi/pi-tui/chat/advisor-message"),
      import("@oh-my-pi/pi-tui"),
    ]);
    if (typeof advisor.createAdvisorMessageCard !== "function") {
      throw new Error("OMP does not export its advisor-card renderer.");
    }
  } catch (error) {
    return ctx.ui.notify(`Verifier demo unavailable: ${error.message}`, "warning");
  }

  const samples = [
    {
      id: "demo:fail",
      status: "FAIL",
      summary: "Sample check found a violation.",
      evidence: "Sample: an unused variable was found in example.js.",
      nextCheck: "Example action: remove the unused variable and rerun the check.",
    },
    {
      id: "demo:blocked",
      status: "BLOCKED",
      summary: "Sample check could not run.",
      evidence: "Sample: a required development dependency was unavailable.",
      nextCheck: "Example action: restore the documented dependencies and retry.",
    },
  ];
  return ctx.ui.custom((_tui, theme, _keybindings, done) => {
    const preview = new ui.Container();
    preview.addChild(new ui.Text("Verifier demo — sample data only", 1, 1));
    for (const sample of samples) {
      preview.addChild(advisor.createAdvisorMessageCard({
        notes: [{
          advisor: "verifier",
          severity: "blocker",
          note: `SAMPLE — not a project finding\n${formatVerificationResults([sample])}`,
        }],
      }, () => true, theme));
    }
    preview.addChild(new ui.Text(
      "PASS and inapplicable checks are normally silent; silence alone is not proof of success.\nEsc / Enter close. No checks run, advice sent, or verdicts recorded.",
      1, 1,
    ));
    preview.handleInput = data => {
      if (ui.matchesKey(data, "escape") || ui.matchesKey(data, "enter") || ui.matchesKey(data, "ctrl+c")) done();
    };
    return preview;
  }, { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" } });
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
    description: "Show verifier setup, preview results, or run installed checks",
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

      if (action === "demo" && rest.length === 0) {
        return showDemo(ctx);
      }

      if (action === "verify") {
        return ctx.ui.notify(await buildVerification(cwd, rest, ctx.verificationPackageDirectory), "info");
      }

      return ctx.ui.notify(`Usage: ${COMMAND_USAGE}`, "error");
    },
  });
}
