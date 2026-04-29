import { logWarn } from "../shared/logging.js";
import { maybeParseJson, pickId } from "../shared/utils.js";
import { type ClawchatInboundEvent } from "../types.js";

export type PresetPromptSyncPayload = {
  chatbotId: string;
  chatbotName: string;
  prompt: string;
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

export type SessionMessageSyncSignal = {
  type: "session_message_sync";
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

export function extractConfigPatchRaw(
  eventAny: Record<string, unknown>,
  meta: Record<string, unknown>,
): string | null {
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
    if (openclawObj.type !== "config_patch") {
      continue;
    }
    const raw = openclawObj.raw ?? openclawObj.patch ?? openclawObj.config_patch;
    if (typeof raw === "string" && raw.trim()) {
      return raw;
    }
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

export function extractSessionMessageSyncSignal(
  eventAny: Record<string, unknown>,
  meta: Record<string, unknown>,
): SessionMessageSyncSignal | null {
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
    if (String(openclawObj.type ?? "").trim() !== "session_message_sync") {
      continue;
    }
    const message = parseMetaMessage(openclawObj.message);
    return {
      type: "session_message_sync",
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

export function collectHashCandidates(
  value: unknown,
  path = "$",
  out: Array<{ path: string; value: string }> = [],
): Array<{ path: string; value: string }> {
  if (out.length >= 20 || value == null) {
    return out;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length && out.length < 20; i += 1) {
      collectHashCandidates(value[i], `${path}[${i}]`, out);
    }
    return out;
  }
  if (typeof value !== "object") {
    return out;
  }

  const obj = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(obj)) {
    if (out.length >= 20) {
      break;
    }
    const keyLower = key.toLowerCase();
    if (keyLower.includes("hash") && typeof nested === "string" && nested.trim()) {
      out.push({
        path: `${path}.${key}`,
        value: nested.trim().slice(0, 24),
      });
    }
    collectHashCandidates(nested, `${path}.${key}`, out);
  }
  return out;
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
