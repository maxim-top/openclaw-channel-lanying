import { logDebug } from "../shared/logging.js";
import { asPlainObject, pickId } from "../shared/utils.js";

const GLOBAL_SESSION_LOGGER_INSTALLED = "__clawchatSessionLoggerInstalled";
const SESSION_SYNC_DEDUPE_TTL_MS = 30_000;
const SESSION_SOURCE_TTL_MS = 30 * 60_000;
const FORWARDED_USER_TURN_TTL_MS = 60_000;
const RECENT_UPDATES_LIMIT = 20;
const BODY_PREVIEW_MAX = 200;
const CLAWCHAT_CHANNEL_IDS = new Set(["clawchat", "clawchat-router", "lanying"]);
const LEADING_TIMESTAMP_PREFIX_RE = /^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] */;
const INBOUND_META_SENTINELS = [
  "Conversation info (untrusted metadata):",
  "Sender (untrusted metadata):",
  "Thread starter (untrusted, for context):",
  "Replied message (untrusted, for context):",
  "Forwarded message context (untrusted metadata):",
  "Chat history since last reply (untrusted, for context):",
] as const;

export type SessionMessageSyncSource =
  | "control_ui_user"
  | "control_ui_reply"
  | "im_inbound_user"
  | "im_inbound_reply";

type RememberedSessionSource = "control_ui" | "im_inbound";

type SessionTranscriptUpdate = {
  sessionFile: string;
  sessionKey?: string;
  message?: unknown;
  messageId?: string;
  source?: SessionMessageSyncSource;
};

type SessionLoggerSnapshot = {
  at: number;
  sessionKey: string;
  messageId?: string;
  source?: SessionMessageSyncSource;
  role?: string;
  bodyPreview?: string;
};

type SessionLoggerInstallOptions = {
  onSessionTranscriptUpdate?: (update: SessionTranscriptUpdate) => void | Promise<void>;
};

const recentUpdateKeys = new Map<string, number>();
const recentSessionSources = new Map<string, { source: RememberedSessionSource; seenAt: number }>();
const recentForwardedControlUiUsers = new Map<
  string,
  { normalizedText: string; seenAt: number; messageId?: string }
>();
const recentSnapshots: SessionLoggerSnapshot[] = [];

function cleanupRecentState(now = Date.now()): void {
  for (const [key, seenAt] of recentUpdateKeys.entries()) {
    if (now - seenAt > SESSION_SYNC_DEDUPE_TTL_MS) {
      recentUpdateKeys.delete(key);
    }
  }
  for (const [key, entry] of recentSessionSources.entries()) {
    if (now - entry.seenAt > SESSION_SOURCE_TTL_MS) {
      recentSessionSources.delete(key);
    }
  }
  for (const [key, entry] of recentForwardedControlUiUsers.entries()) {
    if (now - entry.seenAt > FORWARDED_USER_TURN_TTL_MS) {
      recentForwardedControlUiUsers.delete(key);
    }
  }
}

function normalizeHint(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isSupportedSyncSource(value: unknown): value is SessionMessageSyncSource {
  return (
    value === "control_ui_user" ||
    value === "control_ui_reply" ||
    value === "im_inbound_user" ||
    value === "im_inbound_reply"
  );
}

function resolveSessionIdentity(update: SessionTranscriptUpdate): string {
  return (pickId(update.sessionKey) || update.sessionFile || "").trim().toLowerCase();
}

function hasClawchatChannelHint(value: unknown): boolean {
  return CLAWCHAT_CHANNEL_IDS.has(normalizeHint(value));
}

function isOpenClawGeneratedMirror(message: Record<string, unknown> | null): boolean {
  if (!message || normalizeHint(message.provider) !== "openclaw") {
    return false;
  }
  const model = normalizeHint(message.model);
  return model === "delivery-mirror" || model === "gateway-injected";
}

function extractSyncSource(value: unknown): SessionMessageSyncSource | null {
  return isSupportedSyncSource(value) ? value : null;
}

function extractMessageSyncSource(message: Record<string, unknown> | null): SessionMessageSyncSource | null {
  if (!message) {
    return null;
  }
  const openclawMeta = asPlainObject(message.__openclaw);
  return (
    extractSyncSource(message.syncSource) ||
    extractSyncSource(message.source) ||
    extractSyncSource(openclawMeta?.syncSource) ||
    extractSyncSource(openclawMeta?.source)
  );
}

function rememberSessionSource(
  sessionIdentity: string,
  source: RememberedSessionSource | null,
  now = Date.now(),
): void {
  if (!sessionIdentity || !source) {
    return;
  }
  recentSessionSources.set(sessionIdentity, { source, seenAt: now });
}

function resolveRememberedSessionSource(
  sessionIdentity: string,
  now = Date.now(),
): RememberedSessionSource | null {
  if (!sessionIdentity) {
    return null;
  }
  cleanupRecentState(now);
  const remembered = recentSessionSources.get(sessionIdentity);
  if (!remembered) {
    return null;
  }
  remembered.seenAt = now;
  recentSessionSources.set(sessionIdentity, remembered);
  return remembered.source;
}

function messageLooksLikeClawchatInbound(message: Record<string, unknown> | null): boolean {
  if (!message) {
    return false;
  }
  if (
    hasClawchatChannelHint(message.OriginatingChannel) ||
    hasClawchatChannelHint(message.Provider) ||
    hasClawchatChannelHint(message.Surface)
  ) {
    return true;
  }
  const provenance = asPlainObject(message.provenance);
  if (hasClawchatChannelHint(provenance?.sourceChannel)) {
    return true;
  }
  const sourceTool = normalizeHint(provenance?.sourceTool);
  return sourceTool.includes("clawchat") || sourceTool.includes("lanying");
}

function isSubagentBootstrapUserTurn(
  sessionIdentity: string,
  message: Record<string, unknown> | null,
): boolean {
  if (!message || !sessionIdentity.includes(":subagent:")) {
    return false;
  }
  const visibleText = extractMessageVisibleText(message.content);
  if (!visibleText) {
    return false;
  }
  const normalizedText = visibleText.trim();
  return (
    normalizedText.includes("[Subagent Task]:") ||
    normalizedText.startsWith("[Subagent Context] You are running as a subagent")
  );
}

function shouldLogSubagentBootstrapTranscriptUpdate(update: SessionTranscriptUpdate): boolean {
  const sessionIdentity = resolveSessionIdentity(update);
  if (!sessionIdentity.includes(":subagent:")) {
    return false;
  }
  const message = asPlainObject(update.message);
  const role = normalizeHint(message?.role ?? message?.authorRole);
  if (role !== "user") {
    return false;
  }
  return isSubagentBootstrapUserTurn(sessionIdentity, message);
}

function resolveUserMessageSyncSource(
  sessionIdentity: string,
  message: Record<string, unknown> | null,
): SessionMessageSyncSource | null {
  if (!message || isOpenClawGeneratedMirror(message)) {
    return null;
  }
  if (messageLooksLikeClawchatInbound(message)) {
    return "im_inbound_user";
  }
  const provenance = asPlainObject(message.provenance);
  const sourceChannel = normalizeHint(provenance?.sourceChannel);
  const sourceTool = normalizeHint(provenance?.sourceTool);
  if (sourceChannel || sourceTool) {
    if (isSubagentBootstrapUserTurn(sessionIdentity, message)) {
      return "control_ui_user";
    }
    return sourceChannel === "webchat" ? "control_ui_user" : null;
  }
  return "control_ui_user";
}

function resolveReplySyncSource(
  sessionIdentity: string,
  message: Record<string, unknown> | null,
): SessionMessageSyncSource | null {
  if (!message || isOpenClawGeneratedMirror(message)) {
    return null;
  }
  const remembered = resolveRememberedSessionSource(sessionIdentity);
  if (remembered === "control_ui") {
    return "control_ui_reply";
  }
  if (remembered === "im_inbound") {
    return "im_inbound_reply";
  }
  return null;
}

function isInboundMetaSentinelLine(line: string): boolean {
  const trimmed = line.trim();
  return INBOUND_META_SENTINELS.some((sentinel) => sentinel === trimmed);
}

function stripInboundMetadata(text: string): string {
  if (!text) {
    return text;
  }
  const withoutTimestamp = text.replace(LEADING_TIMESTAMP_PREFIX_RE, "");
  const lines = withoutTimestamp.split("\n");
  const result: string[] = [];
  let inMetaBlock = false;
  let inFencedJson = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!inMetaBlock && isInboundMetaSentinelLine(line)) {
      const next = lines[i + 1] ?? "";
      if (next.trim() !== "```json") {
        result.push(line);
        continue;
      }
      inMetaBlock = true;
      inFencedJson = false;
      continue;
    }
    if (inMetaBlock) {
      if (!inFencedJson && line.trim() === "```json") {
        inFencedJson = true;
        continue;
      }
      if (inFencedJson && line.trim() === "```") {
        inMetaBlock = false;
        inFencedJson = false;
        while (i + 1 < lines.length && (lines[i + 1] ?? "").trim() === "") {
          i += 1;
        }
        continue;
      }
      continue;
    }
    result.push(line);
  }

  return result.join("\n").trim().replace(LEADING_TIMESTAMP_PREFIX_RE, "").trim();
}

function normalizeVisibleUserText(text: string): string {
  return stripInboundMetadata(text).replace(/\s+/g, " ").trim();
}

function hasInjectedMetadataEnvelope(text: string): boolean {
  if (!text) {
    return false;
  }
  if (LEADING_TIMESTAMP_PREFIX_RE.test(text)) {
    return true;
  }
  const normalized = text.trim();
  return INBOUND_META_SENTINELS.some((sentinel) => normalized.includes(sentinel));
}

function extractMessageVisibleText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        const obj = asPlainObject(item);
        if (!obj) {
          return "";
        }
        if (typeof obj.text === "string") {
          return obj.text;
        }
        return extractMessageVisibleText(obj.content);
      })
      .filter(Boolean)
      .join("\n\n");
  }
  const obj = asPlainObject(value);
  if (!obj) {
    return "";
  }
  if (typeof obj.text === "string") {
    return obj.text;
  }
  if (Object.prototype.hasOwnProperty.call(obj, "content")) {
    return extractMessageVisibleText(obj.content);
  }
  return "";
}

function shouldSuppressDuplicatedControlUiUser(update: SessionTranscriptUpdate): boolean {
  const sessionIdentity = resolveSessionIdentity(update);
  if (!sessionIdentity) {
    return false;
  }
  const message = asPlainObject(update.message);
  if (isSubagentBootstrapUserTurn(sessionIdentity, message)) {
    return false;
  }
  const rawVisibleText = extractMessageVisibleText(message?.content);
  const strippedVisibleText = normalizeVisibleUserText(rawVisibleText);
  if (!strippedVisibleText) {
    return false;
  }
  const injectedEnvelope = hasInjectedMetadataEnvelope(rawVisibleText);
  const now = Date.now();
  cleanupRecentState(now);
  const previous = recentForwardedControlUiUsers.get(sessionIdentity);

  if (!injectedEnvelope) {
    recentForwardedControlUiUsers.set(sessionIdentity, {
      normalizedText: strippedVisibleText,
      seenAt: now,
      messageId: update.messageId,
    });
    return false;
  }

  if (!previous?.normalizedText) {
    return true;
  }

  const previousText = previous.normalizedText;
  return (
    strippedVisibleText === previousText ||
    strippedVisibleText.includes(previousText) ||
    previousText.includes(strippedVisibleText)
  );
}

function resolveUpdateSyncSource(update: SessionTranscriptUpdate): SessionMessageSyncSource | null {
  const sessionIdentity = resolveSessionIdentity(update);
  const message = asPlainObject(update.message);
  const explicitSource = extractSyncSource(update.source) || extractMessageSyncSource(message);
  if (explicitSource) {
    rememberSessionSource(
      sessionIdentity,
      explicitSource.startsWith("control_ui") ? "control_ui" : "im_inbound",
    );
    return explicitSource;
  }
  const role = normalizeHint(message?.role ?? message?.authorRole);
  if (role === "user") {
    const source = resolveUserMessageSyncSource(sessionIdentity, message);
    rememberSessionSource(
      sessionIdentity,
      source === "control_ui_user" ? "control_ui" : source === "im_inbound_user" ? "im_inbound" : null,
    );
    return source;
  }
  if (role === "assistant") {
    return resolveReplySyncSource(sessionIdentity, message);
  }
  return null;
}

function shouldProcessUpdate(update: SessionTranscriptUpdate): boolean {
  const syncSource = resolveUpdateSyncSource(update);
  if (syncSource !== "control_ui_user" && syncSource !== "control_ui_reply") {
    return false;
  }
  if (syncSource === "control_ui_user" && shouldSuppressDuplicatedControlUiUser(update)) {
    return false;
  }
  const sessionKey = resolveSessionIdentity(update);
  const message = asPlainObject(update.message);
  const timestamp = Number(message?.timestamp ?? message?.createdAt ?? 0) || 0;
  const role = normalizeHint(message?.role ?? message?.authorRole);
  const bodyPreview = extractBodyPreview(update.message);
  const dedupeKey = [
    "transcript",
    sessionKey,
    update.messageId ?? "",
    syncSource,
    role,
    String(timestamp),
    bodyPreview,
  ].join("|");
  const now = Date.now();
  cleanupRecentState(now);
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
    sessionKey: resolveSessionIdentity(update),
    messageId: update.messageId,
    source: resolveUpdateSyncSource(update) ?? undefined,
    role: normalizeHint(message?.role ?? message?.authorRole) || undefined,
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
        snapshot.source ? `source=${snapshot.source}` : "",
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
  recentSessionSources.clear();
  recentForwardedControlUiUsers.clear();
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
    if (shouldLogSubagentBootstrapTranscriptUpdate(update)) {
      const sessionIdentity = resolveSessionIdentity(update);
      const message = asPlainObject(update.message);
      logDebug("subagent bootstrap transcript update observed", {
        session: sessionIdentity,
        messageId: update.messageId,
        role: normalizeHint(message?.role ?? message?.authorRole) || undefined,
        bodyPreview: extractBodyPreview(update.message) || undefined,
      });
    }
    const source = resolveUpdateSyncSource(update);
    if (!shouldProcessUpdate(update)) {
      return;
    }
    const nextUpdate = source ? { ...update, source } : update;
    rememberSnapshot(nextUpdate);
    void options.onSessionTranscriptUpdate?.(nextUpdate);
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
