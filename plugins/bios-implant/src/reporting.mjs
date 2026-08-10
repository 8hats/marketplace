import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { atomicWriteJson } from "./util.mjs";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const SPINNER_FRAMES = ["|", "/", "-", "\\"];

function ignoreModeError(error) {
  return [
    "EPERM",
    "EACCES",
    "EINVAL",
    "ENOTSUP",
    "ENOSYS",
    "EROFS"
  ].includes(error?.code);
}

function commandSlug(command) {
  return String(command ?? "cli").replace(/[^a-z0-9_-]+/giu, "-").replace(/^-+|-+$/gu, "") || "cli";
}

function statusSlug(status) {
  return String(status ?? "report").toLowerCase();
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/gu, "-");
}

async function chmodIfSupported(targetPath, mode) {
  if (process.platform === "win32") {
    return;
  }

  await fsp.chmod(targetPath, mode).catch((error) => {
    if (!ignoreModeError(error)) {
      throw error;
    }
  });
}

export function resolveReportRoot(deps = {}, homeDirectory = os.homedir()) {
  const env = deps.env ?? process.env;
  const configuredRoot = deps.reportRoot ?? env.BIOS_IMPLANT_REPORT_DIR;
  if (configuredRoot) {
    return path.resolve(configuredRoot);
  }

  return path.join(path.resolve(homeDirectory), ".agent-university", "bios-implant-reports");
}

export async function persistReport(payload, deps = {}, options = {}) {
  const reportRoot = resolveReportRoot(deps, options.homeDirectory);
  const fileName = `${timestampSlug(options.now)}-${commandSlug(options.command)}-${statusSlug(payload.status)}-${process.pid}-${randomUUID()}.json`;
  const filePath = path.join(reportRoot, fileName);
  const fileUrl = pathToFileURL(filePath).href;
  const reportPayload = {
    ...payload,
    report_file: filePath,
    report_url: fileUrl
  };

  await fsp.mkdir(reportRoot, { recursive: true, mode: DIRECTORY_MODE });
  await chmodIfSupported(reportRoot, DIRECTORY_MODE);
  await atomicWriteJson(filePath, reportPayload, { mode: FILE_MODE });

  return {
    payload: reportPayload,
    reportRoot,
    reportFile: filePath,
    reportUrl: fileUrl
  };
}

export function createProgressReporter({ command, json, stdout, stderr, stdoutStream, stderrStream }) {
  if (json) {
    return {
      start() {},
      stop() {}
    };
  }

  const target = stderr ?? stdout;
  const stream = stderrStream ?? stdoutStream;
  const interactive = Boolean(stream?.isTTY);
  const label = `Running BIOS Implant ${command}...`;
  let timer = null;
  let index = 0;
  let active = false;

  return {
    start() {
      if (active) {
        return;
      }
      active = true;
      if (interactive) {
        target(`${SPINNER_FRAMES[index]} ${label}\r`);
        timer = setInterval(() => {
          index = (index + 1) % SPINNER_FRAMES.length;
          target(`${SPINNER_FRAMES[index]} ${label}\r`);
        }, 80);
        return;
      }

      target(`${label}\n`);
    },
    stop() {
      if (!active) {
        return;
      }
      active = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (interactive) {
        target(`${" ".repeat(label.length + 4)}\r`);
      }
    }
  };
}
