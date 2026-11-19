import { InvalidArgumentError, Option } from "commander";

export function addReportingOptions(command, { failuresOnly = false } = {}) {
  const reporter = new Option("--reporter <format>", "output format")
    .choices(["json", "text"])
    .default("json");
  command.addOption(reporter);
  if (failuresOnly) {
    command.option("--failures-only", "omit successful final results; retain pending reviews");
  }
  return command;
}

export function parseWholeNumber(value) {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number)) {
    throw new InvalidArgumentError("Expected a nonnegative safe integer");
  }
  return number;
}
