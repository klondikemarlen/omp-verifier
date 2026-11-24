import { watchAutomaticTiming } from "#root/omp-plugin/timing-history.js";

export function registerAdvisorCheckWidget(pi) {
  const observations = new Map();

  function stopObserving(toolCallId) {
    const observation = observations.get(toolCallId);
    if (!observation) return;

    observations.delete(toolCallId);
    setCheckLine(observation, undefined);
    observation.dispose?.();
  }

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash" || ctx.agent?.name !== "advisor" || !ctx.hasUI || ctx.mode !== "tui") return;

    const { toolCallId } = event;
    if (!toolCallId || observations.has(toolCallId)) return;

    const agentDir = ctx.agentDir || pi.pi.getAgentDir();
    // Cheap prefilter only. A matching timing record, not shell text, identifies the run.
    if (!event.input?.command?.includes("automatic")) return;

    const observation = {
      key: `verifier:advisor-check:${toolCallId}`,
      ui: ctx.ui,
      line: undefined,
      dispose: undefined,
    };
    observations.set(toolCallId, observation);

    try {
      const dispose = await watchAutomaticTiming(agentDir, toolCallId, run => {
        if (observations.get(toolCallId) !== observation) return;

        if (run.coordinatorMs !== null || run.cancelledAfterMs !== undefined) {
          stopObserving(toolCallId);
          return;
        }

        const check = run.checks.findLast(candidate => candidate.status === "STARTED");
        setCheckLine(observation, startedCheckLine(check));
      });
      if (observations.get(toolCallId) === observation) {
        observation.dispose = dispose;
      } else {
        dispose();
      }
    } catch {
      // Timing storage is optional; never turn an observation failure into a Bash preflight error.
      if (observations.get(toolCallId) === observation) {
        stopObserving(toolCallId);
      }
    }
  });

  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "bash" || ctx.agent?.name !== "advisor") return;

    // A background-job notice also ends this call's widget, without asserting a check outcome.
    stopObserving(event.toolCallId);
  });

  pi.on("session_shutdown", () => {
    for (const toolCallId of observations.keys()) {
      stopObserving(toolCallId);
    }
  });
}

function startedCheckLine(check) {
  if (!check) return;

  let line = `Check ${check.id} started`;
  if (check.timeoutMs !== undefined) {
    const budget = check.timeoutMs >= 1000 ? `${check.timeoutMs / 1000} s` : `${check.timeoutMs} ms`;
    line += ` (budget: ${budget})`;
  }
  return line;
}

function setCheckLine(observation, line) {
  if (observation.line === line) return;

  observation.line = line;
  try {
    if (line === undefined) {
      observation.ui.setWidget(observation.key, undefined);
    } else {
      observation.ui.setWidget(observation.key, [line]);
    }
  } catch {
    // Widget failures must not affect verification or guide its outcome.
  }
}
