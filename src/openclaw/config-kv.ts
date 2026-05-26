import { createHash } from "node:crypto";

import { getClawchatRuntime } from "../runtime.js";
import { logDebug, logWarn } from "../shared/logging.js";
import { asPlainObject } from "../shared/utils.js";
import { type ConfigBatchEntry } from "../types.js";

const CONFIG_COMMAND_TIMEOUT_MS = 30_000;
const CONFIG_COMMAND_CONFLICT_RETRY_MAX_ATTEMPTS = 3;
const CONFIG_COMMAND_CONFLICT_RETRY_DELAY_MS = 150;

export function summarizeCommandArgvForLog(argv: string[]): Record<string, unknown> {
  const batchJsonIndex = argv.indexOf("--batch-json");
  if (batchJsonIndex < 0 || batchJsonIndex + 1 >= argv.length) {
    return {
      argv,
    };
  }
  let batchItems = 0;
  let batchPaths: string[] = [];
  try {
    const payload = JSON.parse(argv[batchJsonIndex + 1]);
    if (Array.isArray(payload)) {
      batchItems = payload.length;
      batchPaths = payload
        .map((item) =>
          item && typeof item === "object" && !Array.isArray(item) ? String((item as { path?: unknown }).path ?? "").trim() : "",
        )
        .filter(Boolean);
    }
  } catch {
    batchItems = 0;
    batchPaths = [];
  }
  return {
    argvHead: argv.slice(0, batchJsonIndex + 1),
    hasBatchJson: true,
    batchItems,
    batchPaths,
  };
}

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
  // Avoid the safe-restart RPC path here because it requires operator.admin
  // scope and can trigger pairing/scope-upgrade prompts during plugin-managed
  // local config sync.
  return ["openclaw", "gateway", "restart"];
}

function isGatewayRestartArgv(argv: string[]): boolean {
  return argv.length === 3 && argv[0] === "openclaw" && argv[1] === "gateway" && argv[2] === "restart";
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
  const commandLog = summarizeCommandArgvForLog(argv);
  for (let attempt = 1; attempt <= CONFIG_COMMAND_CONFLICT_RETRY_MAX_ATTEMPTS; attempt += 1) {
    logDebug("exec openclaw config command", { ...commandLog, attempt });
    const result = await runtime.system.runCommandWithTimeout(argv, {
      timeoutMs: CONFIG_COMMAND_TIMEOUT_MS,
    });
    const { stdout, stderr, exitCode } = extractCommandFailure(result);
    if (stderr.trim()) {
      logWarn("openclaw config command stderr", {
        ...commandLog,
        attempt,
        stderr: stderr.trim(),
      });
    }
    if (exitCode === 0) {
      return;
    }
    const combined = `${stdout}\n${stderr}`.trim();
    if (isGatewayRestartArgv(argv) && exitCode === 1 && !combined) {
      logDebug("treat gateway restart exit code as success because supervisor restart likely interrupted the cli", {
        ...commandLog,
        attempt,
        exitCode,
      });
      return;
    }
    const retryableConflict = isRetryableConfigConflictMessage(combined);
    if (retryableConflict && attempt < CONFIG_COMMAND_CONFLICT_RETRY_MAX_ATTEMPTS) {
      logWarn("retry openclaw config command after stale config conflict", {
        ...commandLog,
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
