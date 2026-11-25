import { InvalidArgumentError, Option } from "commander";

import { validateProjectLintBudget } from "#root/omp-plugin/verifications.js";

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

export function parseLintBudget(value) {
  const budget = parseWholeNumber(value);
  try {
    validateProjectLintBudget(budget);
  } catch (error) {
    throw new InvalidArgumentError(error.message);
  }
  return budget;
}
