import { logWarn } from "../shared/logging.js";
import { maybeParseJson, pickId } from "../shared/utils.js";
import {
  type ClawchatInboundEvent,
  type ConfigBatchEntry,
  type ProbeRequestPayload,
} from "../types.js";

export type ConfigBatchSyncPayload = {
  batchEntries: ConfigBatchEntry[];
  restartGateway: boolean;
};

export type PresetPromptSyncPayload = {
  chatbotId: string;
  chatbotName: string;
  prompt: string;
};

export type SessionMapSettingsPayload = {
  sessionMapSync: boolean;
  mergeSubSessions: boolean;
};

export type RouterSignal =
  | {
      type: "router_context";
      message: Record<string, unknown>;
      knowledge: string;
      coldStart: boolean;
    }
  | {
      type: "router_request";
      message: Record<string, unknown>;
      knowledge: string;
      coldStart: boolean;
    }
  | { type: "router_reply" };

export type RouterReplyTargetSnapshot = {
  requestSid: string;
  replyKind: "group" | "user";
  replyId: string;
};

export type SessionMappingPayload = {
  session: string;
  groupId?: string;
  openclawUserId?: string;
  originKind?: string;
  originUserId?: string;
  chatbotUserId?: string;
  parentSessionKey?: string;
  rootSessionKey?: string;
  effectiveTargetSessionKey?: string;
  updatedAt?: number;
};

export type SessionMappingSignal = {
  type: "session_mapping_sync" | "session_mapping_snapshot";
  mappings: SessionMappingPayload[];
  openclawUserId?: string;
};

export type SessionKeyFacts = {
  rawSessionKey: string;
  canonicalSessionKey: string;
  channel?: "clawchat" | "clawchat-router";
  chatType?: "group" | "direct";
  targetId?: string;
  isLegacyAlias: boolean;
  isClawchatSession: boolean;
  isRouter: boolean;
  isGroup: boolean;
  isDirect: boolean;
  isSubagent: boolean;
};

export type SessionTranscriptObservedSignal = {
  type: "session_transcript_observed";
  session?: string;
  source?: string;
  role?: string;
  messageId?: string;
};

export type SessionSyncDeliverySignal = {
  type: "session_sync_delivery" | "im_reply_delivery";
  session?: string;
  source?: string;
  role?: string;
  messageId?: string;
};

function parseProbeBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "true" || normalized === "on" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "off" || normalized === "0") {
    return false;
  }
  return undefined;
}

export function normalizeClawchatSessionKey(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized.startsWith("agent:main:router:")) {
    return `agent:main:clawchat-router:${normalized.slice("agent:main:router:".length)}`;
  }
  if (normalized.startsWith("agent:main:group:") && normalized.slice("agent:main:group:".length).trim()) {
    return `agent:main:clawchat:group:${normalized.slice("agent:main:group:".length).trim()}`;
  }
  if (normalized.startsWith("agent:main:") && /^\d+$/.test(normalized.slice("agent:main:".length))) {
    return `agent:main:clawchat:direct:${normalized.slice("agent:main:".length)}`;
  }
  return normalized;
}

export function resolveClawchatSessionKeyFacts(value: unknown): SessionKeyFacts {
  const rawSessionKey = typeof value === "string" ? value.trim().toLowerCase() : "";
  const canonicalSessionKey = normalizeClawchatSessionKey(rawSessionKey);
  const facts: SessionKeyFacts = {
    rawSessionKey,
    canonicalSessionKey,
    isLegacyAlias: Boolean(rawSessionKey) && rawSessionKey !== canonicalSessionKey,
    isClawchatSession: false,
    isRouter: false,
    isGroup: false,
    isDirect: false,
    isSubagent: canonicalSessionKey.includes(":subagent:"),
  };
  if (!canonicalSessionKey) {
    return facts;
  }
  const parts = canonicalSessionKey.split(":").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 5 || parts[0] !== "agent") {
    return facts;
  }
  const channel = parts[2];
  if (channel !== "clawchat" && channel !== "clawchat-router") {
    return facts;
  }
  let cursor = 3;
  if (parts.length >= 6 && parts[3] !== "group" && parts[3] !== "direct") {
    cursor = 4;
  }
  const chatType = parts[cursor];
  if ((chatType !== "group" && chatType !== "direct") || cursor + 1 >= parts.length) {
    return facts;
  }
  const targetId = parts.slice(cursor + 1).join(":").trim();
  if (!targetId) {
    return facts;
  }
  facts.channel = channel;
  facts.chatType = chatType;
  facts.targetId = targetId;
  facts.isClawchatSession = true;
  facts.isRouter = channel === "clawchat-router";
  facts.isGroup = chatType === "group";
  facts.isDirect = chatType === "direct";
  return facts;
}

export function parseExtValue(value: unknown): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    const parsed = maybeParseJson(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function removeOpenclawEdgeMention(content: string, toUserNickname: string): string {
  const nickname = toUserNickname.trim();
  if (!nickname) {
    return content;
  }
  const escapedNickname = nickname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentionGap = "(?:[\\s\\u2000-\\u200D\\u2060\\u3000])+";
  const withoutPrefix = content.replace(new RegExp(`^@${escapedNickname}${mentionGap}`), "");
  const withoutSuffix = withoutPrefix.replace(
    new RegExp(`@${escapedNickname}${mentionGap}?$`),
    "",
  );
  return withoutSuffix.trim();
}

export function stripLeadingAtMentions(content: string): string {
  let current = content;
  const leadingMentionPattern = /^@\S+(?:[\s\u2000-\u200D\u2060\u3000])+/;
  while (true) {
    const next = current.replace(leadingMentionPattern, "");
    if (next === current) {
      return current.trimStart();
    }
    current = next;
  }
}

function parseConfigBatchBoolean(value: unknown): boolean {
  return (
    value === true ||
    value === 1 ||
    value === "1" ||
    String(value ?? "").trim().toLowerCase() === "true" ||
    String(value ?? "").trim().toLowerCase() === "on"
  );
}

function normalizeConfigBatchEntry(value: unknown, index: number): ConfigBatchEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    logWarn("skip config batch sync item: entry is not an object", {
      index,
      valueType: typeof value,
    });
    return null;
  }
  const obj = value as Record<string, unknown>;
  const path = String(obj.path ?? "").trim();
  if (!path) {
    logWarn("skip config batch sync item: path is empty", { index });
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(obj, "value")) {
    logWarn("skip config batch sync item: value is missing", { index, path });
    return null;
  }
  const entry: ConfigBatchEntry = {
    path,
    value: obj.value,
  };
  return entry;
}

export function extractConfigBatchSync(
  eventAny: Record<string, unknown>,
  meta: Record<string, unknown>,
): ConfigBatchSyncPayload | null {
  const payload = (eventAny.payload ?? meta.payload) as Record<string, unknown> | undefined;
  const extObjCandidates = [
    parseExtValue(eventAny.ext),
    parseExtValue(meta.ext),
    parseExtValue(payload?.ext),
  ].filter(Boolean) as Record<string, unknown>[];

  for (const extObj of extObjCandidates) {
    const openclaw = extObj.openclaw;
    if (!openclaw || typeof openclaw !== "object" || Array.isArray(openclaw)) {
      continue;
    }
    const openclawObj = openclaw as Record<string, unknown>;
    const signalType = String(openclawObj.type ?? "").trim();
    if (signalType !== "config_patch") {
      continue;
    }
    const rawBatchEntries = openclawObj.batchEntries ?? openclawObj.batch_entries;
    if (!Array.isArray(rawBatchEntries)) {
      continue;
    }
    const batchEntries = rawBatchEntries
      .map((item, index) => normalizeConfigBatchEntry(item, index))
      .filter(Boolean) as ConfigBatchEntry[];
    if (batchEntries.length === 0) {
      logWarn("skip config batch sync payload: no valid batch entries", {
        signalType,
        rawCount: rawBatchEntries.length,
      });
      return null;
    }
    return {
      batchEntries,
      restartGateway: parseConfigBatchBoolean(
        openclawObj.restartGateway ?? openclawObj.restart_gateway ?? openclawObj.restart,
      ),
    };
  }
  return null;
}

export function parseMetaMessage(value: unknown): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    const parsed = maybeParseJson(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function extractPresetPromptSync(
  eventAny: Record<string, unknown>,
  meta: Record<string, unknown>,
): PresetPromptSyncPayload | null {
  const payload = (eventAny.payload ?? meta.payload) as Record<string, unknown> | undefined;
  const extObjCandidates = [
    parseExtValue(eventAny.ext),
    parseExtValue(meta.ext),
    parseExtValue(payload?.ext),
  ].filter(Boolean) as Record<string, unknown>[];

  for (const extObj of extObjCandidates) {
    const openclaw = extObj.openclaw;
    if (!openclaw || typeof openclaw !== "object" || Array.isArray(openclaw)) {
      continue;
    }
    const openclawObj = openclaw as Record<string, unknown>;
    if (String(openclawObj.type ?? "").trim() !== "preset_prompt_sync") {
      continue;
    }
    return {
      chatbotId: String(openclawObj.chatbotId ?? "").trim(),
      chatbotName: String(openclawObj.chatbotName ?? "").trim(),
      prompt: typeof openclawObj.prompt === "string" ? openclawObj.prompt : "",
    };
  }
  return null;
}

export function extractProbeRequest(
  eventAny: Record<string, unknown>,
  meta: Record<string, unknown>,
): ProbeRequestPayload | null {
  const payload = (eventAny.payload ?? meta.payload) as Record<string, unknown> | undefined;
  const extObjCandidates = [
    parseExtValue(eventAny.ext),
    parseExtValue(meta.ext),
    parseExtValue(payload?.ext),
  ].filter(Boolean) as Record<string, unknown>[];

  for (const extObj of extObjCandidates) {
    const openclaw = extObj.openclaw;
    if (!openclaw || typeof openclaw !== "object" || Array.isArray(openclaw)) {
      continue;
    }
    const openclawObj = openclaw as Record<string, unknown>;
    if (String(openclawObj.type ?? "").trim() !== "probe") {
      continue;
    }
    const checksValue =
      openclawObj.checks && typeof openclawObj.checks === "object" && !Array.isArray(openclawObj.checks)
        ? (openclawObj.checks as Record<string, unknown>)
        : {};
    const configPatchValue =
      checksValue.config_patch &&
      typeof checksValue.config_patch === "object" &&
      !Array.isArray(checksValue.config_patch)
        ? (checksValue.config_patch as Record<string, unknown>)
        : {};
    const rawItems = Array.isArray(configPatchValue.items) ? configPatchValue.items : [];
    const items = rawItems
      .map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return null;
        }
        const itemObj = item as Record<string, unknown>;
        const path = String(itemObj.path ?? "").trim();
        const expectedHash = String(itemObj.expected_hash ?? itemObj.expectedHash ?? "").trim();
        if (!path || !expectedHash) {
          return null;
        }
        return {
          path,
          expectedHash,
          expectedSummary: itemObj.expected_summary ?? itemObj.expectedSummary,
        };
      })
      .filter(Boolean) as Array<{ path: string; expectedHash: string; expectedSummary?: unknown }>;
    const presetPromptContentValue =
      checksValue.preset_prompt_content &&
      typeof checksValue.preset_prompt_content === "object" &&
      !Array.isArray(checksValue.preset_prompt_content)
        ? (checksValue.preset_prompt_content as Record<string, unknown>)
        : {};
    const presetPromptHookValue =
      checksValue.preset_prompt_hook &&
      typeof checksValue.preset_prompt_hook === "object" &&
      !Array.isArray(checksValue.preset_prompt_hook)
        ? (checksValue.preset_prompt_hook as Record<string, unknown>)
        : {};
    const sessionMapRuntimeValue =
      checksValue.session_map_runtime &&
      typeof checksValue.session_map_runtime === "object" &&
      !Array.isArray(checksValue.session_map_runtime)
        ? (checksValue.session_map_runtime as Record<string, unknown>)
        : {};
    return {
      probeId: String(openclawObj.probe_id ?? openclawObj.probeId ?? "").trim(),
      formatVersion: Number(openclawObj.formatVersion ?? 1) || 1,
      checks: {
        ...(checksValue.health && typeof checksValue.health === "object"
          ? { health: checksValue.health as Record<string, unknown> }
          : {}),
        ...(checksValue.account_config && typeof checksValue.account_config === "object"
          ? { accountConfig: checksValue.account_config as Record<string, unknown> }
          : {}),
        ...(checksValue.config_patch && typeof checksValue.config_patch === "object"
          ? { configPatch: { items } }
          : {}),
        ...(typeof presetPromptContentValue.expected_hash === "string" &&
        presetPromptContentValue.expected_hash.trim()
          ? {
              presetPromptContent: {
                expectedHash: presetPromptContentValue.expected_hash.trim(),
              },
            }
          : {}),
        ...(checksValue.preset_prompt_hook && typeof checksValue.preset_prompt_hook === "object"
          ? {
              presetPromptHook: {
                requiredPath:
                  typeof presetPromptHookValue.required_path === "string"
                    ? presetPromptHookValue.required_path.trim()
                    : undefined,
              },
            }
          : {}),
        ...(checksValue.workspace_files && typeof checksValue.workspace_files === "object"
          ? { workspaceFiles: checksValue.workspace_files as Record<string, unknown> }
          : {}),
        ...(checksValue.session_map_runtime && typeof checksValue.session_map_runtime === "object"
          ? {
              sessionMapRuntime: {
                expectedSessionMapSyncEnabled: parseProbeBoolean(
                  sessionMapRuntimeValue.expected_session_map_sync_enabled,
                ),
                expectedMergeSubSessionsEnabled: parseProbeBoolean(
                  sessionMapRuntimeValue.expected_merge_sub_sessions_enabled,
                ),
                expectedEffectiveEnabled: parseProbeBoolean(
                  sessionMapRuntimeValue.expected_effective_enabled,
                ),
              },
            }
          : {}),
        ...(checksValue.online_marker && typeof checksValue.online_marker === "object"
          ? { onlineMarker: checksValue.online_marker as Record<string, unknown> }
          : {}),
      },
    };
  }
  return null;
}

export function extractSessionMapSettingsSync(
  eventAny: Record<string, unknown>,
  meta: Record<string, unknown>,
): SessionMapSettingsPayload | null {
  const payload = (eventAny.payload ?? meta.payload) as Record<string, unknown> | undefined;
  const extObjCandidates = [
    parseExtValue(eventAny.ext),
    parseExtValue(meta.ext),
    parseExtValue(payload?.ext),
  ].filter(Boolean) as Record<string, unknown>[];

  for (const extObj of extObjCandidates) {
    const openclaw = extObj.openclaw;
    if (!openclaw || typeof openclaw !== "object" || Array.isArray(openclaw)) {
      continue;
    }
    const openclawObj = openclaw as Record<string, unknown>;
    if (String(openclawObj.type ?? "").trim() !== "session_map_settings_sync") {
      continue;
    }
    const settings =
      openclawObj.settings && typeof openclawObj.settings === "object" && !Array.isArray(openclawObj.settings)
        ? (openclawObj.settings as Record<string, unknown>)
        : openclawObj;
    const sessionMapSync =
      settings.sessionMapSync === true ||
      settings.session_map_sync === true ||
      String(settings.sessionMapSync ?? settings.session_map_sync ?? "").trim().toLowerCase() === "on";
    const mergeSubSessions =
      sessionMapSync &&
      (
        settings.mergeSubSessions === true ||
        settings.merge_sub_sessions === true ||
        String(settings.mergeSubSessions ?? settings.merge_sub_sessions ?? "").trim().toLowerCase() === "on"
      );
    return {
      sessionMapSync,
      mergeSubSessions,
    };
  }
  return null;
}

export function extractRouterSignal(
  eventAny: Record<string, unknown>,
  meta: Record<string, unknown>,
): RouterSignal | null {
  const payload = (eventAny.payload ?? meta.payload) as Record<string, unknown> | undefined;
  const extObjCandidates = [
    parseExtValue(eventAny.ext),
    parseExtValue(meta.ext),
    parseExtValue(payload?.ext),
  ].filter(Boolean) as Record<string, unknown>[];

  for (const extObj of extObjCandidates) {
    const openclaw = extObj.openclaw;
    if (!openclaw || typeof openclaw !== "object" || Array.isArray(openclaw)) {
      continue;
    }
    const openclawObj = openclaw as Record<string, unknown>;
    const signalType = String(openclawObj.type ?? "").trim();
    if (signalType === "router_reply") {
      return { type: "router_reply" };
    }
    if (signalType !== "router_request" && signalType !== "router_context") {
      continue;
    }
    const message = parseMetaMessage(openclawObj.message);
    if (message) {
      const knowledge =
        typeof openclawObj.knowledge === "string" ? openclawObj.knowledge.trim() : "";
      const coldStart = openclawObj.cold_start === true;
      return {
        type: signalType === "router_context" ? "router_context" : "router_request",
        message,
        knowledge,
        coldStart,
      };
    }
    logWarn("skip router signal: openclaw.message is invalid", {
      signalType,
      messageType: typeof openclawObj.message,
    });
  }
  return null;
}

function normalizeSessionMappingPayload(value: unknown): SessionMappingPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  const session = String(obj.session ?? obj.sessionKey ?? obj.session_key ?? "").trim();
  const groupId = String(obj.group_id ?? obj.groupId ?? "").trim();
  if (!session) {
    return null;
  }
  const updatedAtRaw = Number(obj.updated_at ?? obj.updatedAt ?? 0);
  return {
    session,
    ...(groupId ? { groupId } : {}),
    openclawUserId: String(obj.openclaw_user_id ?? obj.openclawUserId ?? "").trim() || undefined,
    originKind: String(obj.origin_kind ?? obj.originKind ?? "").trim() || undefined,
    originUserId: String(obj.origin_user_id ?? obj.originUserId ?? "").trim() || undefined,
    chatbotUserId: String(obj.chatbot_user_id ?? obj.chatbotUserId ?? "").trim() || undefined,
    parentSessionKey:
      String(obj.parent_session_key ?? obj.parentSessionKey ?? "").trim() || undefined,
    rootSessionKey: String(obj.root_session_key ?? obj.rootSessionKey ?? "").trim() || undefined,
    effectiveTargetSessionKey:
      String(
        obj.effective_target_session_key ?? obj.effectiveTargetSessionKey ?? "",
      ).trim() || undefined,
    updatedAt: Number.isFinite(updatedAtRaw) && updatedAtRaw > 0 ? updatedAtRaw : undefined,
  };
}

export function extractSessionMappingSignal(
  eventAny: Record<string, unknown>,
  meta: Record<string, unknown>,
): SessionMappingSignal | null {
  const payload = (eventAny.payload ?? meta.payload) as Record<string, unknown> | undefined;
  const extObjCandidates = [
    parseExtValue(eventAny.ext),
    parseExtValue(meta.ext),
    parseExtValue(payload?.ext),
  ].filter(Boolean) as Record<string, unknown>[];

  for (const extObj of extObjCandidates) {
    const openclaw = extObj.openclaw;
    if (!openclaw || typeof openclaw !== "object" || Array.isArray(openclaw)) {
      continue;
    }
    const openclawObj = openclaw as Record<string, unknown>;
    const signalType = String(openclawObj.type ?? "").trim();
    if (signalType !== "session_mapping_sync" && signalType !== "session_mapping_snapshot") {
      continue;
    }
    const mappingsRaw = Array.isArray(openclawObj.mappings)
      ? openclawObj.mappings
      : openclawObj.mapping
        ? [openclawObj.mapping]
        : [openclawObj];
    const mappings = mappingsRaw
      .map((item) => normalizeSessionMappingPayload(item))
      .filter(Boolean) as SessionMappingPayload[];
    if (mappings.length === 0 && signalType !== "session_mapping_snapshot") {
      logWarn("skip session mapping signal: no valid mappings", {
        signalType,
      });
      return null;
    }
    return {
      type: signalType,
      mappings,
      openclawUserId:
        String(openclawObj.openclaw_user_id ?? openclawObj.openclawUserId ?? "").trim() ||
        undefined,
    };
  }
  return null;
}

export function extractSessionTranscriptObservedSignal(
  eventAny: Record<string, unknown>,
  meta: Record<string, unknown>,
): SessionTranscriptObservedSignal | null {
  const payload = (eventAny.payload ?? meta.payload) as Record<string, unknown> | undefined;
  const extObjCandidates = [
    parseExtValue(eventAny.ext),
    parseExtValue(meta.ext),
    parseExtValue(payload?.ext),
  ].filter(Boolean) as Record<string, unknown>[];

  for (const extObj of extObjCandidates) {
    const openclaw = extObj.openclaw;
    if (!openclaw || typeof openclaw !== "object" || Array.isArray(openclaw)) {
      continue;
    }
    const openclawObj = openclaw as Record<string, unknown>;
    const signalType = String(openclawObj.type ?? "").trim();
    if (signalType !== "session_transcript_observed") {
      continue;
    }
    const message = parseMetaMessage(openclawObj.message);
    return {
      type: "session_transcript_observed",
      session: String(openclawObj.session ?? openclawObj.sessionKey ?? "").trim() || undefined,
      source: String(openclawObj.source ?? "").trim() || undefined,
      role: String(message?.role ?? "").trim() || undefined,
      messageId:
        pickId(openclawObj.message_id) ||
        pickId(openclawObj.messageId) ||
        pickId(message?.id) ||
        undefined,
    };
  }
  return null;
}

export function extractSessionSyncDeliverySignal(
  eventAny: Record<string, unknown>,
  meta: Record<string, unknown>,
): SessionSyncDeliverySignal | null {
  const payload = (eventAny.payload ?? meta.payload) as Record<string, unknown> | undefined;
  const extObjCandidates = [
    parseExtValue(eventAny.ext),
    parseExtValue(meta.ext),
    parseExtValue(payload?.ext),
  ].filter(Boolean) as Record<string, unknown>[];

  for (const extObj of extObjCandidates) {
    const openclaw = extObj.openclaw;
    if (!openclaw || typeof openclaw !== "object" || Array.isArray(openclaw)) {
      continue;
    }
    const openclawObj = openclaw as Record<string, unknown>;
    const openclawType = String(openclawObj.type ?? "").trim();
    if (openclawType !== "session_sync_delivery" && openclawType !== "im_reply_delivery") {
      continue;
    }
    return {
      type: openclawType,
      session: String(openclawObj.session ?? openclawObj.sessionKey ?? "").trim() || undefined,
      source: String(openclawObj.source ?? "").trim() || undefined,
      role: String(openclawObj.role ?? "").trim() || undefined,
      messageId:
        pickId(openclawObj.message_id) ||
        pickId(openclawObj.messageId) ||
        undefined,
    };
  }
  return null;
}

export function resolveRouterReplyTargetSnapshot(
  routerMessage: Record<string, unknown>,
): RouterReplyTargetSnapshot | null {
  const requestSid =
    pickId(routerMessage.id) || pickId((routerMessage as { message_id?: unknown }).message_id);
  if (!requestSid) {
    return null;
  }
  const fromId =
    pickId(routerMessage.from) ||
    pickId((routerMessage as { sender_id?: unknown }).sender_id) ||
    "";
  const toId =
    pickId(routerMessage.to) ||
    pickId((routerMessage as { uid?: unknown }).uid) ||
    "";
  const toType = String(
    (routerMessage as { toType?: unknown }).toType ??
      (routerMessage as { to_type?: unknown }).to_type ??
      "",
  )
    .trim()
    .toLowerCase();
  const explicitGroupId =
    pickId((routerMessage as { gid?: unknown }).gid) ||
    pickId((routerMessage as { group_id?: unknown }).group_id) ||
    pickId((routerMessage as { conversation_id?: unknown }).conversation_id) ||
    "";
  const replyGroupId = explicitGroupId || (toType === "group" ? toId : "");
  if (replyGroupId) {
    return {
      requestSid,
      replyKind: "group",
      replyId: replyGroupId,
    };
  }
  if (!fromId) {
    return null;
  }
  return {
    requestSid,
    replyKind: "user",
    replyId: fromId,
  };
}

export function isCommandOuterMessage(
  eventAny: Record<string, unknown>,
  meta: Record<string, unknown>,
): boolean {
  const payload = (eventAny.payload ?? meta.payload) as Record<string, unknown> | undefined;
  const rawTypeCandidates = [
    eventAny.type,
    meta.type,
    payload?.type,
    (eventAny as { messageType?: unknown }).messageType,
    (meta as { messageType?: unknown }).messageType,
  ];
  return rawTypeCandidates.some((value) => String(value ?? "").trim().toLowerCase() === "command");
}

export function isHistoryEvent(
  eventAny: Record<string, unknown>,
  meta: Record<string, unknown>,
): boolean {
  const isHistoryRaw = (eventAny.isHistory ?? meta.isHistory) as unknown;
  return (
    isHistoryRaw === true ||
    isHistoryRaw === "true" ||
    isHistoryRaw === 1 ||
    isHistoryRaw === "1"
  );
}

export function extractText(event: ClawchatInboundEvent): string {
  const eventAny = event as Record<string, unknown>;
  const meta = (eventAny.meta ?? eventAny) as Record<string, unknown>;
  const candidates: unknown[] = [
    event.msg,
    event.text,
    event.content,
    event.payload?.msg,
    event.payload?.text,
    event.payload?.content,
    (event as { body?: unknown }).body,
    (event as { message?: unknown }).message,
    (event as { data?: unknown }).data,
    meta.content,
    (meta.payload as Record<string, unknown> | undefined)?.content,
    (meta.payload as Record<string, unknown> | undefined)?.text,
  ];

  for (const item of candidates) {
    if (item == null) {
      continue;
    }
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (!trimmed) {
        continue;
      }
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          const parsedText = [parsed.msg, parsed.text, parsed.content].find(
            (x) => typeof x === "string" && x.trim().length > 0,
          );
          if (typeof parsedText === "string") {
            return parsedText;
          }
        } catch {
          // Keep raw string fallback.
        }
      }
      return trimmed;
    }
    if (typeof item === "object") {
      const asObj = item as Record<string, unknown>;
      const nested = [asObj.msg, asObj.text, asObj.content].find(
        (x) => typeof x === "string" && x.trim().length > 0,
      );
      if (typeof nested === "string") {
        return nested;
      }
    }
  }

  return "";
}
