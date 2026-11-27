const STATUS_REPORT_TYPE = "verifier-status";

export function showVerifierStatusReport(pi, ctx, { title, lines }) {
  const content = [title, ...lines].join("\n");
  if (typeof pi.sendMessage !== "function" || ctx.hasUI === false) {
    return ctx.ui.notify(content, "info");
  }

  pi.sendMessage({
    customType: STATUS_REPORT_TYPE,
    content,
    details: { title, lines },
    display: true,
    attribution: "user",
  }, { triggerTurn: false });
}

export async function registerVerifierStatusReport(pi) {
  let ui;
  try {
    ui = await import("@oh-my-pi/pi-tui");
  } catch {
    // The host's ordinary custom message renderer can show the saved text.
    return;
  }

  pi.registerMessageRenderer(STATUS_REPORT_TYPE, (message, _options, theme) => {
    const { title, lines } = message.details ?? {};
    if (typeof title !== "string" || !Array.isArray(lines)) {
      return undefined;
    }

    const card = new ui.Box(1, 0, undefined, {
      chars: theme.boxRound,
      color: text => theme.fg("borderMuted", text),
    });
    card.addChild(new ui.Text(theme.bold(theme.fg("accent", title)), 0, 0));
    card.addChild(new ui.Text(lines.map(line => {
      const separator = line.indexOf(": ");
      if (separator < 0) {
        return line;
      }

      const label = line.slice(0, separator + 1);
      return theme.bold(label) + line.slice(separator + 1);
    }).join("\n"), 0, 0));
    return card;
  });
}

export default showVerifierStatusReport;
