import { asPlainObject, pickId } from "../shared/utils.js";

const GLOBAL_SESSION_LOGGER_INSTALLED = "__clawchatSessionLoggerInstalled";
const SESSION_SYNC_DEDUPE_TTL_MS = 30_000;
const RECENT_UPDATES_LIMIT = 20;
const BODY_PREVIEW_MAX = 200;

type SessionTranscriptUpdate = {
  sessionFile: string;
  sessionKey?: string;
  message?: unknown;
  messageId?: string;
};

type SessionLoggerSnapshot = {
  at: number;
  sessionKey: string;
  messageId?: string;
  role?: string;
  bodyPreview?: string;
};

type SessionLoggerInstallOptions = {
  onSessionTranscriptUpdate?: (update: SessionTranscriptUpdate) => void | Promise<void>;
};

const recentUpdateKeys = new Map<string, number>();
const recentSnapshots: SessionLoggerSnapshot[] = [];

function cleanupRecentUpdateKeys(now = Date.now()): void {
  for (const [key, seenAt] of recentUpdateKeys.entries()) {
    if (now - seenAt > SESSION_SYNC_DEDUPE_TTL_MS) {
      recentUpdateKeys.delete(key);
    }
  }
}

function shouldProcessUpdate(update: SessionTranscriptUpdate): boolean {
  const sessionKey = pickId(update.sessionKey) || update.sessionFile || "";
  const message = asPlainObject(update.message);
  const timestamp = Number(message?.timestamp ?? message?.createdAt ?? 0) || 0;
  const role = String(message?.role ?? message?.authorRole ?? "").trim().toLowerCase();
  const bodyPreview = extractBodyPreview(update.message);
  const dedupeKey = [
    "transcript",
    sessionKey,
    update.messageId ?? "",
    role,
    String(timestamp),
    bodyPreview,
  ].join("|");
  const now = Date.now();
  cleanupRecentUpdateKeys(now);
  if (recentUpdateKeys.has(dedupeKey)) {
    return false;
  }
  recentUpdateKeys.set(dedupeKey, now);
  return true;
}

function extractBodyPreview(value: unknown): string {
  if (typeof value === "string") {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > BODY_PREVIEW_MAX
      ? `${normalized.slice(0, BODY_PREVIEW_MAX)}...`
      : normalized;
  }
  if (Array.isArray(value)) {
    return extractBodyPreview(
      value
        .map((item) => extractBodyPreview(item))
        .filter(Boolean)
        .join(" "),
    );
  }
  const obj = asPlainObject(value);
  if (!obj) {
    return "";
  }
  const candidates = [
    obj.text,
    obj.content,
    obj.value,
    obj.output_text,
    obj.input_text,
    obj.title,
    obj.label,
  ];
  for (const candidate of candidates) {
    const preview = extractBodyPreview(candidate);
    if (preview) {
      return preview;
    }
  }
  return "";
}

function rememberSnapshot(update: SessionTranscriptUpdate): void {
  const message = asPlainObject(update.message);
  recentSnapshots.push({
    at: Date.now(),
    sessionKey: pickId(update.sessionKey) || update.sessionFile || "",
    messageId: update.messageId,
    role: String(message?.role ?? message?.authorRole ?? "").trim().toLowerCase() || undefined,
    bodyPreview: extractBodyPreview(update.message) || undefined,
  });
  if (recentSnapshots.length > RECENT_UPDATES_LIMIT) {
    recentSnapshots.shift();
  }
}

export function formatGlobalOpenClawSessionLoggerStatus(): string {
  const lines = [
    "ClawChat session sync status",
    `recent updates: ${recentSnapshots.length}`,
  ];
  for (const snapshot of recentSnapshots.slice(-10)) {
    lines.push(
      [
        new Date(snapshot.at).toISOString(),
        `session=${snapshot.sessionKey}`,
        snapshot.messageId ? `messageId=${snapshot.messageId}` : "",
        snapshot.role ? `role=${snapshot.role}` : "",
        snapshot.bodyPreview ? `body="${snapshot.bodyPreview}"` : "",
      ]
        .filter(Boolean)
        .join(" | "),
    );
  }
  return lines.join("\n");
}

export function resetGlobalOpenClawSessionLoggerStatus(): string {
  recentUpdateKeys.clear();
  recentSnapshots.length = 0;
  return "ClawChat session sync status reset.";
}

export function installGlobalOpenClawSessionLogger(
  runtime: unknown,
  options: SessionLoggerInstallOptions = {},
): () => void {
  const runtimeObj = asPlainObject(runtime);
  if (!runtimeObj) {
    return () => {};
  }

  const existing = (runtimeObj as Record<string, unknown>)[GLOBAL_SESSION_LOGGER_INSTALLED];
  if (typeof existing === "function") {
    return existing as () => void;
  }

  const events = asPlainObject(runtimeObj.events);
  if (!events || typeof events.onSessionTranscriptUpdate !== "function") {
    const noopDispose = () => {};
    (runtimeObj as Record<string, unknown>)[GLOBAL_SESSION_LOGGER_INSTALLED] = noopDispose;
    return noopDispose;
  }

  const off = (
    events.onSessionTranscriptUpdate as (
      listener: (update: SessionTranscriptUpdate) => void,
    ) => () => void
  )((update) => {
    if (!shouldProcessUpdate(update)) {
      return;
    }
    rememberSnapshot(update);
    void options.onSessionTranscriptUpdate?.(update);
  });

  const dispose = () => {
    try {
      off?.();
    } finally {
      if ((runtimeObj as Record<string, unknown>)[GLOBAL_SESSION_LOGGER_INSTALLED] === dispose) {
        delete (runtimeObj as Record<string, unknown>)[GLOBAL_SESSION_LOGGER_INSTALLED];
      }
    }
  };

  (runtimeObj as Record<string, unknown>)[GLOBAL_SESSION_LOGGER_INSTALLED] = dispose;
  return dispose;
}
