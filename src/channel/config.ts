import { maybeParseJson, pickId } from "../shared/utils.js";
import {
  CLAWCHAT_CHANNEL_ID,
  CLAWCHAT_DEFAULT_ACCOUNT_ID,
  CLAWCHAT_LEGACY_CHANNEL_ID,
  type ClawchatChannelConfig,
  type ClawchatInboundEvent,
  type ClawchatMessageTarget,
  type OpenClawConfig,
  type ResolvedClawchatAccount,
} from "../types.js";

export function parseConfigValue(value: unknown): Record<string, unknown> | null {
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

export function hasSelfMentionInConfig(
  eventAny: Record<string, unknown>,
  meta: Record<string, unknown>,
  selfId: string,
): boolean {
  const selfNorm = selfId.trim();
  if (!selfNorm) {
    return false;
  }
  const payload = (eventAny.payload ?? meta.payload) as Record<string, unknown> | undefined;
  const configCandidates = [
    parseConfigValue((eventAny as { config?: unknown }).config),
    parseConfigValue((meta as { config?: unknown }).config),
    parseConfigValue(payload?.config),
  ].filter(Boolean) as Record<string, unknown>[];

  for (const config of configCandidates) {
    const mentionListRaw = (config as { mentionList?: unknown; mention_list?: unknown }).mentionList
      ?? (config as { mention_list?: unknown }).mention_list;
    if (!Array.isArray(mentionListRaw)) {
      continue;
    }
    for (const item of mentionListRaw) {
      const mentionId = pickId(item);
      if (mentionId && mentionId.trim() === selfNorm) {
        return true;
      }
    }
  }
  return false;
}

export function resolveToUserNicknameFromConfig(
  eventAny: Record<string, unknown>,
  meta: Record<string, unknown>,
): string {
  const payload = (eventAny.payload ?? meta.payload) as Record<string, unknown> | undefined;
  const configCandidates = [
    parseConfigValue((eventAny as { config?: unknown }).config),
    parseConfigValue((meta as { config?: unknown }).config),
    parseConfigValue(payload?.config),
  ].filter(Boolean) as Record<string, unknown>[];

  for (const config of configCandidates) {
    const nickname = (config.to_user_nickname ?? config.toUserNickname) as unknown;
    if (typeof nickname === "string" && nickname.trim()) {
      return nickname.trim();
    }
  }
  return "";
}

export function normalizeAllowEntry(raw: unknown): string {
  return String(raw ?? "")
    .replace(/^(?:clawchat|lanying):/i, "")
    .trim()
    .toLowerCase();
}

export function isAllowedByAllowlist(allowlist: string[], candidate: string): boolean {
  if (allowlist.includes("*")) {
    return true;
  }
  const normalized = normalizeAllowEntry(candidate);
  if (!normalized) {
    return false;
  }
  return allowlist.some((entry) => normalizeAllowEntry(entry) === normalized);
}

export function parseGroupId(
  eventAny: Record<string, unknown>,
  meta: Record<string, unknown>,
  event: ClawchatInboundEvent,
): string {
  const toType =
    String(
      (eventAny as { toType?: unknown }).toType ??
        (eventAny as { to_type?: unknown }).to_type ??
        (meta as { toType?: unknown }).toType ??
        (meta as { to_type?: unknown }).to_type ??
        "",
    )
      .trim()
      .toLowerCase() || "";
  const isGroupToType = toType === "group";
  const groupIdByTo =
    pickId(event.to) ||
    pickId((eventAny as { to?: unknown }).to) ||
    pickId((meta as { to?: unknown }).to);

  if (isGroupToType && groupIdByTo) {
    return groupIdByTo;
  }

  return (
    pickId(event.gid) ||
    pickId(event.group_id) ||
    pickId(event.conversation_id) ||
    pickId(eventAny.gid) ||
    pickId((eventAny as { group_id?: unknown }).group_id) ||
    pickId((eventAny as { conversation_id?: unknown }).conversation_id) ||
    pickId(meta.gid) ||
    pickId((meta as { group_id?: unknown }).group_id) ||
    pickId((meta as { conversation_id?: unknown }).conversation_id)
  );
}

function getGroupEntry(
  account: ResolvedClawchatAccount,
  groupId: string,
): { entry?: ResolvedClawchatAccount["groups"][string]; source: "group" | "wildcard" | "none" } {
  const groupEntry = account.groups[groupId];
  if (groupEntry) {
    return { entry: groupEntry, source: "group" };
  }
  const wildcard = account.groups["*"];
  if (wildcard) {
    return { entry: wildcard, source: "wildcard" };
  }
  return { source: "none" };
}

export function isGroupAllowedByPolicy(account: ResolvedClawchatAccount, groupId: string): boolean {
  if (account.groupPolicy === "disabled") {
    return false;
  }
  const matched = getGroupEntry(account, groupId);
  if (matched.entry?.enabled === false) {
    return false;
  }
  if (account.groupPolicy === "open") {
    return true;
  }
  return matched.source !== "none";
}

export function isGroupSenderAllowed(
  account: ResolvedClawchatAccount,
  groupId: string,
  senderId: string,
): boolean {
  if (!senderId) {
    return false;
  }
  const matched = getGroupEntry(account, groupId);
  const senderAllowFrom =
    matched.entry && matched.entry.allowFrom.length > 0
      ? matched.entry.allowFrom
      : account.groupAllowFrom;
  if (senderAllowFrom.length === 0) {
    return false;
  }
  return isAllowedByAllowlist(senderAllowFrom, senderId);
}

export function resolveGroupRequireMention(
  account: ResolvedClawchatAccount,
  groupId: string,
): boolean {
  const groupEntry = account.groups[groupId];
  if (typeof groupEntry?.requireMention === "boolean") {
    return groupEntry.requireMention;
  }
  const wildcardEntry = account.groups["*"];
  if (typeof wildcardEntry?.requireMention === "boolean") {
    return wildcardEntry.requireMention;
  }
  return true;
}

export function resolveSenderNameFromConfig(
  eventAny: Record<string, unknown>,
  meta: Record<string, unknown>,
): string {
  const payload = (eventAny.payload ?? meta.payload) as Record<string, unknown> | undefined;
  const configCandidates = [
    parseConfigValue((eventAny as { config?: unknown }).config),
    parseConfigValue((meta as { config?: unknown }).config),
    parseConfigValue(payload?.config),
  ].filter(Boolean) as Record<string, unknown>[];
  for (const config of configCandidates) {
    const nickname = (config.senderNickname ?? config.sender_nickname) as unknown;
    if (typeof nickname === "string" && nickname.trim()) {
      return nickname.trim();
    }
  }
  return "";
}

export function normalizeTarget(raw: string): ClawchatMessageTarget | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.replace(/^(?:clawchat|lanying):/i, "");
  if (/^(group|g):/i.test(normalized)) {
    return { kind: "group", id: normalized.replace(/^(group|g):/i, "").trim() };
  }
  if (/^(user|u):/i.test(normalized)) {
    return { kind: "user", id: normalized.replace(/^(user|u):/i, "").trim() };
  }
  return { kind: "user", id: normalized };
}

export function sanitizeAccountForLog(account: ResolvedClawchatAccount): Record<string, unknown> {
  return {
    accountId: account.accountId,
    enabled: account.enabled,
    configured: account.configured,
    appId: account.appId ? `${account.appId.slice(0, 4)}***` : "",
    username: account.username,
    dmPolicy: account.dmPolicy,
    allowFromCount: account.allowFrom.length,
    groupPolicy: account.groupPolicy,
    groupAllowFromCount: account.groupAllowFrom.length,
    groupsCount: Object.keys(account.groups).length,
    sessionMapSync: account.sessionMapSync,
    mergeSubSessions: account.mergeSubSessions,
  };
}

export function resolveClawchatConfig(cfg: OpenClawConfig): ClawchatChannelConfig {
  const channels = cfg?.channels as Record<string, unknown> | undefined;
  const primary = channels?.[CLAWCHAT_CHANNEL_ID];
  if (primary && typeof primary === "object") {
    return primary as ClawchatChannelConfig;
  }
  const legacy = channels?.[CLAWCHAT_LEGACY_CHANNEL_ID];
  if (legacy && typeof legacy === "object") {
    return legacy as ClawchatChannelConfig;
  }
  return {};
}

export function resolveClawchatAccount(cfg: OpenClawConfig): ResolvedClawchatAccount {
  const channels = cfg?.channels as Record<string, unknown> | undefined;
  const usingPrimary = Boolean(
    channels?.[CLAWCHAT_CHANNEL_ID] && typeof channels[CLAWCHAT_CHANNEL_ID] === "object",
  );
  const channelCfg = resolveClawchatConfig(cfg);
  const appIdRaw = channelCfg.appId ?? channelCfg.app_id ?? "";
  const usernameRaw = channelCfg.username ?? "";
  const passwordRaw = channelCfg.password ?? "";

  const appId = String(appIdRaw).trim();
  const username = String(usernameRaw).trim();
  const password = String(passwordRaw).trim();
  const hasCredentials = Boolean(appId && username && password);
  const enabledFlag =
    typeof channelCfg.enabled === "boolean"
      ? channelCfg.enabled
      : typeof channelCfg.enable === "boolean"
        ? channelCfg.enable
        : false;
  const enabled = enabledFlag === true;
  const dmPolicy = channelCfg.dmPolicy ?? "pairing";
  const parsedAllowFrom = (channelCfg.allowFrom ?? [])
    .map((entry) => String(entry).trim())
    .filter(Boolean);
  const allowFrom = dmPolicy === "open" && parsedAllowFrom.length === 0 ? ["*"] : parsedAllowFrom;
  const rawGroupPolicy = String(channelCfg.groupPolicy ?? "disabled").trim().toLowerCase();
  const groupPolicy: ResolvedClawchatAccount["groupPolicy"] =
    rawGroupPolicy === "open" || rawGroupPolicy === "disabled" || rawGroupPolicy === "allowlist"
      ? rawGroupPolicy
      : "allowlist";
  const groupAllowFrom = (channelCfg.groupAllowFrom ?? [])
    .map((entry) => String(entry).trim())
    .filter(Boolean);
  const sessionMapSync =
    channelCfg.sessionMapSync === true || channelCfg.session_map_sync === true;
  const mergeSubSessions =
    sessionMapSync &&
    (channelCfg.mergeSubSessions === true || channelCfg.merge_sub_sessions === true);
  const groupsRaw = channelCfg.groups;
  const groups: ResolvedClawchatAccount["groups"] = {};
  if (groupsRaw && typeof groupsRaw === "object" && !Array.isArray(groupsRaw)) {
    for (const [groupIdRaw, value] of Object.entries(groupsRaw)) {
      const groupId = String(groupIdRaw).trim();
      if (!groupId || !value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      const groupObj = value as {
        requireMention?: unknown;
        enabled?: unknown;
        allowFrom?: unknown;
      };
      const allowFrom = Array.isArray(groupObj.allowFrom)
        ? groupObj.allowFrom.map((entry) => String(entry).trim()).filter(Boolean)
        : [];
      groups[groupId] = {
        requireMention:
          typeof groupObj.requireMention === "boolean" ? groupObj.requireMention : undefined,
        enabled: typeof groupObj.enabled === "boolean" ? groupObj.enabled : undefined,
        allowFrom,
      };
    }
  }

  return {
    accountId: CLAWCHAT_DEFAULT_ACCOUNT_ID,
    enabled,
    configured: Boolean(enabled && hasCredentials),
    configKey: usingPrimary ? CLAWCHAT_CHANNEL_ID : CLAWCHAT_LEGACY_CHANNEL_ID,
    usesLegacyConfig: !usingPrimary && Boolean(channels?.[CLAWCHAT_LEGACY_CHANNEL_ID]),
    appId,
    username,
    password,
    allowManage: channelCfg.allowManage === true,
    dmPolicy,
    allowFrom,
    groupPolicy,
    groupAllowFrom,
    groups,
    defaultTo: channelCfg.defaultTo?.trim() || undefined,
    sessionMapSync,
    mergeSubSessions,
  };
}
