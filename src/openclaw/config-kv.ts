import { createHash } from "node:crypto";

import { getClawchatRuntime } from "../runtime.js";
import { logDebug, logWarn } from "../shared/logging.js";
import { asPlainObject } from "../shared/utils.js";
import { type ConfigBatchEntry } from "../types.js";

const CONFIG_COMMAND_TIMEOUT_MS = 30_000;
const CONFIG_COMMAND_CONFLICT_RETRY_MAX_ATTEMPTS = 3;
const CONFIG_COMMAND_CONFLICT_RETRY_DELAY_MS = 150;

export function normalizeConfigBatchEntryForDigest(entry: ConfigBatchEntry): Record<string, unknown> {
  return {
    path: entry.path.trim(),
    value: entry.value,
  };
}

export function createConfigBatchSyncDigest(batchEntries: ConfigBatchEntry[]): string {
  const normalized = batchEntries.map((entry) => normalizeConfigBatchEntryForDigest(entry));
  return createHash("sha1").update(JSON.stringify(normalized)).digest("hex").slice(0, 16);
}

export function buildConfigSetBatchEntries(batchEntries: ConfigBatchEntry[]): ConfigBatchEntry[] {
  return batchEntries.map((entry) => {
    const path = entry.path.trim();
    if (!path) {
      throw new Error("Config batch entry path is required.");
    }
    return { path, value: entry.value };
  });
}

export function buildConfigSetBatchArgv(batchEntries: ConfigBatchEntry[]): string[] {
  const normalizedEntries = buildConfigSetBatchEntries(batchEntries);
  return ["openclaw", "config", "set", "--batch-json", JSON.stringify(normalizedEntries)];
}

export function buildGatewayRestartArgv(): string[] {
  return ["openclaw", "gateway", "restart", "--safe"];
}

export function isRetryableConfigConflictMessage(message: string): boolean {
  const normalized = message.trim();
  if (!normalized) {
    return false;
  }
  return (
    /config changed since last load/i.test(normalized) ||
    /ConfigMutationConflictError/i.test(normalized)
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function extractCommandFailure(result: unknown): { stdout: string; stderr: string; exitCode: number } {
  const resultObj = asPlainObject(result);
  const stdout =
    typeof resultObj?.stdout === "string"
      ? resultObj.stdout
      : typeof resultObj?.output === "string"
        ? resultObj.output
        : typeof result === "string"
          ? result
          : "";
  const stderr =
    typeof resultObj?.stderr === "string"
      ? resultObj.stderr
      : typeof resultObj?.error === "string"
        ? resultObj.error
        : "";
  const exitCode =
    typeof resultObj?.exitCode === "number"
      ? resultObj.exitCode
      : typeof resultObj?.code === "number"
        ? resultObj.code
        : 0;
  return { stdout, stderr, exitCode };
}

export async function runCommandArgv(argv: string[]): Promise<void> {
  const runtime = getClawchatRuntime();
  for (let attempt = 1; attempt <= CONFIG_COMMAND_CONFLICT_RETRY_MAX_ATTEMPTS; attempt += 1) {
    logDebug("exec openclaw config command", { argv, attempt });
    const result = await runtime.system.runCommandWithTimeout(argv, {
      timeoutMs: CONFIG_COMMAND_TIMEOUT_MS,
    });
    const { stdout, stderr, exitCode } = extractCommandFailure(result);
    if (stderr.trim()) {
      logWarn("openclaw config command stderr", {
        argv,
        attempt,
        stderr: stderr.trim(),
      });
    }
    if (exitCode === 0) {
      return;
    }
    const combined = `${stdout}\n${stderr}`.trim();
    const retryableConflict = isRetryableConfigConflictMessage(combined);
    if (retryableConflict && attempt < CONFIG_COMMAND_CONFLICT_RETRY_MAX_ATTEMPTS) {
      logWarn("retry openclaw config command after stale config conflict", {
        argv,
        attempt,
        maxAttempts: CONFIG_COMMAND_CONFLICT_RETRY_MAX_ATTEMPTS,
      });
      await sleep(CONFIG_COMMAND_CONFLICT_RETRY_DELAY_MS * attempt);
      continue;
    }
    throw new Error(
      `openclaw config command failed (${argv.slice(0, 4).join(" ")}): ${combined || `exit code ${exitCode}`}`,
    );
  }
}

export async function applyConfigBatchEntries(batchEntries: ConfigBatchEntry[]): Promise<void> {
  const digest = createConfigBatchSyncDigest(batchEntries);
  const batchArgv = buildConfigSetBatchArgv(batchEntries);
  logDebug("apply config batch sync requested", {
    digest,
    items: batchEntries.length,
    paths: batchEntries.map((entry) => entry.path),
  });
  await runCommandArgv(batchArgv);
  logDebug("apply config batch sync finished", {
    digest,
    items: batchEntries.length,
  });
}
