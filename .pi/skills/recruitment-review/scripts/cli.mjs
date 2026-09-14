function parseOptions(args, start) {
  let evaluation = false;
  let confirmedBy = null;
  let sawEvaluation = false;
  let sawConfirmedBy = false;

  for (let index = start; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--evaluation") {
      if (sawEvaluation) return null;
      sawEvaluation = true;
      evaluation = true;
      continue;
    }
    if (argument === "--confirmed-by") {
      if (sawConfirmedBy) return null;
      const value = args[index + 1];
      if (
        value === undefined ||
        value.startsWith("--") ||
        value.trim().length === 0 ||
        value.length > 128
      ) {
        return null;
      }
      sawConfirmedBy = true;
      confirmedBy = value;
      index += 1;
      continue;
    }
    return null;
  }

  return { evaluation, confirmedBy };
}

export function parsePrepareArguments(args) {
  if (args.length === 0 || args[0].startsWith("--")) return null;
  const options = parseOptions(args, 1);
  return options === null ? null : { root: args[0], options };
}

export function parseCheckReportArguments(args) {
  if (args.length < 2 || args[0].startsWith("--") || args[1].startsWith("--")) {
    return null;
  }
  const options = parseOptions(args, 2);
  return options === null ? null : { root: args[0], reportPath: args[1], options };
}

// Preparation failures are pipeline diagnostics, not model reports consumed by checkReport.
export function renderPreparationAbort(error) {
  const bundle = error.identity
    ? `${error.identity.bundleId}@${error.identity.revision}`
    : "unavailable";
  return [
    `Bundle: ${bundle}`,
    "Review status: aborted",
    `Blocking reason: ${error.code}`,
    `Attempted review timestamp: ${new Date().toISOString()}`,
    "Unreviewed inputs: manifest.json, interview.txt, records.json, context.json",
    "Corrective action: Correct the local bundle and run preparation again.",
    "",
  ].join("\n");
}
