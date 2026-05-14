import { logDebug, redactForLog } from "../shared/logging.js";
import { asPlainObject, pickId } from "../shared/utils.js";
import { normalizeClawchatSessionKey } from "../channel/message.js";

const GLOBAL_SESSION_LOGGER_INSTALLED = "__clawchatSessionLoggerInstalled";
const SESSION_SYNC_DEDUPE_TTL_MS = 30_000;
const SESSION_SOURCE_TTL_MS = 30 * 60_000;
const FORWARDED_USER_TURN_TTL_MS = 60_000;
const RECENT_MESSAGE_ID_TTL_MS = 5 * 60_000;
const RECENT_UPDATES_LIMIT = 20;
const BODY_PREVIEW_MAX = 200;
const CLAWCHAT_CHANNEL_IDS = new Set(["clawchat", "clawchat-router", "lanying"]);
const INTERNAL_RUNTIME_CONTEXT_BEGIN = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";
const INTERNAL_RUNTIME_CONTEXT_END = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
const OPENCLAW_RUNTIME_CONTEXT_NOTICE =
  "This context is runtime-generated, not user-authored. Keep internal details private.";
const OPENCLAW_NEXT_TURN_RUNTIME_CONTEXT_HEADER =
  "OpenClaw runtime context for the immediately preceding user message.";
const OPENCLAW_RUNTIME_EVENT_HEADER = "OpenClaw runtime event.";
const OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE = "openclaw.runtime-context";
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
type SessionSyncVariant = "im_subagent_bootstrap";

type SessionTranscriptUpdate = {
  sessionFile: string;
  sessionKey?: string;
  message?: unknown;
  messageId?: string;
  source?: SessionMessageSyncSource;
  syncVariant?: SessionSyncVariant;
  observedMessageType?: string;
  observedMessageTypeSource?: string;
};

type SessionLoggerSnapshot = {
  at: number;
  sessionKey: string;
  messageId?: string;
  source?: SessionMessageSyncSource;
  syncVariant?: SessionSyncVariant;
  role?: string;
  bodyPreview?: string;
};

type SessionLoggerInstallOptions = {
  onSessionTranscriptUpdate?: (update: SessionTranscriptUpdate) => void | Promise<void>;
};

const recentUpdateKeys = new Map<string, number>();
const recentObservedMessageIds = new Map<string, { seenAt: number; count: number }>();
const recentSessionSources = new Map<string, { source: RememberedSessionSource; seenAt: number }>();
const recentSessionSyncVariants = new Map<string, { variant: SessionSyncVariant; seenAt: number }>();
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
  for (const [key, entry] of recentObservedMessageIds.entries()) {
    if (now - entry.seenAt > RECENT_MESSAGE_ID_TTL_MS) {
      recentObservedMessageIds.delete(key);
    }
  }
  for (const [key, entry] of recentSessionSources.entries()) {
    if (now - entry.seenAt > SESSION_SOURCE_TTL_MS) {
      recentSessionSources.delete(key);
    }
  }
  for (const [key, entry] of recentSessionSyncVariants.entries()) {
    if (now - entry.seenAt > SESSION_SOURCE_TTL_MS) {
      recentSessionSyncVariants.delete(key);
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

function normalizeSessionIdentity(value: unknown): string {
  return normalizeClawchatSessionKey(value);
}

function isSupportedSyncSource(value: unknown): value is SessionMessageSyncSource {
  return (
    value === "control_ui_user" ||
    value === "control_ui_reply" ||
    value === "im_inbound_user" ||
    value === "im_inbound_reply"
  );
}

function isSupportedSyncVariant(value: unknown): value is SessionSyncVariant {
  return value === "im_subagent_bootstrap";
}

function resolveSessionIdentity(update: SessionTranscriptUpdate): string {
  return normalizeSessionIdentity(pickId(update.sessionKey) || update.sessionFile || "");
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

function extractSyncVariant(value: unknown): SessionSyncVariant | null {
  return isSupportedSyncVariant(value) ? value : null;
}

function extractMessageSyncVariant(message: Record<string, unknown> | null): SessionSyncVariant | null {
  if (!message) {
    return null;
  }
  const openclawMeta = asPlainObject(message.__openclaw);
  return extractSyncVariant(message.syncVariant) || extractSyncVariant(openclawMeta?.syncVariant);
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

function rememberSessionSyncVariant(
  sessionIdentity: string,
  variant: SessionSyncVariant | null,
  now = Date.now(),
): void {
  if (!sessionIdentity) {
    return;
  }
  if (!variant) {
    recentSessionSyncVariants.delete(sessionIdentity);
    return;
  }
  recentSessionSyncVariants.set(sessionIdentity, { variant, seenAt: now });
}

function consumeRememberedSessionSyncVariant(
  sessionIdentity: string,
  now = Date.now(),
): SessionSyncVariant | null {
  if (!sessionIdentity) {
    return null;
  }
  cleanupRecentState(now);
  const remembered = recentSessionSyncVariants.get(sessionIdentity);
  if (!remembered) {
    return null;
  }
  recentSessionSyncVariants.delete(sessionIdentity);
  return remembered.variant;
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
  return false;
}

function resolveCurrentMessageUserSyncSource(
  sessionIdentity: string,
  message: Record<string, unknown> | null,
): SessionMessageSyncSource | null {
  if (!message) {
    return null;
  }
  const provenanceCandidates = [
    asPlainObject(message.provenance),
    asPlainObject(message.InputProvenance),
  ];
  for (const provenance of provenanceCandidates) {
    if (!provenance) {
      continue;
    }
    const sourceChannel = normalizeHint(provenance.sourceChannel);
    const sourceTool = normalizeHint(provenance.sourceTool);
    if (sourceChannel === "webchat") {
      return "control_ui_user";
    }
    if (
      isSubagentBootstrapUserTurn(sessionIdentity, message) &&
      (hasClawchatChannelHint(sourceChannel) || sourceTool.includes("clawchat") || sourceTool.includes("lanying"))
    ) {
      return "control_ui_user";
    }
    if (hasClawchatChannelHint(sourceChannel) || sourceTool.includes("clawchat") || sourceTool.includes("lanying")) {
      return "im_inbound_user";
    }
    if (sourceChannel || sourceTool) {
      if (isSubagentBootstrapUserTurn(sessionIdentity, message)) {
        return "control_ui_user";
      }
      return null;
    }
  }
  return null;
}

function resolveCurrentMessageSyncVariant(
  sessionIdentity: string,
  message: Record<string, unknown> | null,
): SessionSyncVariant | null {
  if (!message) {
    return null;
  }
  const explicitVariant = extractMessageSyncVariant(message);
  if (explicitVariant) {
    return explicitVariant;
  }
  const provenanceCandidates = [
    asPlainObject(message.provenance),
    asPlainObject(message.InputProvenance),
  ];
  for (const provenance of provenanceCandidates) {
    if (!provenance) {
      continue;
    }
    const sourceChannel = normalizeHint(provenance.sourceChannel);
    const sourceTool = normalizeHint(provenance.sourceTool);
    if (
      isSubagentBootstrapUserTurn(sessionIdentity, message) &&
      (hasClawchatChannelHint(sourceChannel) || sourceTool.includes("clawchat") || sourceTool.includes("lanying"))
    ) {
      return "im_subagent_bootstrap";
    }
  }
  return null;
}

function resolveCurrentMessageUserSyncSourceBasis(
  sessionIdentity: string,
  message: Record<string, unknown> | null,
  source: SessionMessageSyncSource | null,
): string | null {
  if (!source || !message) {
    return null;
  }
  const provenanceCandidates = [
    asPlainObject(message.provenance),
    asPlainObject(message.InputProvenance),
  ];
  for (const provenance of provenanceCandidates) {
    if (!provenance) {
      continue;
    }
    const sourceChannel = normalizeHint(provenance.sourceChannel);
    const sourceTool = normalizeHint(provenance.sourceTool);
    if (
      sourceChannel === "webchat" ||
      hasClawchatChannelHint(sourceChannel) ||
      sourceTool.includes("clawchat") ||
      sourceTool.includes("lanying") ||
      sourceChannel ||
      sourceTool
    ) {
      return "provenance";
    }
  }
  if (source === "im_inbound_user" && messageLooksLikeClawchatInbound(message)) {
    return "message_hint";
  }
  if (source === "control_ui_user" && isSubagentBootstrapUserTurn(sessionIdentity, message)) {
    return "fallback";
  }
  return null;
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
    normalizedText.startsWith("[Subagent Context] You are running as a subagent") ||
    normalizedText.startsWith(
      "[Subagent Context] This subagent session is persistent and remains available for thread follow-up messages.",
    ) ||
    normalizedText.includes(
      "Begin. Your assigned task is in the system prompt under **Your Role**; execute it to completion.",
    ) ||
    normalizedText.includes(
      "Begin. Your assigned task is in the system prompt under Your Role; execute it to completion.",
    )
  );
}

function hasStructuredInterSessionSubagentAnnounce(
  message: Record<string, unknown> | null,
): boolean {
  if (!message) {
    return false;
  }
  const provenanceCandidates = [
    asPlainObject(message.provenance),
    asPlainObject(message.InputProvenance),
  ];
  for (const provenance of provenanceCandidates) {
    if (
      normalizeHint(provenance?.kind) === "inter_session" &&
      normalizeHint(provenance?.sourceTool) === "subagent_announce"
    ) {
      return true;
    }
  }
  return false;
}

function hasInternalSystemProvenance(message: Record<string, unknown> | null): boolean {
  if (!message) {
    return false;
  }
  const provenanceCandidates = [
    asPlainObject(message.provenance),
    asPlainObject(message.InputProvenance),
  ];
  for (const provenance of provenanceCandidates) {
    if (normalizeHint(provenance?.kind) === "internal_system") {
      return true;
    }
  }
  return false;
}

function isInternalRuntimeContextUserTurn(message: Record<string, unknown> | null): boolean {
  if (!message) {
    return false;
  }
  if (hasStructuredInterSessionSubagentAnnounce(message)) {
    return true;
  }
  if (hasInternalSystemProvenance(message)) {
    return true;
  }
  const visibleText = extractMessageVisibleText(message.content);
  if (!visibleText) {
    return false;
  }
  const normalizedText = visibleText.trim();
  if (
    normalizedText.includes(INTERNAL_RUNTIME_CONTEXT_BEGIN) ||
    normalizedText.includes(INTERNAL_RUNTIME_CONTEXT_END)
  ) {
    return true;
  }
  if (
    normalizedText.includes(`${OPENCLAW_NEXT_TURN_RUNTIME_CONTEXT_HEADER}\n${OPENCLAW_RUNTIME_CONTEXT_NOTICE}`) ||
    normalizedText.includes(`${OPENCLAW_RUNTIME_EVENT_HEADER}\n${OPENCLAW_RUNTIME_CONTEXT_NOTICE}`) ||
    normalizedText.includes(OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE)
  ) {
    return true;
  }
  const hasRuntimeHeader = normalizedText.includes("OpenClaw runtime context (internal):");
  const hasPrivateNotice = normalizedText.includes("Keep internal details private.");
  const hasInternalTaskEvent = normalizedText.includes("[Internal task completion event]");
  return (hasRuntimeHeader && hasPrivateNotice) || (hasRuntimeHeader && hasInternalTaskEvent);
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
  const currentMessageSource = resolveCurrentMessageUserSyncSource(sessionIdentity, message);
  if (currentMessageSource) {
    return currentMessageSource;
  }
  return messageLooksLikeClawchatInbound(message) ? "im_inbound_user" : "control_ui_user";
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
    rememberSessionSource(sessionIdentity, explicitSource.startsWith("control_ui") ? "control_ui" : "im_inbound");
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
  const message = asPlainObject(update.message);
  if (syncSource === "control_ui_user" && isInternalRuntimeContextUserTurn(message)) {
    return false;
  }
  if (syncSource === "control_ui_user" && shouldSuppressDuplicatedControlUiUser(update)) {
    return false;
  }
  const sessionKey = resolveSessionIdentity(update);
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

function rememberObservedMessageId(params: {
  sessionKey: string;
  messageId?: string;
  role?: string;
  bodyPreview?: string;
}): void {
  const messageId = typeof params.messageId === "string" ? params.messageId.trim() : "";
  if (!messageId) {
    return;
  }
  const now = Date.now();
  cleanupRecentState(now);
  const key = `${params.sessionKey}|${messageId}`;
  const current = recentObservedMessageIds.get(key);
  const nextCount = (current?.count ?? 0) + 1;
  recentObservedMessageIds.set(key, { seenAt: now, count: nextCount });
  if (nextCount > 1) {
    logDebug("duplicate onSessionTranscriptUpdate observed for same session/messageId", {
      session: params.sessionKey,
      messageId,
      count: nextCount,
      role: params.role || undefined,
      bodyPreview: params.bodyPreview || undefined,
    });
  }
}

function rememberSnapshot(update: SessionTranscriptUpdate): void {
  const message = asPlainObject(update.message);
  recentSnapshots.push({
    at: Date.now(),
    sessionKey: resolveSessionIdentity(update),
    messageId: update.messageId,
    source: resolveUpdateSyncSource(update) ?? undefined,
    syncVariant: extractSyncVariant(update.syncVariant) ?? undefined,
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
        snapshot.syncVariant ? `syncVariant=${snapshot.syncVariant}` : "",
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
  recentSessionSyncVariants.clear();
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
    const message = asPlainObject(update.message);
    const sessionIdentity = resolveSessionIdentity(update);
    const role = normalizeHint(message?.role ?? message?.authorRole);
    const bodyPreview = extractBodyPreview(update.message);
    rememberObservedMessageId({
      sessionKey: sessionIdentity,
      messageId: update.messageId,
      role,
      bodyPreview,
    });
    try {
      logDebug(
        `onSessionTranscriptUpdate observed\n${JSON.stringify(
          redactForLog({
            session: sessionIdentity,
            messageId: update.messageId,
            source: update.source ?? null,
            syncVariant: update.syncVariant ?? null,
            observedMessageType: update.observedMessageType ?? null,
            observedMessageTypeSource: update.observedMessageTypeSource ?? null,
            rawUpdate: update,
          }),
          null,
          2,
        )}`,
      );
    } catch (err) {
      logDebug("onSessionTranscriptUpdate observed stringify_failed", {
        session: sessionIdentity,
        messageId: update.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (shouldLogSubagentBootstrapTranscriptUpdate(update)) {
      logDebug("subagent bootstrap transcript update observed", {
        session: sessionIdentity,
        messageId: update.messageId,
        role: role || undefined,
        bodyPreview: bodyPreview || undefined,
      });
    }
    const source = resolveUpdateSyncSource(update);
    const currentMessageSyncVariant = resolveCurrentMessageSyncVariant(sessionIdentity, message);
    const syncVariant =
      extractSyncVariant(update.syncVariant) ||
      extractMessageSyncVariant(message) ||
      (role === "assistant"
        ? consumeRememberedSessionSyncVariant(sessionIdentity)
        : currentMessageSyncVariant);
    if (role === "user" || role === "assistant") {
      rememberSessionSyncVariant(
        sessionIdentity,
        role === "user" ? currentMessageSyncVariant : extractSyncVariant(update.syncVariant),
      );
    }
    if (!shouldProcessUpdate(update)) {
      return;
    }
    const nextUpdate = source
      ? {
          ...update,
          sessionKey: sessionIdentity,
          source,
          ...(syncVariant ? { syncVariant } : {}),
          ...(source === "control_ui_user" ? { observedMessageType: "control_ui_user" } : {}),
          ...(source === "control_ui_reply" ? { observedMessageType: "control_ui_reply" } : {}),
          ...(source === "im_inbound_user" ? { observedMessageType: "im_inbound_user" } : {}),
          ...(source === "im_inbound_reply" ? { observedMessageType: "im_inbound_reply" } : {}),
          ...(role === "user"
            ? {
                observedMessageTypeSource:
                  syncVariant === "im_subagent_bootstrap"
                    ? "fallback"
                    : resolveCurrentMessageUserSyncSourceBasis(
                        resolveSessionIdentity(update),
                        message,
                        source,
                      ) ?? undefined,
              }
            : {}),
        }
      : update;
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
