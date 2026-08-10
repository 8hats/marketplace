import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

function sortJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [key, sortJsonValue(value[key])])
    );
  }

  return value;
}

function resolveExecutableCandidates(command) {
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const windowsExtensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .filter(Boolean)
      : [""];

  if (command.includes(path.sep)) {
    return [command];
  }

  const candidates = [];
  for (const entry of pathEntries) {
    for (const extension of windowsExtensions) {
      candidates.push(path.join(entry, `${command}${extension}`));
    }
  }

  return candidates;
}

export function safeErrorMessage(error) {
  if (typeof error === "string" && error.trim()) {
    return error;
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return "Unexpected error";
}

export function stableJson(value) {
  return `${JSON.stringify(sortJsonValue(value), null, 2)}${os.EOL}`;
}

export function packageRootFrom(moduleUrl) {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..");
}

export function commandExists(command) {
  if (!command || typeof command !== "string") {
    return false;
  }

  const candidates = resolveExecutableCandidates(command);
  return candidates.some((candidate) => {
    try {
      if (!fs.existsSync(candidate)) {
        return false;
      }

      const stat = fs.statSync(candidate);
      if (!stat.isFile()) {
        return false;
      }

      if (process.platform === "win32") {
        return true;
      }

      const probe = spawnSync(candidate, ["--version"], {
        shell: false,
        stdio: "ignore"
      });

      return !probe.error || probe.status !== null;
    } catch {
      return false;
    }
  });
}

export async function readJsonIfExists(filePath) {
  try {
    const content = await fsp.readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function ignoreModeError(error) {
  if (!error || typeof error !== "object") {
    return false;
  }

  return [
    "EPERM",
    "EACCES",
    "EINVAL",
    "ENOTSUP",
    "ENOSYS",
    "EROFS"
  ].includes(error.code);
}

export async function atomicWriteJson(filePath, value, options = {}) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  const requestedMode =
    Number.isInteger(options?.mode) && options.mode >= 0 ? options.mode : undefined;
  let handle;
  let renamed = false;

  await fsp.mkdir(directory, { recursive: true });
  try {
    handle = await fsp.open(temporaryPath, "wx", requestedMode);
    await handle.writeFile(stableJson(value), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;

    if (requestedMode !== undefined && process.platform !== "win32") {
      await fsp.chmod(temporaryPath, requestedMode).catch((error) => {
        if (!ignoreModeError(error)) {
          throw error;
        }
      });
    }

    await fsp.rename(temporaryPath, filePath);
    renamed = true;

    if (requestedMode !== undefined && process.platform !== "win32") {
      await fsp.chmod(filePath, requestedMode).catch((error) => {
        if (!ignoreModeError(error)) {
          throw error;
        }
      });
    }
  } catch (error) {
    throw error;
  } finally {
    await handle?.close().catch(() => {});
    if (!renamed) {
      await fsp.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }
}

export async function copyDirectory(sourceDirectory, targetDirectory) {
  await fsp.mkdir(path.dirname(targetDirectory), { recursive: true });
  await fsp.cp(sourceDirectory, targetDirectory, {
    recursive: true,
    force: true,
    errorOnExist: false
  });
}

export async function atomicReplaceDirectory(sourceDirectory, targetDirectory) {
  const parentDirectory = path.dirname(targetDirectory);
  const backupDirectory = path.join(
    parentDirectory,
    `.${path.basename(targetDirectory)}.${process.pid}.${Date.now()}.bak`
  );

  await fsp.mkdir(parentDirectory, { recursive: true });

  let existingTargetMoved = false;
  try {
    await fsp.rename(targetDirectory, backupDirectory);
    existingTargetMoved = true;
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT") {
      throw error;
    }
  }

  try {
    await fsp.rename(sourceDirectory, targetDirectory);
  } catch (error) {
    if (existingTargetMoved) {
      await fsp.rename(backupDirectory, targetDirectory);
    }
    throw error;
  }

  if (existingTargetMoved) {
    await fsp.rm(backupDirectory, { recursive: true, force: true });
  }
}

export function runCommand(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.round(options.timeoutMs)
      : 10_000;
    const maxOutputBytes = Number.isFinite(options.maxOutputBytes) && options.maxOutputBytes > 0
      ? Math.round(options.maxOutputBytes)
      : 1024 * 1024;
    const terminationGraceMs = Number.isFinite(options.terminationGraceMs) && options.terminationGraceMs > 0
      ? Math.round(options.terminationGraceMs)
      : 500;
    const hardSettleGraceMs = 50;
    const isolatedProcessGroup = process.platform !== "win32";
    const child = spawn(command, args, {
      shell: false,
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? "pipe",
      detached: isolatedProcessGroup
    });

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;
    let forceKillTimer;
    let hardSettleTimer;

    function clearCommandTimers() {
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      clearTimeout(hardSettleTimer);
    }

    function terminate(signal) {
      if (isolatedProcessGroup && Number.isInteger(child.pid)) {
        try {
          process.kill(-child.pid, signal);
          return true;
        } catch (error) {
          if (error?.code === "ESRCH") {
            return false;
          }
        }
      }
      try {
        return child.kill(signal);
      } catch {
        return false;
      }
    }

    function commandResult(code, signal) {
      return {
        command,
        args: [...args],
        exitCode: code ?? 1,
        signal,
        stdout,
        stderr,
        timedOut,
        outputTruncated
      };
    }

    function timeoutError(result) {
      const error = new Error(`${command} timed out after ${timeoutMs}ms`);
      error.code = "COMMAND_TIMEOUT";
      error.result = result;
      return error;
    }

    function settleTimedOutCommand(signal) {
      if (settled) {
        return;
      }
      settled = true;
      clearCommandTimers();
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref?.();
      reject(timeoutError(commandResult(null, signal)));
    }

    const timer = setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        terminate("SIGKILL");
        hardSettleTimer = setTimeout(() => settleTimedOutCommand("SIGKILL"), hardSettleGraceMs);
        hardSettleTimer.unref?.();
      }, terminationGraceMs);
      forceKillTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();

    function capture(chunk, current) {
      const text = String(chunk);
      const remaining = Math.max(0, maxOutputBytes - outputBytes);
      if (remaining === 0) {
        outputTruncated = true;
        return current;
      }
      const bytes = Buffer.from(text);
      const accepted = bytes.subarray(0, remaining).toString("utf8");
      outputBytes += Buffer.byteLength(accepted);
      if (Buffer.byteLength(text) > remaining) {
        outputTruncated = true;
      }
      return current + accepted;
    }

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      if (timedOut) {
        settleTimedOutCommand(null);
        return;
      }
      settled = true;
      clearCommandTimers();
      reject(error);
    });

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdout = capture(chunk, stdout);
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderr = capture(chunk, stderr);
      });
    }

    if (child.stdin && options.keepStdin !== true) {
      child.stdin.end(options.input);
    }

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearCommandTimers();
      const result = commandResult(code, signal);

      if (!timedOut && (code === 0 || options.allowNonZero)) {
        resolve(result);
        return;
      }

      const error = timedOut
        ? timeoutError(result)
        : new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code ?? "unknown"}`);
      error.code = timedOut ? "COMMAND_TIMEOUT" : "COMMAND_FAILED";
      error.result = result;
      reject(error);
    });
  });
}
