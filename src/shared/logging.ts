import { maybeParseJson } from "./utils.js";

const LOG_MASK = "******";
const SENSITIVE_KEY_PATTERN =
  "(?:password|pass|pwd|api[_-]?key|token|secret|authorization|auth|cookie|session|private[_-]?key)";
const SENSITIVE_KEY_RE = new RegExp(SENSITIVE_KEY_PATTERN, "i");
const SESSION_KEY_ALLOWLIST = new Set([
  "session",
  "sessionkey",
  "sessioncount",
  "parentsession",
  "rootsession",
  "parentsessionkey",
  "rootsessionkey",
  "effectivetargetsessionkey",
]);
const SENSITIVE_INLINE_RE = new RegExp(
  `((?:${SENSITIVE_KEY_PATTERN})\\s*[:=]\\s*["']?)([^"',\\s}]+)(["']?)`,
  "gi",
);
const SENSITIVE_ESCAPED_JSON_RE = new RegExp(
  `((?:\\\\?["'])${SENSITIVE_KEY_PATTERN}(?:\\\\?["'])\\s*:\\s*(?:\\\\?["']))([^"\\\\]*(?:\\\\.[^"\\\\]*)*)(\\\\?["'])`,
  "gi",
);

let consoleRedactionInstalled = false;

function normalizeLogKey(value: string): string {
  return String(value || "")
    .trim()
    .replace(/[^a-z0-9]+/gi, "")
    .toLowerCase();
}

function shouldRedactKey(value: string): boolean {
  const normalized = normalizeLogKey(value);
  if (!normalized) {
    return false;
  }
  if (SESSION_KEY_ALLOWLIST.has(normalized)) {
    return false;
  }
  return SENSITIVE_KEY_RE.test(value);
}

export function maskText(value: string): string {
  if (!value) {
    return value;
  }
  return LOG_MASK;
}

export function redactString(value: string): string {
  const parsed = maybeParseJson(value);
  if (parsed && typeof parsed === "object") {
    try {
      return JSON.stringify(redactForLog(parsed));
    } catch {
      // Fall back to inline replacement.
    }
  }
  return value
    .replace(
      SENSITIVE_ESCAPED_JSON_RE,
      (_full, prefix: string, _secret: string, suffix: string) => `${prefix}${LOG_MASK}${suffix}`,
    )
    .replace(SENSITIVE_INLINE_RE, (_full, prefix: string, _secret: string, suffix: string) => {
      return `${prefix}${LOG_MASK}${suffix}`;
    });
}

export function redactForLog(value: unknown, parentKey = "", depth = 0): unknown {
  if (depth > 8) {
    return "[redaction-depth-limit]";
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(String(value.message ?? "")),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }
  if (typeof value === "string") {
    if (shouldRedactKey(parentKey)) {
      return maskText(value);
    }
    return redactString(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    if (shouldRedactKey(parentKey)) {
      return LOG_MASK;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactForLog(item, parentKey, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (shouldRedactKey(k)) {
        out[k] = LOG_MASK;
        continue;
      }
      out[k] = redactForLog(v, k, depth + 1);
    }
    return out;
  }
  return value;
}

export function installConsoleRedaction(): void {
  if (consoleRedactionInstalled) {
    return;
  }
  consoleRedactionInstalled = true;
  const methods: Array<"log" | "warn" | "error" | "info" | "debug"> = [
    "log",
    "warn",
    "error",
    "info",
    "debug",
  ];
  for (const method of methods) {
    const current = console[method].bind(console);
    console[method] = ((...args: unknown[]) => {
      const sanitized = args.map((arg) => redactForLog(arg));
      current(...sanitized);
    }) as typeof console[typeof method];
  }
}

export function logDebug(message: string, data?: unknown): void {
  if (data === undefined) {
    console.log(`[clawchat] ${message}`);
    return;
  }
  console.log(`[clawchat] ${message}`, redactForLog(data));
}

export function logWarn(message: string, data?: unknown): void {
  if (data === undefined) {
    console.warn(`[clawchat] ${message}`);
    return;
  }
  console.warn(`[clawchat] ${message}`, redactForLog(data));
}

export function logError(message: string, err?: unknown): void {
  if (err === undefined) {
    console.error(`[clawchat] ${message}`);
    return;
  }
  console.error(`[clawchat] ${message}`, redactForLog(err));
}

installConsoleRedaction();
