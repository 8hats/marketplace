import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./constants.mjs";
import { EXIT_INTERNAL, EXIT_USAGE, UsageError } from "./harnesses.mjs";
import { runInstaller } from "./installer.mjs";
import { runDoctor } from "./doctor.mjs";
import { createProgressReporter, persistReport } from "./reporting.mjs";
import { packageRootFrom, safeErrorMessage, stableJson } from "./util.mjs";

const HELP_TEXT = `Usage: bios-implant <command> [options]

Commands:
  install      Install or update BIOS Implant in detected harnesses
  doctor       Run host-side BIOS Implant diagnostics
  uninstall    Remove BIOS Implant harness registrations
  instructions Print the packaged installation guide
  help         Show this help text
  version      Print the package version

Options:
  --yes
  --dry-run
  --json          Machine-readable stdout; also saves the same JSON report
  --harness <auto|all|cowork|claude|codex>
  --purge-data   uninstall only
  --timeout <seconds>
  --verbose
  --help
  --version

Reports:
  Operational commands save a private JSON report and print its file:// URL.
  Set BIOS_IMPLANT_REPORT_DIR to choose the report directory.
`;

const COMMAND_INSTALL = "install";
const COMMAND_DOCTOR = "doctor";
const COMMAND_UNINSTALL = "uninstall";
const COMMAND_INSTRUCTIONS = "instructions";
const COMMAND_HELP = "help";
const COMMAND_VERSION = "version";
const VALID_COMMANDS = new Set([
  COMMAND_INSTALL,
  COMMAND_DOCTOR,
  COMMAND_UNINSTALL,
  COMMAND_INSTRUCTIONS,
  COMMAND_HELP,
  COMMAND_VERSION
]);
const VALID_HARNESSES = new Set(["auto", "all", "cowork", "claude", "codex"]);
const DEFAULT_TIMEOUT_SECONDS = 10;
const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = 300;

function defaultStdout(text) {
  process.stdout.write(text);
}

function defaultStderr(text) {
  process.stderr.write(text);
}

function createOutput(deps) {
  return {
    stdout: deps.stdout ?? defaultStdout,
    stderr: deps.stderr ?? defaultStderr
  };
}

function packageRootFor(deps) {
  return deps.packageRoot ?? packageRootFrom(import.meta.url);
}

function homeDirectoryFrom(deps) {
  return deps.homeDirectory ?? deps.env?.HOME ?? os.homedir();
}

function stateRootFrom(deps) {
  const env = deps.env ?? process.env;
  if (deps.stateRoot) {
    return path.resolve(deps.stateRoot);
  }
  const root = env.BIOS_IMPLANT_STATE_ROOT ?? env.AGENT_UNIVERSITY_HOME;
  return root ? path.resolve(root) : null;
}

function replaceKnownRoot(value, root, replacement) {
  const normalized = String(root ?? "").replace(/[\\/]+$/u, "");
  if (!normalized) {
    return value;
  }

  let redacted = "";
  let offset = 0;
  while (offset < value.length) {
    const index = value.indexOf(normalized, offset);
    if (index === -1) {
      redacted += value.slice(offset);
      break;
    }

    const before = index > 0 ? value[index - 1] : "";
    const afterIndex = index + normalized.length;
    const after = afterIndex < value.length ? value[afterIndex] : "";
    const startsAtBoundary = index === 0 || /[\s"'`([{=,:]/u.test(before);
    const endsAtBoundary = afterIndex === value.length || /[\\/\s"'`<>|:;,\)\]}]/u.test(after);

    if (startsAtBoundary && endsAtBoundary) {
      redacted += `${value.slice(offset, index)}${replacement}`;
      offset = afterIndex;
      continue;
    }

    redacted += value.slice(offset, index + 1);
    offset = index + 1;
  }

  return redacted;
}

function redactGenericAbsolutePaths(value) {
  const redactMatch = (_match, boundary) => `${boundary}<absolute>`;
  return value
    .replace(/(["'`])((?:[A-Za-z]:[\\/]|\\\\|\/(?!\/))[^"'`\r\n]+)\1/gu, "$1<absolute>$1")
    .replace(/(^|[\s"'`([{=,:])(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`<>|:;,\)\]}]*/gu, redactMatch)
    .replace(/(^|[\s"'`([{=,:])\/(?!\/)[^\s"'`<>|:;,\)\]}]+/gu, redactMatch);
}

function redactPath(value, homeDirectory, stateRoot, packageRoot) {
  if (typeof value !== "string") {
    return value;
  }

  const replacements = [];
  if (stateRoot && stateRoot !== homeDirectory) {
    replacements.push({ from: stateRoot, to: "<stateRoot>" });
  }
  if (packageRoot && packageRoot !== homeDirectory && packageRoot !== stateRoot) {
    replacements.push({ from: packageRoot, to: "<packageRoot>" });
  }
  if (homeDirectory) {
    replacements.push({ from: homeDirectory, to: "~" });
  }

  let redacted = value;
  for (const { from, to } of replacements.sort((left, right) => right.from.length - left.from.length)) {
    redacted = replaceKnownRoot(redacted, from, to);
  }

  return redactGenericAbsolutePaths(redacted);
}

function sanitizeValue(value, homeDirectory, stateRoot, packageRoot, verbose) {
  if (verbose) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, homeDirectory, stateRoot, packageRoot, verbose));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeValue(entry, homeDirectory, stateRoot, packageRoot, verbose)])
    );
  }

  return redactPath(value, homeDirectory, stateRoot, packageRoot);
}

function normalizeHarness(value) {
  if (!VALID_HARNESSES.has(value)) {
    throw new UsageError(`Unsupported harness: ${value}`);
  }

  return value;
}

function parseTimeout(rawValue) {
  if (rawValue === undefined) {
    throw new UsageError("Missing value after --timeout");
  }

  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < MIN_TIMEOUT_SECONDS || value > MAX_TIMEOUT_SECONDS) {
    throw new UsageError(`--timeout must be between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS} seconds`);
  }

  return value;
}

function parseArgs(argv, forcedCommand) {
  const args = Array.isArray(argv) ? [...argv] : [];
  if (!args.length && !forcedCommand) {
    throw new UsageError("A command is required.");
  }

  const first = args[0];
  if (first === "--help" || first === "help") {
    return { command: COMMAND_HELP, options: { json: false, verbose: false } };
  }

  if (first === "--version" || first === "version") {
    return { command: COMMAND_VERSION, options: { json: false, verbose: false } };
  }

  let command = forcedCommand ?? first;
  let optionStartIndex = 0;

  if (!forcedCommand) {
    if (!VALID_COMMANDS.has(command)) {
      throw new UsageError(`Unknown command: ${command}`);
    }
    optionStartIndex = 1;
  } else if (args[0] && !args[0].startsWith("--")) {
    if (args[0] !== forcedCommand) {
      throw new UsageError(`Unexpected command for ${forcedCommand}: ${args[0]}`);
    }
    optionStartIndex = 1;
  }

  const options = {
    yes: false,
    dryRun: false,
    json: false,
    purgeData: false,
    verbose: false,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    harnesses: []
  };

  for (let index = optionStartIndex; index < args.length; index += 1) {
    const token = args[index];

    if (token === "--yes") {
      options.yes = true;
      continue;
    }

    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (token === "--json") {
      options.json = true;
      continue;
    }

    if (token === "--verbose") {
      options.verbose = true;
      continue;
    }

    if (token === "--purge-data") {
      options.purgeData = true;
      continue;
    }

    if (token === "--help") {
      return { command: COMMAND_HELP, options };
    }

    if (token === "--version") {
      return { command: COMMAND_VERSION, options };
    }

    if (token === "--harness") {
      const value = args[index + 1];
      if (!value) {
        throw new UsageError("Missing value after --harness");
      }
      options.harnesses.push(normalizeHarness(value));
      index += 1;
      continue;
    }

    if (token.startsWith("--harness=")) {
      options.harnesses.push(normalizeHarness(token.slice("--harness=".length)));
      continue;
    }

    if (token === "--timeout") {
      options.timeoutSeconds = parseTimeout(args[index + 1]);
      index += 1;
      continue;
    }

    if (token.startsWith("--timeout=")) {
      options.timeoutSeconds = parseTimeout(token.slice("--timeout=".length));
      continue;
    }

    throw new UsageError(`Unknown option: ${token}`);
  }

  if (options.purgeData && command !== COMMAND_UNINSTALL) {
    throw new UsageError("--purge-data is only valid with uninstall");
  }

  options.harnesses = [...new Set(options.harnesses)];

  if (command === COMMAND_INSTRUCTIONS) {
    const invalidInstructionOptions = [
      options.yes,
      options.dryRun,
      options.purgeData,
      options.harnesses.length > 0,
      options.timeoutSeconds !== DEFAULT_TIMEOUT_SECONDS
    ].some(Boolean);

    if (invalidInstructionOptions) {
      throw new UsageError("instructions only accepts --json, --verbose, --help, and --version");
    }
  }

  return { command, options };
}

function humanStatusWord(status) {
  switch (status) {
    case "PASS":
      return "Success";
    case "WARN":
      return "Warning";
    case "FAIL":
      return "Failure";
    case "CANCELLED":
      return "Cancelled";
    default:
      return "Status";
  }
}

function firstNonPassCheck(result) {
  return (result.checks ?? []).find((check) => check.result && check.result !== "PASS") ?? null;
}

function firstHarnessProblem(result) {
  return (result.harnesses ?? []).find((harness) => harness.result && harness.result !== "PASS") ?? null;
}

function explainResult(command, result) {
  if (result.message) {
    return result.message;
  }

  if (result.dry_run && result.status !== "FAIL") {
    return `BIOS Implant ${command} dry run completed. No changes were applied.`;
  }

  if (result.status === "CANCELLED") {
    return `BIOS Implant ${command} was cancelled before any changes were applied.`;
  }

  if (result.status === "WARN") {
    const warningMessage = result.warnings?.[0]?.message;
    if (command === COMMAND_INSTALL) {
      return `BIOS Implant ${result.version ?? PACKAGE_VERSION} was installed, but setup is not complete.${warningMessage ? ` ${warningMessage}` : ""}`;
    }
    if (command === COMMAND_DOCTOR) {
      return "Doctor found required next steps; installation readiness is not yet proven.";
    }
    if (warningMessage) {
      return `BIOS Implant ${command} completed with a warning. ${warningMessage}`;
    }
  }

  const harnessProblem = firstHarnessProblem(result);
  if (harnessProblem) {
    return `${harnessProblem.harness} reported ${String(harnessProblem.code ?? "an error").replaceAll("_", " ").toLowerCase()}. Open the error report for technical details.`;
  }

  const doctorCheck = firstNonPassCheck(result);
  if (doctorCheck) {
    return `Doctor check ${String(doctorCheck.code).replaceAll("_", " ").toLowerCase()} needs attention.`;
  }

  if (result.status === "PASS") {
    return `BIOS Implant ${command} completed without reported issues.`;
  }

  return `BIOS Implant ${command} finished with ${String(result.status).toLowerCase()}.`;
}

function fallbackNextStep(command, result) {
  if (result.code === "USAGE_ERROR") {
    return `Run "npx -y ${PACKAGE_NAME}@latest help" and retry with a valid command or option.`;
  }

  if (result.dry_run && result.status !== "FAIL") {
    return `Rerun BIOS Implant ${command} without --dry-run when you are ready to apply changes.`;
  }

  if (result.status === "PASS") {
    return "No further action is required.";
  }

  if (result.status === "CANCELLED") {
    return `Rerun bios-implant ${command} when you are ready to continue.`;
  }

  return "Review the saved report, then follow the failing harness or check guidance.";
}

function titleCaseHarness(harness) {
  switch (harness) {
    case "cowork":
      return "Local Cowork";
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "auto":
      return "Automatic";
    case "all":
      return "All";
    default:
      return String(harness ?? "Unknown");
  }
}

function detectionFor(harness, result) {
  const detectedByName = result.detected_harnesses_by_name?.[harness];
  if (detectedByName) {
    return detectedByName;
  }
  return (result.detected_harnesses ?? []).find((entry) => entry.harness === harness) ?? null;
}

function checksForHarness(harness, result) {
  return (result.checks ?? []).filter((check) => check.harness === harness);
}

const ANSI_RESET = "\u001B[0m";
const ANSI_PATTERN = /\u001B\[[0-9;]*m/gu;
const ANSI_COLORS = {
  red: "\u001B[31m",
  yellow: "\u001B[33m",
  green: "\u001B[32m",
  cyan: "\u001B[36m",
  bold: "\u001B[1m"
};

function createPalette(enabled) {
  if (!enabled) {
    return {
      ok: (value) => value,
      warn: (value) => value,
      fail: (value) => value,
      title: (value) => value,
      action: (value) => value,
      command: (value) => value,
      security: (value) => value
    };
  }

  const paint = (color) => (value) => `${color}${value}${ANSI_RESET}`;
  return {
    ok: paint(ANSI_COLORS.green),
    warn: paint(ANSI_COLORS.yellow),
    fail: paint(ANSI_COLORS.red),
    title: paint(`${ANSI_COLORS.bold}${ANSI_COLORS.cyan}`),
    action: paint(`${ANSI_COLORS.bold}${ANSI_COLORS.cyan}`),
    command: paint(ANSI_COLORS.yellow),
    security: paint(`${ANSI_COLORS.bold}${ANSI_COLORS.red}`)
  };
}

function shouldUseAnsiColor(stream, env) {
  const environment = env ?? process.env;
  if ("NO_COLOR" in environment) {
    return false;
  }

  const forced = environment.FORCE_COLOR;
  if (forced !== undefined) {
    return forced !== "" && forced !== "0";
  }

  return Boolean(stream?.isTTY);
}

function visibleWidth(value) {
  return String(value ?? "").replace(ANSI_PATTERN, "").length;
}

function padVisible(value, width) {
  const text = String(value ?? "");
  return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

function hasRegistrationFailure(check) {
  return /(?:PLUGIN_MISSING|MCP_MISSING|REMOTE_CONFIG_INVALID)$/u.test(check.code ?? "");
}

function hasRegistrationPass(check) {
  return /(?:PLUGIN_PRESENT|MCP_PRESENT|BINDING_PRESENT|COWORK_PLUGIN_OBSERVED)$/u.test(check.code ?? "");
}

function issueFromCheck(check) {
  return check?.evidence?.next_action
    ?? check?.evidence?.message
    ?? String(check?.code ?? "CHECK_REQUIRES_ATTENTION")
      .replaceAll("_", " ")
      .toLowerCase()
      .replace(/^./u, (character) => character.toUpperCase());
}

function isActionableGuidance(value) {
  return /^(?:after|complete|give|npx|obtain|open|retry|run|use|visit)\b/iu.test(String(value ?? "").trim());
}

function summarizeHarnessHealth(harnessChecks) {
  const failure = harnessChecks.find((check) => check.result === "FAIL");
  if (failure) {
    return {
      status: "FAIL",
      message: String(failure.code ?? "Harness verification failed").replaceAll("_", " ").toLowerCase()
    };
  }
  const warning = harnessChecks.find((check) => check.result === "WARN");
  if (warning) {
    return {
      status: "WARN",
      message: String(warning.code ?? "Harness verification needs attention").replaceAll("_", " ").toLowerCase()
    };
  }
  return { status: "PASS", message: "registration checks passed" };
}

function selectedDoctorHarnesses(result) {
  if (!Array.isArray(result.requested_harnesses)) {
    return [];
  }
  if (result.requested_harnesses.includes("auto")) {
    const detectedHarnesses = Object.keys(result.detected_harnesses_by_name ?? {}).length > 0
      ? Object.values(result.detected_harnesses_by_name ?? {})
      : (result.detected_harnesses ?? []);
    return [
      ...new Set(
        detectedHarnesses
          .filter((entry) => entry.detected && entry.supported)
          .map((entry) => entry.harness)
      )
    ];
  }
  return result.requested_harnesses;
}

function detectedSummaryFor(harness, result) {
  const detection = detectionFor(harness, result);
  if (!detection?.detected) {
    return { status: "FAIL", text: "✗ MISSING" };
  }
  if (!detection.supported) {
    return { status: "WARN", text: "! UNSUPPORTED" };
  }
  return { status: "PASS", text: "✓ DETECTED" };
}

function registrationSummaryFor(harnessChecks) {
  if (harnessChecks.some(hasRegistrationFailure)) {
    return { status: "FAIL", text: "✗ MISSING" };
  }
  if (harnessChecks.some(hasRegistrationPass)) {
    return { status: "PASS", text: "✓ READY" };
  }
  if (harnessChecks.length > 0) {
    return { status: "WARN", text: "! CHECK" };
  }
  return { status: "FAIL", text: "✗ MISSING" };
}

function healthSummaryFor(harnessChecks) {
  const health = summarizeHarnessHealth(harnessChecks);
  if (health.status === "FAIL") {
    return { status: "FAIL", text: "✗ FAIL", detail: health.message };
  }
  if (health.status === "WARN") {
    return { status: "WARN", text: "! WARN", detail: health.message };
  }
  return { status: "PASS", text: "✓ PASS", detail: health.message };
}

function collectHarnessIssues(harnessChecks) {
  return [...new Set(
    harnessChecks
      .filter((check) => check.result === "WARN" || check.result === "FAIL")
      .map((check) => issueFromCheck(check))
      .filter(Boolean)
  )];
}

function formatHarnessScope(result) {
  const requested = Array.isArray(result.requested_harnesses) ? result.requested_harnesses : [];
  if (
    requested.length !== 1
    || requested[0] === "auto"
    || requested[0] === "all"
  ) {
    return "all";
  }
  return requested[0];
}

function registrationRepairCommand(result) {
  return `npx -y ${PACKAGE_NAME}@latest install --yes --harness ${formatHarnessScope(result)}`;
}

function collectDoctorNextSteps(result, harnessRows) {
  const steps = [];
  const missingRegistration = harnessRows.some((row) => row.registration.status === "FAIL");
  if (missingRegistration) {
    steps.push(registrationRepairCommand(result));
    steps.push(`npx -y ${PACKAGE_NAME}@latest doctor`);
  }

  const followUpSteps = [
    ...(result.next_steps ?? []),
    ...harnessRows.flatMap((row) => row.issues)
  ].filter(isActionableGuidance);

  for (const step of followUpSteps) {
    if (!step) {
      continue;
    }
    if (missingRegistration && /open a new .*session|run the doctor skill|native oauth|sign-in/iu.test(step)) {
      steps.push(`After registration is repaired, ${step.charAt(0).toLowerCase()}${step.slice(1)}`);
      continue;
    }
    steps.push(step);
  }

  const uniqueSteps = [...new Set(steps)];
  if (uniqueSteps.length > 0) {
    return uniqueSteps;
  }
  if (result.status === "PASS") {
    return ["No further action is required."];
  }
  return ["Review the issues above and open the saved report for technical details."];
}

function describeDoctorAction(step) {
  const value = String(step ?? "").trim();
  const codexLogin = value.match(/\b(codex\s+mcp\s+login\s+[A-Za-z0-9._-]+)\b/iu);

  if (codexLogin) {
    return {
      title: "AUTHORIZE CODEX",
      command: codexLogin[1],
      details: ["Approve the browser consent flow opened by Codex."],
      expected: "Codex reports a successful MCP login; then rerun doctor."
    };
  }

  if (/^npx\s+.*\sinstall\b/iu.test(value)) {
    return {
      title: "REPAIR REGISTRATION",
      command: value,
      details: ["Installs or repairs the plugin, MCP registrations, and skills."],
      expected: "Every selected harness shows Registration as READY."
    };
  }

  if (/^npx\s+.*\sdoctor\b/iu.test(value)) {
    return {
      title: "VERIFY HOST SETUP",
      command: value,
      details: ["Checks every detected supported harness again."],
      expected: "Registration shows READY before you continue."
    };
  }

  if (/Customize.*Plugins.*(?:Add|Upload)|manual plugin upload/iu.test(value)) {
    return {
      title: "INSTALL MANUALLY IN LOCAL COWORK",
      details: [
        "Open Customize → Plugins in Claude Desktop and choose Add.",
        "Select the plugin package named in the technical report."
      ],
      expected: "BIOS Implant appears under Customize → Plugins."
    };
  }

  if (/one-use setup URL|one-use setup capability|owner-provided.*capability/iu.test(value)) {
    return {
      title: "CONNECT THE WORKSPACE",
      details: [
        "Ask the owner for a one-use setup URL.",
        "Open the intended workspace and give it only to the connect skill."
      ],
      security: "Never give the one-use setup URL to install or doctor."
    };
  }

  if (/native oauth|sign-in|authoriz/iu.test(value)) {
    return {
      title: "AUTHORIZE THE REMOTE MCP",
      details: [
        "Open a new session in the intended harness.",
        "Complete native OAuth only if the harness prompts for it."
      ]
    };
  }

  if (/open a new .*session|run the .*doctor skill/iu.test(value)) {
    return {
      title: "RESTART THE HARNESS",
      details: [
        "Open a new Claude Desktop / Local Cowork, Claude Code, or Codex session.",
        "Run the installed doctor skill in that new session."
      ]
    };
  }

  if (/^no further action is required\.?$/iu.test(value)) {
    return {
      title: "DONE",
      details: ["No further action is required."]
    };
  }

  return {
    title: "FOLLOW THIS ACTION",
    details: [value]
  };
}

function renderDoctorActions(steps, palette) {
  const lines = [palette.title("Next actions")];
  const seen = new Set();
  const actions = [];

  for (const step of steps) {
    const action = describeDoctorAction(step);
    const key = action.command
      ? `command:${action.command}`
      : action.title === "FOLLOW THIS ACTION"
        ? `detail:${action.details.join("\n")}`
        : `action:${action.title}`;
    if (!seen.has(key)) {
      seen.add(key);
      actions.push(action);
    }
  }

  for (const [index, action] of actions.entries()) {
    lines.push("");
    lines.push(palette.action(`${index + 1}. ${action.title}`));
    if (action.command) {
      lines.push("   Run:");
      lines.push(`     ${palette.command(action.command)}`);
    }
    for (const detail of action.details ?? []) {
      lines.push(`   ${detail}`);
    }
    if (action.expected) {
      lines.push(`   ${palette.ok("Expected:")} ${action.expected}`);
    }
    if (action.security) {
      lines.push(`   ${palette.security("SECURITY:")} ${action.security}`);
    }
  }

  return lines;
}

function colorizeStatus(text, status, palette) {
  if (status === "PASS") {
    return palette.ok(text);
  }
  if (status === "WARN") {
    return palette.warn(text);
  }
  if (status === "FAIL") {
    return palette.fail(text);
  }
  return text;
}

function renderDoctorTable(harnessRows, palette) {
  const headers = ["Harness", "Detected", "Registration", "Health"];
  const widths = [
    Math.max(headers[0].length, ...harnessRows.map((row) => row.name.length)),
    Math.max(headers[1].length, ...harnessRows.map((row) => row.detected.text.length)),
    Math.max(headers[2].length, ...harnessRows.map((row) => row.registration.text.length)),
    Math.max(headers[3].length, ...harnessRows.map((row) => row.health.text.length))
  ];

  const headerLine = headers.map((header, index) => padVisible(header, widths[index])).join("  ");
  const separatorLine = widths.map((width) => "-".repeat(width)).join("  ");
  const rowLines = harnessRows.map((row) => [
    padVisible(row.name, widths[0]),
    padVisible(colorizeStatus(row.detected.text, row.detected.status, palette), widths[1]),
    padVisible(colorizeStatus(row.registration.text, row.registration.status, palette), widths[2]),
    padVisible(colorizeStatus(row.health.text, row.health.status, palette), widths[3])
  ].join("  "));

  return [headerLine, separatorLine, ...rowLines];
}

function installHarnessName(harness) {
  return titleCaseHarness(harness);
}

function installWarningCodes(harnessResult) {
  return new Set((harnessResult.warnings ?? []).map((warning) => warning.code).filter(Boolean));
}

function installationSummaryFor(harnessResult, dryRun) {
  if (harnessResult.result === "FAIL") {
    return { status: "FAIL", text: "✗ FAILED" };
  }
  if (dryRun) {
    return { status: "WARN", text: "• PLANNED" };
  }
  return { status: "PASS", text: "✓ INSTALLED" };
}

function remainingSetupFor(harnessResult) {
  if (harnessResult.result === "FAIL") {
    return { status: "FAIL", text: "Open error report" };
  }

  const warnings = installWarningCodes(harnessResult);
  if (warnings.has("AUTH_REQUIRED") && warnings.has("RUNTIME_PROBE_REQUIRED")) {
    return { status: "WARN", text: "OAuth + doctor" };
  }
  if (warnings.has("AUTH_REQUIRED")) {
    return { status: "WARN", text: "Verify OAuth" };
  }
  if (warnings.has("RUNTIME_PROBE_REQUIRED")) {
    return { status: "WARN", text: "Restart + doctor" };
  }
  if (harnessResult.result === "WARN") {
    return { status: "WARN", text: "Follow actions" };
  }
  return { status: "PASS", text: "✓ READY" };
}

function renderInstallTable(harnessResults, dryRun, palette) {
  const rows = harnessResults.map((harnessResult) => ({
    name: installHarnessName(harnessResult.harness),
    installation: installationSummaryFor(harnessResult, dryRun),
    remaining: remainingSetupFor(harnessResult)
  }));
  const headers = ["Harness", "Installation", "Remaining setup"];
  const widths = [
    Math.max(headers[0].length, ...rows.map((row) => row.name.length)),
    Math.max(headers[1].length, ...rows.map((row) => row.installation.text.length)),
    Math.max(headers[2].length, ...rows.map((row) => row.remaining.text.length))
  ];
  const headerLine = headers.map((header, index) => padVisible(header, widths[index])).join("  ");
  const separatorLine = widths.map((width) => "-".repeat(width)).join("  ");
  const rowLines = rows.map((row) => [
    padVisible(row.name, widths[0]),
    padVisible(
      colorizeStatus(row.installation.text, row.installation.status, palette),
      widths[1]
    ),
    padVisible(colorizeStatus(row.remaining.text, row.remaining.status, palette), widths[2])
  ].join("  "));

  return [headerLine, separatorLine, ...rowLines];
}

function allInstallWarningCodes(result) {
  return new Set([
    ...(result.warnings ?? []).map((warning) => warning.code),
    ...(result.harnesses ?? []).flatMap((harness) =>
      (harness.warnings ?? []).map((warning) => warning.code)
    )
  ].filter(Boolean));
}

function installHarnessFlags(result) {
  const requested = Array.isArray(result.requested_harnesses) ? result.requested_harnesses : [];
  if (!requested.length || requested.includes("auto")) {
    return "";
  }
  if (["cowork", "claude", "codex"].every((harness) => requested.includes(harness))) {
    return " --harness all";
  }
  return requested.map((harness) => ` --harness ${harness}`).join("");
}

function installActions(result) {
  if (result.dry_run && result.status !== "FAIL") {
    return [{
      icon: "🚀",
      title: "APPLY THE INSTALLATION",
      command: `npx -y ${PACKAGE_NAME}@latest install --yes${installHarnessFlags(result)}`,
      details: [
        "Rerun without --dry-run when you are ready to write the plugin, MCP, and skill registrations."
      ]
    }];
  }

  if (result.status === "FAIL") {
    return [{
      icon: "🛠️",
      title: "RETRY AFTER REVIEWING THE REPORT",
      details: [result.next_steps?.[0] ?? fallbackNextStep(COMMAND_INSTALL, result)]
    }];
  }

  const warningCodes = allInstallWarningCodes(result);
  const actions = [];
  if (result.status === "WARN") {
    actions.push({
      icon: "🔄",
      title: "OPEN A NEW SESSION",
      details: [
        "Open the intended workspace in Claude Desktop / Local Cowork, Claude Code, or Codex.",
        "Start a new session so the newly installed plugin and skills are loaded."
      ]
    });
    actions.push({
      icon: "🩺",
      title: "RUN THE DOCTOR SKILL",
      prompt: "Run the BIOS Implant doctor skill and report the current Folder Binding.",
      expected: "The agent confirms the installed MCP, skills, Local Companion, and workspace state."
    });
  }

  if (warningCodes.has("AUTH_REQUIRED")) {
    actions.push({
      icon: "🔐",
      title: "AUTHORIZE CODEX IF PROMPTED",
      command: "codex mcp login implant",
      details: ["Approve the browser consent flow only if Codex still requests authorization."],
      expected: "Codex reports a successful MCP login."
    });
  }

  if (warningCodes.has("BINDING_REQUIRED")) {
    actions.push({
      icon: "🔗",
      title: "CONNECT THIS WORKSPACE",
      details: [
        "Ask the owner for a one-use setup URL.",
        "Give it only to the connect skill from the intended workspace."
      ],
      security: "Never give the one-use setup URL to install or doctor."
    });
  }

  if (actions.length === 0) {
    actions.push({
      icon: "🎉",
      title: "DONE",
      details: ["No further installation action is required."]
    });
  }
  return actions;
}

function renderInstallActions(actions, palette) {
  const lines = [palette.title("➡️  NEXT ACTIONS")];
  for (const [index, action] of actions.entries()) {
    lines.push("");
    lines.push(palette.action(`${index + 1}. ${action.icon} ${action.title}`));
    if (action.command) {
      lines.push("   Run:");
      lines.push(`     ${palette.command(action.command)}`);
    }
    if (action.prompt) {
      lines.push("   Ask your agent:");
      lines.push(`     ${palette.command(`"${action.prompt}"`)}`);
    }
    for (const detail of action.details ?? []) {
      lines.push(`   ${detail}`);
    }
    if (action.expected) {
      lines.push(`   ${palette.ok("Expected:")} ${action.expected}`);
    }
    if (action.security) {
      lines.push(`   ${palette.security("SECURITY:")} ${action.security}`);
    }
  }
  return lines;
}

function renderHumanInstallResult(result, reportWarning = null, renderContext = {}) {
  const palette = createPalette(Boolean(renderContext.useColor));
  const divider = "━".repeat(64);
  const lines = [
    palette.title(divider),
    palette.title(`🧠 BIOS Implant ${result.version ?? PACKAGE_VERSION}`),
    palette.title(divider),
    ""
  ];

  if (result.dry_run && result.status !== "FAIL") {
    lines.push(palette.warn("🔎 DRY RUN COMPLETE — NO CHANGES APPLIED"));
    lines.push("BIOS Implant install dry run completed. No changes were applied.");
  } else if (result.status === "FAIL") {
    if (result.code === "USAGE_ERROR") {
      lines.push(palette.fail("❌ INVALID COMMAND"));
      lines.push(result.message ?? "The command or options are invalid.");
    } else {
      lines.push(palette.fail("❌ INSTALLATION FAILED"));
      lines.push("The installer could not finish. Technical details are saved in the error report below.");
    }
  } else {
    lines.push(palette.ok("✅ INSTALLATION COMPLETE"));
    lines.push("The plugin, MCP registrations, and skills are installed.");
    if (result.status === "WARN") {
      lines.push(palette.warn("⚠️  WORKSPACE SETUP STILL REQUIRED"));
      lines.push("Finish the highlighted actions below before using BIOS in this workspace.");
    }
  }

  if ((result.harnesses ?? []).length > 0) {
    lines.push("");
    lines.push(palette.title("📦 INSTALLATION STATUS"));
    lines.push("");
    lines.push(...renderInstallTable(result.harnesses, Boolean(result.dry_run), palette));
  }

  lines.push("");
  lines.push(...renderInstallActions(installActions(result), palette));

  lines.push("");
  lines.push(palette.title(result.status === "FAIL" ? "📄 ERROR REPORT" : "📄 TECHNICAL REPORT"));
  if (result.report_url) {
    lines.push(`   Open: ${result.report_url}`);
  }
  if (result.report_file) {
    lines.push(`   Path: ${result.report_file}`);
  }
  if (reportWarning) {
    lines.push(`   Report details: ${reportWarning}`);
  }

  return `${lines.join("\n")}\n`;
}

function renderHumanDoctorResult(result, reportWarning = null, renderContext = {}) {
  const harnesses = selectedDoctorHarnesses(result);
  const palette = createPalette(Boolean(renderContext.useColor));
  const harnessRows = harnesses.map((harness) => {
    const harnessChecks = checksForHarness(harness, result);
    return {
      harness,
      name: titleCaseHarness(harness),
      detected: detectedSummaryFor(harness, result),
      registration: registrationSummaryFor(harnessChecks),
      health: healthSummaryFor(harnessChecks),
      issues: collectHarnessIssues(harnessChecks)
    };
  });

  const overallStatus = result.status === "PASS"
    ? { status: "PASS", text: "✓ PASS" }
    : result.status === "WARN"
      ? { status: "WARN", text: "! WARN" }
      : { status: "FAIL", text: "✗ FAIL" };
  const lines = [
    palette.title(`BIOS Implant Doctor ${result.version ?? PACKAGE_VERSION}`),
    `Overall  ${colorizeStatus(overallStatus.text, overallStatus.status, palette)}  ${explainResult(COMMAND_DOCTOR, result)}`
  ];

  if (harnessRows.length === 0) {
    lines.push("");
    lines.push("Harnesses");
    lines.push("No supported harnesses were detected on this host.");
  } else {
    lines.push("");
    lines.push(...renderDoctorTable(harnessRows, palette));
  }

  const issueRows = harnessRows.filter((row) => row.health.status !== "PASS" || row.registration.status !== "PASS");
  if (issueRows.length > 0) {
    lines.push("");
    lines.push("Issues");
    for (const row of issueRows) {
      const details = row.issues.length > 0 ? row.issues.join(" ") : row.health.detail;
      lines.push(`- ${row.name}: ${details}`);
    }
  }

  const nextSteps = collectDoctorNextSteps(result, harnessRows);
  lines.push("");
  lines.push(...renderDoctorActions(nextSteps, palette));

  lines.push("");
  if (result.report_url) {
    lines.push(`${result.status === "FAIL" ? "Error report" : "Report"}: ${result.report_url}`);
  }
  if (result.report_file) {
    lines.push(`Path: ${result.report_file}`);
  }
  if (reportWarning) {
    lines.push(`Report details: ${reportWarning}`);
  }

  return `${lines.join("\n")}\n`;
}

function renderHumanResult(command, result, reportWarning = null, renderContext = {}) {
  if (command === COMMAND_DOCTOR) {
    return renderHumanDoctorResult(result, reportWarning, renderContext);
  }
  if (command === COMMAND_INSTALL) {
    return renderHumanInstallResult(result, reportWarning, renderContext);
  }

  const lines = [
    `${humanStatusWord(result.status)}: ${explainResult(command, result)}`,
    `Next step: ${result.dry_run && result.status !== "FAIL"
      ? fallbackNextStep(command, result)
      : result.next_steps?.[0] ?? fallbackNextStep(command, result)}`
  ];

  if (result.report_url) {
    lines.push(`${result.status === "FAIL" ? "Error report" : "Report"}: ${result.report_url}`);
  }
  if (result.report_file) {
    lines.push(`Path: ${result.report_file}`);
  }
  if (reportWarning) {
    lines.push(`Report details: ${reportWarning}`);
  }

  return `${lines.join("\n")}\n`;
}

function emitJson(output, value) {
  output.stdout(stableJson(value));
}

async function confirmMutation(command, options, deps) {
  if (typeof deps.confirmMutation === "function") {
    return Boolean(await deps.confirmMutation(command, options));
  }

  const input = deps.stdinStream ?? process.stdin;
  const output = deps.stdoutStream ?? process.stdout;
  if (!input.isTTY || !output.isTTY) {
    throw new UsageError(`Use --yes to run ${command} noninteractively`);
  }

  const interfaceHandle = createInterface({ input, output });
  try {
    const purgeSuffix = options.purgeData ? " and purge unchanged package-owned data" : "";
    const answer = await interfaceHandle.question(`Proceed with BIOS Implant ${command}${purgeSuffix}? [y/N] `);
    return /^(?:y|yes)$/iu.test(answer.trim());
  } finally {
    interfaceHandle.close();
  }
}

async function readInstructions(deps) {
  const packageRoot = packageRootFor(deps);
  const fileSystem = deps.fs ?? fsp;
  const instructionSources = [
    {
      path: path.join(packageRoot, "skills", "install", "SKILL.md"),
      source: "skills/install/SKILL.md"
    },
    {
      path: path.join(packageRoot, "INSTALL.md"),
      source: "INSTALL.md"
    }
  ];

  for (const candidate of instructionSources) {
    try {
      return {
        status: "PASS",
        code: "INSTALL_INSTRUCTIONS",
        instructions: await fileSystem.readFile(candidate.path, "utf8"),
        source: candidate.source,
        path: candidate.path
      };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return {
    status: "WARN",
    code: "INSTALL_INSTRUCTIONS_MISSING",
    instructions: [
      "The packaged install skill and INSTALL.md are missing from this development tree.",
      "Run: npx -y @agentuniversity/bios-implant@latest install --yes --harness cowork",
      "If installation succeeds, run: npx -y @agentuniversity/bios-implant@latest doctor --harness cowork",
      "Then open a new Local Cowork session and run the doctor skill."
    ].join("\n"),
    source: "fallback"
  };
}

function sanitizePayload(result, deps, options) {
  return sanitizeValue(
    result,
    homeDirectoryFrom(deps),
    stateRootFrom(deps),
    packageRootFor(deps),
    options.verbose
  );
}

async function persistPayload(command, payload, deps) {
  try {
    return await persistReport(payload, deps, {
      command,
      homeDirectory: homeDirectoryFrom(deps),
      now: deps.now instanceof Date ? deps.now : undefined
    });
  } catch (error) {
    return {
      payload,
      reportError: `Diagnostics could not be saved: ${safeErrorMessage(error)}`
    };
  }
}

async function emitFinal(output, command, payload, deps, options, target = "stdout") {
  const renderedPayload = sanitizePayload(payload, deps, options);
  const persisted = await persistPayload(command, options.json ? renderedPayload : payload, deps);
  const finalPayload = options.json
    ? persisted.payload
    : {
        ...renderedPayload,
        report_file: persisted.payload.report_file,
        report_url: persisted.payload.report_url
      };

  if (options.json) {
    emitJson(output, finalPayload);
  } else {
    output[target](renderHumanResult(command, finalPayload, persisted.reportError ?? null, {
      useColor: shouldUseAnsiColor(deps.stdoutStream ?? process.stdout, deps.env ?? process.env)
    }));
  }

  return finalPayload;
}

export async function runCli(argv, deps = {}) {
  const output = createOutput(deps);
  const jsonRequested = Array.isArray(argv) && argv.includes("--json");
  const progress = createProgressReporter({
    command: Array.isArray(argv) && argv[0] && !String(argv[0]).startsWith("--") ? argv[0] : deps.forcedCommand ?? "command",
    json: jsonRequested,
    stdout: output.stdout,
    stderr: output.stderr,
    stdoutStream: deps.stdoutStream ?? process.stdout,
    stderrStream: deps.stderrStream ?? process.stderr
  });
  let parsed;

  try {
    parsed = parseArgs(argv, deps.forcedCommand);
  } catch (error) {
    await emitFinal(output, deps.forcedCommand ?? argv?.[0] ?? "cli", {
      status: "FAIL",
      version: PACKAGE_VERSION,
      package_name: PACKAGE_NAME,
      code: error?.code ?? "USAGE_ERROR",
      message: safeErrorMessage(error),
      exit_code: error?.exitCode ?? EXIT_USAGE
    }, deps, { json: jsonRequested }, "stderr");
    return error?.exitCode ?? EXIT_USAGE;
  }

  if (parsed.command === "help") {
    output.stdout(HELP_TEXT);
    return 0;
  }

  if (parsed.command === "version") {
    output.stdout(`${PACKAGE_VERSION}\n`);
    return 0;
  }

  try {
    if (parsed.command === COMMAND_INSTRUCTIONS) {
      const payload = sanitizePayload({
        schema_version: 1,
        version: PACKAGE_VERSION,
        package_name: PACKAGE_NAME,
        ...(await readInstructions(deps))
      }, deps, parsed.options);
      if (parsed.options.json) {
        emitJson(output, payload);
      } else {
        output.stdout(`${payload.instructions}\n`);
      }
      return payload.status === "PASS" ? 0 : 2;
    }

    if (parsed.command === COMMAND_DOCTOR) {
      const doctorRunner = deps.runDoctor ?? runDoctor;
      progress.start();
      const result = await doctorRunner(parsed.options, deps);
      progress.stop();
      await emitFinal(output, parsed.command, result, deps, parsed.options);
      return result.exit_code;
    }

    if (!parsed.options.yes && !parsed.options.dryRun) {
      const confirmed = await confirmMutation(parsed.command, parsed.options, deps);
      if (!confirmed) {
        await emitFinal(output, parsed.command, {
          status: "CANCELLED",
          code: "USER_CANCELLED",
          version: PACKAGE_VERSION,
          package_name: PACKAGE_NAME,
          exit_code: 0
        }, deps, parsed.options);
        return 0;
      }
    }

    const installerRunner = deps.runInstaller ?? runInstaller;
    progress.start();
    const result = await installerRunner(parsed.command, parsed.options, deps);
    progress.stop();
    await emitFinal(output, parsed.command, result, deps, parsed.options);
    return result.exit_code;
  } catch (error) {
    progress.stop();
    const exitCode = error instanceof UsageError ? EXIT_USAGE : EXIT_INTERNAL;
    await emitFinal(output, parsed.command, {
      status: "FAIL",
      version: PACKAGE_VERSION,
      package_name: PACKAGE_NAME,
      code: error instanceof UsageError ? "USAGE_ERROR" : "INTERNAL_ERROR",
      message: safeErrorMessage(error),
      exit_code: exitCode
    }, deps, parsed.options, "stderr");
    return exitCode;
  }
}
