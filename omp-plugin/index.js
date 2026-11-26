import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { registerCloseoutTool } from "#root/omp-plugin/closeout-tool.js";
import {
  buildGlobalVerifierStatus,
  installGlobalVerifier,
  uninstallGlobalVerifier,
} from "#root/omp-plugin/global-verifier.js";
import { registerAdvisorCheckWidget } from "#root/omp-plugin/register-advisor-check-widget.js";
import { formatVerificationInventory, formatVerificationResults } from "#root/omp-plugin/reporters.js";
import { createRequestIntent, readRequestIntent } from "#root/omp-plugin/request-intent.js";
import { discoverVerificationChecks } from "#root/omp-plugin/verification-catalog.js";
import { timeVerificationRun } from "#root/omp-plugin/run-timings.js";
import { runInstalledVerificationChecks } from "#root/omp-plugin/verifications.js";
import { runtimePaths } from "#root/omp-plugin/runtime-generations.js";

const COMMAND_USAGE = "/verifier [status|checks|verify [id...]|timings|closeout prepare|verify <file>|closeout review <handoff-id>|generation [prepare|activate <id>|status|collect]|demo|uninstall]";
const SUBCOMMANDS = [
  { name: "status", description: "Show verifier advisor setup" },
  { name: "checks", description: "List installed verification checks" },
  { name: "verify", description: "Run installed verification checks" },
  {
    name: "timings",
    description: "Show recent run and check durations",
  },
  { name: "demo", description: "Preview actual advisor cards without running checks" },
  { name: "uninstall", description: "Remove the verifier advisor" },
  {
    name: "generation",
    description: "Prepare, activate, inspect, or collect verifier artifacts",
  },
  {
    name: "closeout",
    description: "Capture or verify declared final resource dispositions",
  },
];
const execute = promisify(execFile);

function executeRuntimeCommand(agentDir, cwd, args) {
  const paths = runtimePaths(agentDir);
  return execute("node", [paths.launcher, ...args], {
    cwd,
    timeout: 600_000,
    maxBuffer: 1_000_000,
  });
}

async function runtimeCommand(agentDir, cwd, args) {
  try {
    const result = await executeRuntimeCommand(agentDir, cwd, args);
    return result.stdout;
  } catch (error) {
    if (args[0] === "verify" && ["SIGINT", "SIGTERM"].includes(error.signal)) {
      return `Verification interrupted by ${error.signal}. Rerun the same /verifier verify command to continue.`;
    }

    return error.stdout || `BLOCKED verifier:generation\n${error.stderr || error.message}`;
  }
}

async function buildChecks(packageDirectory) {
  return formatVerificationInventory(await discoverVerificationChecks({ packageDirectory }));
}

async function buildVerification(cwd, ids, packageDirectory) {
  const results = await timeVerificationRun(cwd, "verify", () => runInstalledVerificationChecks({
    cwd,
    ids,
    packageDirectory,
  }));
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
  return ctx.ui.custom((tui, theme, _keybindings, done) => {
    const preview = new ui.Box(1, 0, undefined, {
      chars: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
      color: text => theme.fg("border", text),
    });
    let sampleIndex = 0;
    const showSample = () => {
      const sample = samples[sampleIndex];
      preview.clear();
      preview.addChild(new ui.Text(
        `Verifier demo — sample ${sampleIndex + 1}/${samples.length}: ${sample.status}`,
        0, 0,
      ));
      preview.addChild(new ui.Text(
        `${theme.bold("Controls")}  ${theme.bold(theme.fg("accent", "[Tab]"))} Next sample    `
        + `${theme.bold(theme.fg("accent", "[Esc] / [Enter]"))} Close`,
        0, 0,
      ));
      preview.addChild(advisor.createAdvisorMessageCard({
        notes: [{
          advisor: "verifier",
          severity: "blocker",
          note: `SAMPLE — not a project finding\n${formatVerificationResults([sample])}`,
        }],
      }, () => true, theme));
      preview.addChild(new ui.Text(
        "PASS is normally silent, not proof of success.\nPreview only: no checks run, advice sent, or verdicts recorded.",
        0, 0,
      ));
    };
    showSample();
    preview.handleInput = data => {
      if (ui.matchesKey(data, "escape") || ui.matchesKey(data, "enter") || ui.matchesKey(data, "ctrl+c")) {
        done();
      } else if (ui.matchesKey(data, "tab")) {
        sampleIndex = (sampleIndex + 1) % samples.length;
        showSample();
        tui.requestRender();
      }
    };
    return preview;
  });
}

function completeSubcommands(argumentPrefix) {
  if (argumentPrefix.includes(" ")) return null;
  return SUBCOMMANDS
    .filter(command => command.name.startsWith(argumentPrefix.toLowerCase()))
    .map(command => ({ value: `${command.name} `, label: command.name, description: command.description }));
}

async function verifyCloseoutReceipt(agentDir, repositoryRoot, receiptPath) {
  const args = [
    "closeout",
    "verify",
    "--reporter",
    "json",
    "--",
    receiptPath,
  ];
  let output;
  let exitCode = 0;
  try {
    const result = await executeRuntimeCommand(agentDir, repositoryRoot, args);
    output = result.stdout;
  } catch (error) {
    if (error.code !== 1 || !error.stdout || error.stderr) {
      throw error;
    }
    exitCode = error.code;
    output = error.stdout;
  }
  const results = JSON.parse(output);
  if (results.length !== 1 || results[0]?.id !== "verifier:resource-closeout") {
    throw new Error("Installed verifier did not return the requested resource check");
  }
  if ((results[0].status === "PASS") !== (exitCode === 0)) {
    throw new Error("Closeout verdict disagrees with verifier exit status");
  }
  return results[0];
}

function logStartupTiming(pi, phase, startedAt) {
  // Diagnostics must not prevent startup or suppress the request's verifier instructions.
  try {
    pi.logger?.debug("verifier.startup-timing", {
      phase,
      durationMs: Math.round(performance.now() - startedAt),
    });
  } catch {
    // Host logging is best-effort.
  }
}

export default async function verifierPlugin(pi) {
  const loadStartedAt = performance.now();
  pi.setLabel("Verifier");
  registerAdvisorCheckWidget(pi);
  if (pi.registerTool) {
    const agentDir = pi.pi.getAgentDir();
    registerCloseoutTool(pi, (root, receipt) => verifyCloseoutReceipt(agentDir, root, receipt));
  }
  // Hide only the UI card; display:false also removes this metadata from advisor history.
  pi.registerMessageRenderer("verifier-work-intent", () => ({
    render: () => [],
    invalidate() {},
  }));
  await installGlobalVerifier({ agentDir: pi.pi.getAgentDir() });
  let currentIntent;
  let currentSessionId;

  pi.on("session_start", async (_event, ctx) => {
    const startedAt = performance.now();
    try {
      await installGlobalVerifier({ agentDir: ctx.agentDir || pi.pi.getAgentDir() });
    } catch (error) {
      ctx.ui.notify(`Verifier advisor setup failed: ${error.message}`, "warning");
    }
    logStartupTiming(pi, "session_start", startedAt);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const startedAt = performance.now();
    const agentDir = ctx.agentDir || pi.pi.getAgentDir();
    const coordinatorPath = runtimePaths(agentDir).launcher;
    const COORDINATOR = `'${coordinatorPath.replaceAll("'", "'\"'\"'")}'`;
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
        ? `Request instance: ${intent.requestId}\nFor applicable PR/MR source review only: after confirming live eligibility, run node ${COORDINATOR} automatic --base <actual-PR-base> <current-edited-path...> --request '${intent.handle}' --progress in the owning checkout. Use ordinary Bash output (pty: false). Add --full for safety escalation, explicit verification/recheck, and initial delivery/release gates.`
        : "No request handle: use full selection without reuse only for an applicable review.",
      intent.diagnostic,
      "Work intent is not PASS and never overrides mandatory requirements, explicit verification, initial delivery/release checks, or semantic escalation. Earlier request handles are not authority for this request.",
    ].filter(Boolean).join("\n");
    const response = {
      message: { customType: "verifier-work-intent", content, display: true, attribution: "agent" },
      systemPrompt: [
        ...event.systemPrompt,
        "Before merging, enabling auto-merge, or enqueuing, confirm required verification finished for the open PR/MR's current target, base and head. If fresh named review is needed, leave it open and yield to the verifier before merge. Silence, a PENDING handle, and a prepared handoff are not passing results. Reconfirm the remote revisions and pin the verified head when merging.",
        "The verifier checks live GitHub/GitLab state immediately before starting, retrying or resuming automatic review. Do not dispatch if the PR/MR is no longer open at the intended revisions or the host cannot confirm them. Skipped is not PASS. A review-and-merge request is not a retrospective request; explicit retrospective checks and independent post-merge CI remain available.",
        "Verifier PENDING requests need the named reviewer's next command, not a file watcher. Hand still-applicable handles and their owning checkout back to the verifier for review --resume and assessment.",
        "Standalone status, cleanup, wrap-up and exit do not start verification or require a receipt. Follow ordinary cleanup safety checks and authorized project wrappers.",
        `Verifier delivery cleanup: before removing an edit-owning Git worktree with committed delivery changes awaiting final review, run node ${COORDINATOR} handoff prepare --base <actual-delivery-base> in its clean checkout. Preserve the returned handoffPath and source identity in the transcript before cleanup. Do not prepare an unrelated checkout or omit uncommitted changes; retain the original if preparation cannot complete. A handoff preserves source; it cannot postpone pre-merge verification. Leave it for the verifier to recover, check within its applicable scope, and release. Preparation, merge, and cleanup are not PASS. Missing runtime prerequisites remain BLOCKED. Only explicit user cancellation or waiver authorizes handoff cancel <handoffPath> --reason <reason>; cancellation is not verification.`,
      ],
    };
    logStartupTiming(pi, "before_agent_start", startedAt);
    return response;
  });

  pi.registerCommand("verifier", {
    description: "Show verifier setup, preview results, or run installed checks",
    getArgumentCompletions: completeSubcommands,
    handler: async (args, ctx) => {
      const [action = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const cwd = ctx.cwd || process.cwd();
      const agentDir = ctx.agentDir || pi.pi.getAgentDir();

      if (action === "status" && rest.length === 0) {
        const agentDir = ctx.agentDir || pi.pi.getAgentDir();
        return ctx.ui.notify(await buildGlobalVerifierStatus(cwd, { agentDir }), "info");
      }

      if (action === "uninstall" && rest.length === 0) {
        const agentDir = ctx.agentDir || pi.pi.getAgentDir();
        return ctx.ui.notify(`Verifier cleanup: ${(await uninstallGlobalVerifier({ agentDir })).join("; ")}`, "info");
      }

      if (action === "checks" && rest.length === 0) {
        const output = ctx.verificationPackageDirectory
          ? await buildChecks(ctx.verificationPackageDirectory)
          : await runtimeCommand(agentDir, cwd, ["checks", "--reporter", "text"]);
        return ctx.ui.notify(output, "info");
      }

      if (action === "timings" && rest.length === 0) {
        const output = await runtimeCommand(agentDir, cwd, ["timings", "--reporter", "text"]);
        return ctx.ui.notify(output, "info");
      }

      if (action === "demo" && rest.length === 0) {
        return showDemo(ctx);
      }

      if (action === "verify") {
        const output = ctx.verificationPackageDirectory
          ? await buildVerification(cwd, rest, ctx.verificationPackageDirectory)
          : await runtimeCommand(agentDir, cwd, ["verify", ...rest, "--reporter", "text"]);
        return ctx.ui.notify(output, "info");
      }

      if (action === "generation") {
        const output = await runtimeCommand(agentDir, cwd, ["generation", ...rest]);
        if (rest[0] === "activate" && !output.startsWith("BLOCKED")) {
          await installGlobalVerifier({ agentDir });
        }
        return ctx.ui.notify(output, "info");
      }

      if (action === "closeout") {
        const output = await runtimeCommand(agentDir, cwd, ["closeout", ...rest, "--reporter", "text"]);
        return ctx.ui.notify(output, "info");
      }

      return ctx.ui.notify(`Usage: ${COMMAND_USAGE}`, "error");
    },
  });
  logStartupTiming(pi, "extension_load", loadStartedAt);
}
