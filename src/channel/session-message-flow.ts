import { logDebug, logError, logWarn } from "../shared/logging.js";
import {
  extractConfigPatchRaw,
  extractPresetPromptSync,
  extractSessionMapSettingsSync,
  extractRouterSignal,
  extractSessionMappingSignal,
  extractSessionSyncDeliverySignal,
  extractSessionMessageSyncSignal,
  extractText,
  isCommandOuterMessage,
  isHistoryEvent,
  removeOpenclawEdgeMention,
  stripLeadingAtMentions,
  resolveRouterReplyTargetSnapshot,
  type PresetPromptSyncPayload,
  type RouterReplyTargetSnapshot,
  type SessionMapSettingsPayload,
  type SessionMappingSignal,
} from "./message.js";
import {
  hasSelfMentionInConfig,
  isGroupAllowedByPolicy,
  isGroupSenderAllowed,
  parseGroupId,
  resolveGroupRequireMention,
  resolveSenderNameFromConfig,
  resolveToUserNicknameFromConfig,
} from "./config.js";
import { buildRouterDeliveryTarget, buildRouterReplyMessage } from "./router-target.js";
import {
  CLAWCHAT_CHANNEL_ID,
  type ClawchatInboundEvent,
  type ClawchatMessageTarget,
  type OpenClawConfig,
  type ResolvedClawchatAccount,
} from "../types.js";
import { pickId } from "../shared/utils.js";

const GROUP_CONTEXT_MAX_MESSAGES = 30;
const GROUP_CONTEXT_MAX_CHARS = 6_000;
const CLAWCHAT_ROUTER_CHANNEL_ID = "clawchat-router";

type PendingGroupContextEntry = {
  senderId: string;
  senderName?: string;
  body: string;
  timestamp: number;
};

type RouterGroupQueueEntry = {
  tail: Promise<void>;
  pending: number;
};

type DispatcherOptions = {
  deliver: (payload: { text?: string; body?: string }) => Promise<void>;
  onError: (err: unknown, info: { kind: "tool" | "block" | "final" }) => void;
  onSkip: (
    payload: { text?: string; body?: string },
    info: { kind: "tool" | "block" | "final"; reason: string },
  ) => void;
};

type ResolvedAgentRoute = {
  agentId: string;
  channel: string;
  sessionKey: string;
  mainSessionKey: string;
  lastRoutePolicy: "main" | "session";
  matchedBy:
    | "binding.peer"
    | "binding.peer.parent"
    | "binding.peer.wildcard"
    | "binding.guild+roles"
    | "binding.guild"
    | "binding.team"
    | "binding.account"
    | "binding.channel"
    | "default";
  accountId?: string;
};

type MessageFlowContext = {
  getSelfId: () => string;
  updateSelfIdFromClient: (reason: string) => void;
  getReadOnlyClient: () => { rosterManage?: { readRosterMessage: (rosterId: number, mid?: number | string) => unknown } } | null;
  loadConfig: () => Promise<OpenClawConfig>;
  resolveAgentRoute: (params: {
    cfg: OpenClawConfig;
    channel: string;
    accountId: string;
    peer: { kind: "direct" | "group"; id: string };
  }) => ResolvedAgentRoute;
  resolveStorePath: (store: string | undefined, opts: { agentId: string }) => string;
  readSessionUpdatedAt: (params: { storePath: string; sessionKey: string }) => number | undefined;
  recordInboundSession: (params: {
    storePath: string;
    sessionKey: string;
    ctx: Record<string, unknown>;
    updateLastRoute?: {
      sessionKey: string;
      channel: string;
      to: string;
      accountId?: string;
      threadId?: string;
    };
    onRecordError: (err: unknown) => void;
  }) => Promise<void>;
  resolveEnvelopeFormatOptions: (cfg: OpenClawConfig) => unknown;
  formatAgentEnvelope: (params: {
    channel: string;
    from: string;
    timestamp?: number;
    previousTimestamp?: number;
    envelope: unknown;
    body: string;
  }) => string;
  finalizeInboundContext: (ctx: Record<string, unknown>) => Record<string, unknown>;
  dispatchReplyWithBufferedBlockDispatcher: (params: {
    ctx: Record<string, unknown>;
    cfg: OpenClawConfig;
    dispatcherOptions: DispatcherOptions;
  }) => Promise<unknown>;
  sendRouterReplyToSelf: (message: Record<string, unknown>) => Promise<void>;
  sendConfigPatchMarkerToSelf: (params: { stage: "before" | "after"; rawPatch: string }) => Promise<void>;
  sendPresetPromptSyncMarkerToSelf: (params: {
    stage: "before" | "after";
    chatbotId: string;
    chatbotName: string;
    prompt: string;
  }) => Promise<void>;
  sendSessionMapSettingsReportToSelf: (params: {
    sessionMapSync: boolean;
    mergeSubSessions: boolean;
  }) => Promise<void>;
  applyOpenClawConfigPatch: (rawPatch: string) => Promise<void>;
  handlePresetPromptSync: (params: {
    cfg: OpenClawConfig;
    chatbotId: string;
    chatbotName: string;
    prompt: string;
  }) => Promise<void>;
  handleSessionMapSettingsSync: (params: {
    cfg: OpenClawConfig;
    settings: SessionMapSettingsPayload;
  }) => Promise<void>;
  isSessionMapSyncEnabled: (cfg: OpenClawConfig) => boolean;
  sendText: (
    target: ClawchatMessageTarget,
    text: string,
    account?: ResolvedClawchatAccount,
    ext?: Record<string, unknown>,
  ) => Promise<unknown>;
  sendSessionMessageSyncToSelf: (update: {
    sessionFile: string;
    sessionKey?: string;
    source?: string;
    senderUserId?: string;
    observedSenderUserId?: string;
    observedFromUserId?: string;
    observedToId?: string;
    observedChatType?: "direct" | "group" | string;
    observedChannel?: string;
    observedMessageType?: string;
    message?: unknown;
  }) => Promise<void>;
  resolveSessionMapping: (params: {
    appId: string;
    openclawUserId: string;
    groupId: string;
  }) => { sessionKey: string } | null;
  applySessionMappingSignal: (signal: SessionMappingSignal) => void;
  pendingGroupContext: Map<string, PendingGroupContextEntry[]>;
  routerGroupQueueByGroupId: Map<string, RouterGroupQueueEntry>;
};

function pickNumberId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  if (value && typeof value === "object") {
    const nested = pickNumberId((value as { id?: unknown }).id);
    if (nested !== null) {
      return nested;
    }
    return pickNumberId((value as { uid?: unknown }).uid);
  }
  return null;
}

function hasMentionHint(
  selfId: string,
  eventAny: Record<string, unknown>,
  meta: Record<string, unknown>,
  eventName?: string,
): boolean {
  if (hasSelfMentionInConfig(eventAny, meta, selfId)) {
    return true;
  }
  if (eventName === "onMentionMessage") {
    return true;
  }
  return false;
}

export function createClawchatSessionMessageFlow(ctx: MessageFlowContext) {
  function shouldSeedParentSessionMapping(sessionKey: string, mappedSessionKey?: string | null): boolean {
    const normalized = sessionKey.trim().toLowerCase();
    if (!normalized || (mappedSessionKey && mappedSessionKey.trim())) {
      return false;
    }
    return (
      normalized.includes(":clawchat:group:") ||
      normalized.includes(":clawchat-router:group:")
    );
  }

  async function maybeSeedParentSessionMapping(params: {
    sessionKey: string;
    senderUserId?: string;
    fromUserId?: string;
    toId?: string;
    chatType?: "direct" | "group";
    channel?: string;
    messageType?: string;
    mappedSessionKey?: string | null;
  }): Promise<void> {
    const senderUserId = params.senderUserId?.trim() || "";
    if (!shouldSeedParentSessionMapping(params.sessionKey, params.mappedSessionKey) || !senderUserId) {
      return;
    }
    await ctx.sendSessionMessageSyncToSelf({
      sessionFile: params.sessionKey,
      sessionKey: params.sessionKey,
      source: "control_ui_user",
      senderUserId,
      observedSenderUserId: senderUserId,
      observedFromUserId: params.fromUserId?.trim() || senderUserId,
      observedToId: params.toId?.trim() || undefined,
      observedChatType: params.chatType,
      observedChannel: params.channel,
      observedMessageType: params.messageType,
      message: {
        role: "user",
        content: "",
      },
    });
  }

  function resolveDirectRouterChatbotId(params: {
    toId?: string;
    fromId?: string;
    selfId?: string;
  }): string {
    return params.toId || params.fromId || params.selfId || "";
  }

  function resolveDirectRouterUserId(params: {
    fromId?: string;
    toId?: string;
    selfId?: string;
  }): string {
    return params.fromId || params.toId || params.selfId || "";
  }

  function buildMetadataSafeSessionCtx(
    sessionCtx: Record<string, unknown>,
    shouldSanitize: boolean,
  ): Record<string, unknown> {
    if (!shouldSanitize) {
      return sessionCtx;
    }
    return {
      ...sessionCtx,
      ConversationLabel: undefined,
      OriginatingChannel: undefined,
      OriginatingTo: undefined,
      Provider: undefined,
      Surface: undefined,
      ChatType: undefined,
      GroupChannel: undefined,
      GroupSubject: undefined,
      GroupSpace: undefined,
      AccountId: undefined,
      From: undefined,
      To: undefined,
      SenderId: undefined,
      SenderName: undefined,
    };
  }

  function buildExecutionSafeSessionCtx(
    sessionCtx: Record<string, unknown>,
    shouldSanitize: boolean,
  ): Record<string, unknown> {
    if (!shouldSanitize) {
      return sessionCtx;
    }
    return {
      ...sessionCtx,
      // Preserve router-facing origin for spawned subagents and completion delivery.
      // Only the persisted metadata should forget the mapped runtime sender/target.
      Provider: undefined,
      Surface: undefined,
      GroupChannel: undefined,
      GroupSubject: undefined,
      GroupSpace: undefined,
      ChatType: undefined,
      From: undefined,
      To: undefined,
      SenderId: undefined,
      SenderName: undefined,
    };
  }

  function resolveInboundMappedSessionKey(params: {
    cfg: OpenClawConfig;
    appId: string;
    mode: "direct" | "group";
    targetId: string;
  }): string | null {
    if (params.mode !== "group") {
      return null;
    }
    if (!ctx.isSessionMapSyncEnabled(params.cfg)) {
      logDebug("session mapping lookup skipped: session_map_sync disabled", {
        appId: params.appId,
        groupId: params.targetId,
      });
      return null;
    }
    const openclawUserId = ctx.getSelfId().trim();
    if (!openclawUserId) {
      logDebug("session mapping lookup skipped: selfId unavailable", {
        appId: params.appId,
        groupId: params.targetId,
      });
      return null;
    }
    const mapping = ctx.resolveSessionMapping({
      appId: params.appId,
      openclawUserId,
      groupId: params.targetId,
    });
    const mappedSessionKey = mapping?.sessionKey?.trim() || null;
    logDebug("session mapping lookup resolved", {
      appId: params.appId,
      openclawUserId,
      groupId: params.targetId,
      mappedSessionKey: mappedSessionKey || undefined,
      hit: Boolean(mappedSessionKey),
    });
    return mappedSessionKey;
  }

  async function recordAndDispatchInboundTurn(params: {
    cfg: OpenClawConfig;
    account: ResolvedClawchatAccount;
    mode: "direct" | "group";
    targetId: string;
    senderId: string;
    senderName?: string;
    dispatchTo: string;
    rawBody: string;
    bodyForAgent: string;
    commandBody: string;
    commandAuthorized: boolean;
    messageId?: string;
    timestamp: number;
    outboundTarget: ClawchatMessageTarget;
  }): Promise<unknown> {
    const route = ctx.resolveAgentRoute({
      cfg: params.cfg,
      channel: CLAWCHAT_CHANNEL_ID,
      accountId: params.account.accountId,
      peer: {
        kind: params.mode === "group" ? "group" : "direct",
        id: params.targetId,
      },
    });
    const mappedSessionKey = resolveInboundMappedSessionKey({
      cfg: params.cfg,
      appId: params.account.appId,
      mode: params.mode,
      targetId: params.targetId,
    });
    const selectedSessionKey = (mappedSessionKey || route.sessionKey).trim();
    const storePath = ctx.resolveStorePath(params.cfg.session?.store, {
      agentId: route.agentId,
    });
    const previousTimestamp = ctx.readSessionUpdatedAt({
      storePath,
      sessionKey: selectedSessionKey,
    });
    const envelopeOptions = ctx.resolveEnvelopeFormatOptions(params.cfg);
    const conversationLabel =
      params.mode === "direct"
        ? params.senderName?.trim() || params.senderId || params.targetId
        : params.targetId;
    const bodyForEnvelope = params.commandAuthorized ? params.commandBody : params.rawBody;
    const envelopeBody = ctx.formatAgentEnvelope({
      channel: "ClawChat",
      from: conversationLabel,
      body: bodyForEnvelope,
      timestamp: params.timestamp,
      previousTimestamp,
      envelope: envelopeOptions,
    });
    const finalizedCtx = ctx.finalizeInboundContext({
      Body: envelopeBody,
      BodyForAgent: params.bodyForAgent,
      RawBody: params.rawBody,
      CommandBody: params.commandBody,
      BodyForCommands: params.commandBody,
      CommandAuthorized: params.commandAuthorized,
      From: params.senderId || params.targetId,
      To: params.dispatchTo,
      SessionKey: selectedSessionKey,
      AccountId: route.accountId ?? params.account.accountId,
      ChatType: params.mode,
      SenderId: params.senderId || undefined,
      SenderName: params.senderName || params.senderId || undefined,
      ConversationLabel: conversationLabel,
      MessageSid: params.messageId || undefined,
      MessageSidFull: params.messageId || undefined,
      Timestamp: params.timestamp,
      OriginatingChannel: CLAWCHAT_CHANNEL_ID,
      OriginatingTo: params.targetId,
      Provider: CLAWCHAT_CHANNEL_ID,
      Surface: CLAWCHAT_CHANNEL_ID,
      InputProvenance: {
        kind: "external_user",
        sourceChannel: CLAWCHAT_CHANNEL_ID,
        sourceTool: "clawchat_im",
      },
    });
    const persistedSessionKey = selectedSessionKey || route.sessionKey;
    const finalizedCtxWithSessionKey = {
      ...finalizedCtx,
      SessionKey: persistedSessionKey,
    };
    const updateLastRouteSessionKey =
      mappedSessionKey || (route.lastRoutePolicy === "main" ? route.mainSessionKey : persistedSessionKey);
    const shouldSanitizeSessionMetadata = Boolean(
      mappedSessionKey && mappedSessionKey.trim() && mappedSessionKey.trim() !== route.sessionKey,
    );
    const updateLastRoute = {
      sessionKey: updateLastRouteSessionKey,
      channel: CLAWCHAT_CHANNEL_ID,
      to: params.targetId,
      accountId: route.accountId ?? params.account.accountId,
    };

    logDebug("inbound route/session resolved", {
      mode: params.mode,
      targetId: params.targetId,
      routeAgentId: route.agentId,
      routeSessionKey: persistedSessionKey,
      routeMainSessionKey: route.mainSessionKey,
      mappedSessionKey: mappedSessionKey || undefined,
      updateLastRouteSessionKey,
      routeMatchedBy: route.matchedBy,
      storePath,
      conversationLabel,
      messageId: params.messageId || undefined,
    });
    if (shouldSanitizeSessionMetadata) {
      logDebug("mapped session delivery route preserved", {
        reason: "mapped_session_delivery_route_preserved",
        mode: params.mode,
        targetId: params.targetId,
        mappedSessionKey: mappedSessionKey || undefined,
        routeSessionKey: route.sessionKey,
        persistedSessionKey,
        updateLastRouteChannel: updateLastRoute.channel,
        updateLastRouteTo: updateLastRoute.to,
        messageId: params.messageId || undefined,
      });
      logDebug("mapped session metadata sanitized", {
        reason: "mapped_session_metadata_override",
        mode: params.mode,
        targetId: params.targetId,
        mappedSessionKey: mappedSessionKey || undefined,
        routeSessionKey: route.sessionKey,
        persistedSessionKey,
        messageId: params.messageId || undefined,
      });
    }
    const executionCtx = buildExecutionSafeSessionCtx(
      finalizedCtxWithSessionKey,
      shouldSanitizeSessionMetadata,
    );
    if (shouldSanitizeSessionMetadata) {
      logDebug("mapped session execution origin preserved", {
        reason: "mapped_session_runtime_origin_inheritance",
        mode: params.mode,
        targetId: params.targetId,
        mappedSessionKey: mappedSessionKey || undefined,
        routeSessionKey: route.sessionKey,
        persistedSessionKey,
        originatingChannel:
          typeof executionCtx.OriginatingChannel === "string"
            ? executionCtx.OriginatingChannel
            : undefined,
        originatingTo:
          typeof executionCtx.OriginatingTo === "string" ? executionCtx.OriginatingTo : undefined,
        messageId: params.messageId || undefined,
      });
    }

    await ctx.recordInboundSession({
      storePath,
      sessionKey: persistedSessionKey,
      ctx: buildMetadataSafeSessionCtx(finalizedCtxWithSessionKey, shouldSanitizeSessionMetadata),
      updateLastRoute,
      onRecordError: (err: unknown) => {
        logError("failed to record inbound session", {
          err,
          mode: params.mode,
          targetId: params.targetId,
          routeAgentId: route.agentId,
          routeSessionKey: persistedSessionKey,
          routeMainSessionKey: route.mainSessionKey,
          updateLastRouteSessionKey,
          storePath,
          messageId: params.messageId || undefined,
        });
      },
    });

    await maybeSeedParentSessionMapping({
      sessionKey: route.sessionKey,
      senderUserId: params.mode === "direct" ? params.senderId || params.targetId : params.senderId,
      fromUserId: params.senderId || undefined,
      toId: params.targetId,
      chatType: params.mode,
      channel: CLAWCHAT_CHANNEL_ID,
      messageType: "im_inbound_user",
      mappedSessionKey,
    });

    return await ctx.dispatchReplyWithBufferedBlockDispatcher({
      ctx: executionCtx,
      cfg: params.cfg,
      dispatcherOptions: {
        deliver: async (payload: { text?: string; body?: string }) => {
          const response = payload?.text ?? payload?.body ?? "";
          if (!response.trim()) {
            return;
          }
          await ctx.sendText(params.outboundTarget, response, params.account, {
            openclaw: {
              type: "session_sync_delivery",
              session: persistedSessionKey,
              source: "control_ui_reply",
              role: "assistant",
              request_sid: params.messageId || undefined,
            },
            ai: {
              role: "ai",
              ai_generate: false,
            },
          });
        },
        onError: (err: unknown, info: { kind: "tool" | "block" | "final" }) => {
          logError(`reply dispatcher send failed (kind=${info.kind})`, err);
        },
        onSkip: (
          payload: { text?: string; body?: string },
          info: { kind: "tool" | "block" | "final"; reason: string },
        ) => {
          logDebug(
            `reply dispatcher skipped payload (kind=${info.kind}, reason=${info.reason})`,
            {
              textPreview: (payload.text ?? payload.body ?? "").slice(0, 80),
            },
          );
        },
      },
    });
  }

  function appendPendingGroupContext(params: {
    groupId: string;
    senderId: string;
    senderName?: string;
    body: string;
    timestamp: number;
  }): void {
    const current = ctx.pendingGroupContext.get(params.groupId) ?? [];
    current.push({
      senderId: params.senderId,
      senderName: params.senderName,
      body: params.body,
      timestamp: params.timestamp,
    });
    while (current.length > GROUP_CONTEXT_MAX_MESSAGES) {
      current.shift();
    }
    let totalChars = current.reduce((acc, item) => acc + item.body.length, 0);
    while (current.length > 0 && totalChars > GROUP_CONTEXT_MAX_CHARS) {
      const removed = current.shift();
      totalChars -= removed?.body.length ?? 0;
    }
    ctx.pendingGroupContext.set(params.groupId, current);
  }

  function consumePendingGroupContext(groupId: string): string {
    const pending = ctx.pendingGroupContext.get(groupId) ?? [];
    if (pending.length === 0) {
      return "";
    }
    ctx.pendingGroupContext.delete(groupId);
    const lines = pending.map((item) => {
      const speaker = item.senderName?.trim() || item.senderId;
      return `[${speaker}] ${item.body}`;
    });
    return `[Group context messages since last trigger]\n${lines.join("\n")}`;
  }

  function buildBodyWithPendingGroupContext(
    groupId: string,
    body: string,
    isSlashCommand: boolean,
  ): string {
    if (isSlashCommand) {
      return body;
    }
    const pendingContext = consumePendingGroupContext(groupId);
    if (!pendingContext) {
      return body;
    }
    const contextBytes = Buffer.byteLength(pendingContext, "utf8");
    const contextPreview = Buffer.from(pendingContext, "utf8").subarray(0, 4096).toString("utf8");
    logDebug("group pending context attached", {
      groupId,
      contextBytes,
      contextPreview,
      contextPreviewTruncated: contextBytes > 4096,
    });
    return `${pendingContext}\n\n[Current message]\n${body}`;
  }

  async function handleRouterContext(
    routerMessage: Record<string, unknown>,
    requestSid: string,
    groupId: string,
  ): Promise<void> {
    const body = extractText(routerMessage as ClawchatInboundEvent);
    const trimmedGroupId = groupId.trim();
    if (!trimmedGroupId) {
      logWarn("skip router_context: groupId missing", {
        requestSid,
        keys: Object.keys(routerMessage),
      });
      return;
    }
    const fromId =
      pickId(routerMessage.from) ||
      pickId((routerMessage as { sender_id?: unknown }).sender_id) ||
      "";
    const timestampNum = Number(
      (routerMessage as { timestamp?: unknown }).timestamp ??
        (routerMessage as { ts?: unknown }).ts ??
        Date.now(),
    );
    const routerMeta = routerMessage as Record<string, unknown>;
    const cleanedBody = removeOpenclawEdgeMention(
      body,
      resolveToUserNicknameFromConfig(routerMeta, routerMeta),
    ).trim();
    if (!cleanedBody) {
      logDebug("skip router_context: empty body after cleanup", {
        requestSid,
        groupId: trimmedGroupId,
      });
      return;
    }
    appendPendingGroupContext({
      groupId: trimmedGroupId,
      senderId: fromId || trimmedGroupId,
      senderName: resolveSenderNameFromConfig(routerMeta, routerMeta) || undefined,
      body: cleanedBody,
      timestamp: Number.isFinite(timestampNum) ? timestampNum : Date.now(),
    });
    logDebug("router_context stored in pending group context", {
      requestSid,
      groupId: trimmedGroupId,
      senderId: fromId || undefined,
      bodyPreview: cleanedBody.slice(0, 80),
    });
  }

  async function runRouterSignalInGroupQueue(params: {
    groupId: string;
    requestSid: string;
    run: () => Promise<void>;
  }): Promise<void> {
    const groupId = params.groupId.trim();
    if (!groupId) {
      await params.run();
      return;
    }
    let queueEntry = ctx.routerGroupQueueByGroupId.get(groupId);
    if (!queueEntry) {
      queueEntry = {
        tail: Promise.resolve(),
        pending: 0,
      };
      ctx.routerGroupQueueByGroupId.set(groupId, queueEntry);
    }
    queueEntry.pending += 1;
    logDebug("router_signal group queue enqueue", {
      groupId,
      requestSid: params.requestSid || undefined,
      queueLength: queueEntry.pending,
    });
    const runQueued = async () => {
      logDebug("router_signal group queue start", {
        groupId,
        requestSid: params.requestSid || undefined,
        queueLength: queueEntry.pending,
      });
      try {
        await params.run();
      } finally {
        queueEntry.pending = Math.max(0, queueEntry.pending - 1);
        const queueLength = queueEntry.pending;
        if (queueLength === 0 && ctx.routerGroupQueueByGroupId.get(groupId) === queueEntry) {
          ctx.routerGroupQueueByGroupId.delete(groupId);
        }
        logDebug("router_signal group queue dequeue", {
          groupId,
          requestSid: params.requestSid || undefined,
          queueLength,
        });
      }
    };
    const queued = queueEntry.tail.then(runQueued, runQueued);
    queueEntry.tail = queued.catch(() => undefined);
    await queued;
  }

  async function handleRouterRequest(
    routerMessage: Record<string, unknown>,
    account: ResolvedClawchatAccount,
    knowledge = "",
    replyTargetSnapshot?: RouterReplyTargetSnapshot,
  ): Promise<void> {
    if (!replyTargetSnapshot) {
      logError("skip router_request: reply target snapshot missing", {
        keys: Object.keys(routerMessage),
      });
      return;
    }
    const body = extractText(routerMessage as ClawchatInboundEvent);
    if (!body.trim()) {
      logWarn("skip router_request: message.content is empty", {
        keys: Object.keys(routerMessage),
      });
      return;
    }
    const selfId = ctx.getSelfId();
    const fromId =
      pickId(routerMessage.from) ||
      pickId((routerMessage as { sender_id?: unknown }).sender_id) ||
      selfId;
    const toId =
      pickId(routerMessage.to) ||
      pickId((routerMessage as { uid?: unknown }).uid) ||
      selfId;
    const messageSid =
      pickId(routerMessage.id) || pickId((routerMessage as { message_id?: unknown }).message_id);
    const timestampNum = Number(
      (routerMessage as { timestamp?: unknown }).timestamp ??
        (routerMessage as { ts?: unknown }).ts ??
        Date.now(),
    );
    const routerRelayMark = true;
    const cfg = await ctx.loadConfig();
    const routerMeta = routerMessage as Record<string, unknown>;
    const toUserNickname = resolveToUserNicknameFromConfig(routerMeta, routerMeta);
    const cleanedBody = removeOpenclawEdgeMention(body, toUserNickname);
    const commandBody = stripLeadingAtMentions(cleanedBody);
    const trimmedBody = commandBody.trim();
    const isSlashCommand = trimmedBody.startsWith("/");
    const replyTo = replyTargetSnapshot.replyId;
    const routerGroupId = parseGroupId(
      routerMeta,
      routerMeta,
      routerMessage as ClawchatInboundEvent,
    );
    const routerToType = String(
      (routerMessage as { toType?: unknown }).toType ??
        (routerMessage as { to_type?: unknown }).to_type ??
        "",
    )
      .trim()
      .toLowerCase();
    const inboundMode =
      (replyTargetSnapshot.replyKind === "group" || routerToType === "group" || Boolean(routerGroupId))
        ? "group"
        : "direct";
    const directChatbotId = resolveDirectRouterChatbotId({
      toId: toId || undefined,
      fromId: fromId || undefined,
      selfId: selfId || undefined,
    });
    const directUserId = resolveDirectRouterUserId({
      fromId: fromId || undefined,
      toId: toId || undefined,
      selfId: selfId || undefined,
    });
    const inboundPeerId =
      inboundMode === "group" ? routerGroupId || replyTo || toId || selfId : directUserId;
    if (!inboundPeerId) {
      logError("skip router_request: failed to resolve inbound peer id", {
        requestSid: replyTargetSnapshot.requestSid,
        fromId: fromId || undefined,
        toId: toId || undefined,
        routerGroupId: routerGroupId || undefined,
        routerToType: routerToType || undefined,
      });
      return;
    }
    const bodyToDispatch =
      replyTargetSnapshot.replyKind === "group"
        ? buildBodyWithPendingGroupContext(replyTo, commandBody, isSlashCommand)
        : commandBody;
    const bodyWithKnowledge =
      !isSlashCommand && knowledge.trim().length > 0
        ? [
            "[Retrieved knowledge context]",
            knowledge.trim(),
            "[End knowledge context]",
            "",
            bodyToDispatch,
          ].join("\n")
        : bodyToDispatch;
    let replySeq = 0;
    let deliveredCount = 0;
    const replyFrom =
      replyTargetSnapshot.replyKind === "group" ? selfId || toId || fromId : directChatbotId;
    const dispatchTo = replyTargetSnapshot.replyKind === "group" ? replyTo : directChatbotId;
    const route = ctx.resolveAgentRoute({
      cfg,
      channel: CLAWCHAT_ROUTER_CHANNEL_ID,
      accountId: account.accountId,
      peer: {
        kind: inboundMode === "group" ? "group" : "direct",
        id: inboundPeerId,
      },
    });
    const mappedSessionKey =
      inboundMode === "group"
        ? resolveInboundMappedSessionKey({
            cfg,
            appId: account.appId,
            mode: "group",
            targetId: inboundPeerId,
          })
        : null;
    const storePath = ctx.resolveStorePath(cfg.session?.store, {
      agentId: route.agentId,
    });
    const selectedSessionKey = (mappedSessionKey || route.sessionKey).trim();
    const previousTimestamp = ctx.readSessionUpdatedAt({
      storePath,
      sessionKey: selectedSessionKey,
    });
    const envelopeOptions = ctx.resolveEnvelopeFormatOptions(cfg);
    const conversationLabel =
      inboundMode === "group"
        ? routerGroupId || replyTo || toId || selfId
        : fromId || directUserId || inboundPeerId;
    const bodyForEnvelope = isSlashCommand ? commandBody : body;
    const envelopeBody = ctx.formatAgentEnvelope({
      channel: "ClawChat",
      from: conversationLabel,
      body: bodyForEnvelope,
      timestamp: Number.isFinite(timestampNum) ? timestampNum : Date.now(),
      previousTimestamp,
      envelope: envelopeOptions,
    });
    const routerDeliveryTarget = buildRouterDeliveryTarget({
      kind: replyTargetSnapshot.replyKind === "group" ? "group" : "direct",
      id: replyTo,
    });
    const finalizedCtx = ctx.finalizeInboundContext({
      Body: envelopeBody,
      BodyForAgent: bodyWithKnowledge,
      RawBody: body,
      CommandBody: commandBody,
      BodyForCommands: commandBody,
      CommandAuthorized: isSlashCommand,
      From: inboundMode === "group" ? fromId || toId || selfId : fromId || directUserId,
      To: dispatchTo,
      SessionKey: selectedSessionKey,
      RouterRelay: routerRelayMark,
      AccountId: route.accountId ?? account.accountId,
      MessageSid: messageSid || undefined,
      MessageSidFull: messageSid || undefined,
      Timestamp: Number.isFinite(timestampNum) ? timestampNum : Date.now(),
      OriginatingChannel: CLAWCHAT_CHANNEL_ID,
      OriginatingTo: routerDeliveryTarget,
      ChatType: inboundMode,
      Provider: CLAWCHAT_CHANNEL_ID,
      Surface: CLAWCHAT_CHANNEL_ID,
      InputProvenance: {
        kind: "external_user",
        sourceChannel: CLAWCHAT_CHANNEL_ID,
        sourceTool: "clawchat_router",
      },
      SenderId: fromId || undefined,
      SenderName: resolveSenderNameFromConfig(routerMeta, routerMeta) || fromId || undefined,
      ConversationLabel: conversationLabel,
    });
    const persistedSessionKey = selectedSessionKey || route.sessionKey;
    const finalizedCtxWithSessionKey = {
      ...finalizedCtx,
      SessionKey: persistedSessionKey,
    };
    const updateLastRouteSessionKey =
      mappedSessionKey || (route.lastRoutePolicy === "main" ? route.mainSessionKey : persistedSessionKey);
    const shouldSanitizeSessionMetadata = Boolean(
      mappedSessionKey && mappedSessionKey.trim() && mappedSessionKey.trim() !== route.sessionKey,
    );
    const updateLastRoute = {
      sessionKey: updateLastRouteSessionKey,
      channel: CLAWCHAT_CHANNEL_ID,
      to: routerDeliveryTarget,
      accountId: route.accountId ?? account.accountId,
    };
    logDebug("router_request target resolved", {
      requestSid: replyTargetSnapshot.requestSid,
      replyKind: replyTargetSnapshot.replyKind,
      replyId: replyTo,
      resolvedBy: "snapshot",
      fromId: fromId || undefined,
      toId: toId || undefined,
    });
    logDebug("router_request inbound route/session resolved", {
      requestSid: replyTargetSnapshot.requestSid,
      inboundMode,
      inboundPeerId,
      routeAgentId: route.agentId,
      routeSessionKey: persistedSessionKey,
      routeMainSessionKey: route.mainSessionKey,
      mappedSessionKey: mappedSessionKey || undefined,
      updateLastRouteSessionKey,
      routeMatchedBy: route.matchedBy,
      storePath,
      messageId: messageSid || undefined,
    });
    if (shouldSanitizeSessionMetadata) {
      logDebug("mapped session delivery route preserved", {
        reason: "mapped_session_delivery_route_preserved",
        requestSid: replyTargetSnapshot.requestSid,
        inboundMode,
        groupId: inboundMode === "group" ? inboundPeerId : undefined,
        mappedSessionKey: mappedSessionKey || undefined,
        routeSessionKey: route.sessionKey,
        persistedSessionKey,
        updateLastRouteChannel: updateLastRoute.channel,
        updateLastRouteTo: updateLastRoute.to,
        messageId: messageSid || undefined,
      });
      logDebug("mapped session metadata sanitized", {
        reason: "mapped_session_metadata_override",
        requestSid: replyTargetSnapshot.requestSid,
        inboundMode,
        groupId: inboundMode === "group" ? inboundPeerId : undefined,
        mappedSessionKey: mappedSessionKey || undefined,
        routeSessionKey: route.sessionKey,
        persistedSessionKey,
        messageId: messageSid || undefined,
      });
    }
    const executionCtx = buildExecutionSafeSessionCtx(
      finalizedCtxWithSessionKey,
      shouldSanitizeSessionMetadata,
    );
    if (shouldSanitizeSessionMetadata) {
      logDebug("mapped session execution origin preserved", {
        reason: "mapped_session_runtime_origin_inheritance",
        requestSid: replyTargetSnapshot.requestSid,
        inboundMode,
        groupId: inboundMode === "group" ? inboundPeerId : undefined,
        mappedSessionKey: mappedSessionKey || undefined,
        routeSessionKey: route.sessionKey,
        persistedSessionKey,
        originatingChannel:
          typeof executionCtx.OriginatingChannel === "string"
            ? executionCtx.OriginatingChannel
            : undefined,
        originatingTo:
          typeof executionCtx.OriginatingTo === "string" ? executionCtx.OriginatingTo : undefined,
        messageId: messageSid || undefined,
      });
    }

    await ctx.recordInboundSession({
      storePath,
      sessionKey: persistedSessionKey,
      ctx: buildMetadataSafeSessionCtx(finalizedCtxWithSessionKey, shouldSanitizeSessionMetadata),
      updateLastRoute,
      onRecordError: (err: unknown) => {
        logError("router_request recordInboundSession failed", {
          err,
          requestSid: replyTargetSnapshot.requestSid,
          routeAgentId: route.agentId,
          routeSessionKey: persistedSessionKey,
          storePath,
          messageId: messageSid || undefined,
        });
      },
    });
    logDebug("router_request recordInboundSession success", {
      requestSid: replyTargetSnapshot.requestSid,
      routeSessionKey: persistedSessionKey,
      updateLastRouteSessionKey,
      messageId: messageSid || undefined,
    });

    await maybeSeedParentSessionMapping({
      sessionKey: route.sessionKey,
      senderUserId: inboundMode === "group" ? fromId || undefined : directUserId || undefined,
      fromUserId: fromId || undefined,
      toId: inboundMode === "group" ? routerGroupId || replyTo || toId || undefined : inboundPeerId,
      chatType: inboundMode,
      channel: CLAWCHAT_ROUTER_CHANNEL_ID,
      messageType: "im_inbound_user",
      mappedSessionKey,
    });

    const result = await ctx.dispatchReplyWithBufferedBlockDispatcher({
      ctx: executionCtx,
      cfg,
      dispatcherOptions: {
        deliver: async (payload: { text?: string; body?: string }) => {
          const response = (payload?.text ?? payload?.body ?? "").trim();
          if (!response) {
            return;
          }
          replySeq += 1;
          const now = Date.now();
          const replyMessage = buildRouterReplyMessage({
            id: `router_reply_${now}_${replySeq}`,
            from: replyFrom,
            target: {
              kind: replyTargetSnapshot.replyKind === "group" ? "group" : "direct",
              id: replyTo,
            },
            text: response,
            timestamp: now,
            ext: {
              openclaw: {
                type: "session_sync_delivery",
                session: persistedSessionKey,
                source: "control_ui_reply",
                role: "assistant",
                message_id: `router_reply_${now}_${replySeq}`,
                router_request_sid: replyTargetSnapshot.requestSid,
              },
              ai: {
                role: "ai",
                ai_generate: false,
              },
            },
          });
          await ctx.sendRouterReplyToSelf(replyMessage);
          deliveredCount += 1;
        },
        onError: (err: unknown, info: { kind: "tool" | "block" | "final" }) => {
          logError(`router_request dispatcher failed (kind=${info.kind})`, err);
        },
        onSkip: (
          payload: { text?: string; body?: string },
          info: { kind: "tool" | "block" | "final"; reason: string },
        ) => {
          logDebug(
            `router_request dispatcher skipped payload (kind=${info.kind}, reason=${info.reason})`,
            {
              textPreview: (payload.text ?? payload.body ?? "").slice(0, 80),
            },
          );
        },
      },
    });
    logDebug("router_request dispatcher result", result);
    if (deliveredCount === 0) {
      logDebug("router_request produced empty replies; no router_reply sent");
      return;
    }
    logDebug("router_reply stream sent for router_request", {
      requestSid: replyTargetSnapshot.requestSid,
      requestFrom: fromId || undefined,
      replyTo: selfId,
      deliveredCount,
    });
  }

  async function onInbound(
    event: ClawchatInboundEvent,
    mode: "direct" | "group",
    account: ResolvedClawchatAccount,
    eventName?: string,
  ): Promise<void> {
    try {
      const eventAny = event as Record<string, unknown>;
      const meta = (eventAny.meta ?? eventAny) as Record<string, unknown>;
      const isHistory = isHistoryEvent(eventAny, meta);
      if (isHistory) {
        logDebug("skip history inbound event", {
          mode,
          id: pickId(eventAny.id ?? meta.id),
        });
        return;
      }
      const senderId =
        pickId(event.from) ||
        pickId(event.sender_id) ||
        pickId((event as { sender?: unknown }).sender) ||
        pickId((event as { uid?: unknown }).uid) ||
        pickId(meta.from);
      const toIdRaw =
        pickId(event.to) ||
        pickId((event as { to_id?: unknown }).to_id) ||
        pickId(meta.to) ||
        pickId(meta.uid) ||
        pickId(meta.xid);
      const groupId = parseGroupId(eventAny, meta, event);
      const directPeer =
        pickId(event.from) ||
        pickId((event as { to_id?: unknown }).to_id) ||
        pickId((event as { xid?: unknown }).xid) ||
        toIdRaw;
      const targetId = mode === "group" ? groupId : directPeer;
      if (!targetId) {
        logWarn("inbound message missing target id", {
          mode,
          eventName,
          senderId,
          toId: toIdRaw,
          groupId,
          event,
        });
        return;
      }
      ctx.updateSelfIdFromClient("inbound event");
      const selfId = ctx.getSelfId();
      const configPatchRaw = extractConfigPatchRaw(eventAny, meta);
      const presetPromptSync = extractPresetPromptSync(eventAny, meta);
      const sessionMapSettingsSync = extractSessionMapSettingsSync(eventAny, meta);
      const routerSignal = extractRouterSignal(eventAny, meta);
      const sessionMappingSignal = extractSessionMappingSignal(eventAny, meta);
      const sessionSyncDeliverySignal = extractSessionSyncDeliverySignal(eventAny, meta);
      const sessionMessageSyncSignal = extractSessionMessageSyncSignal(eventAny, meta);
      const isCommandOuter = isCommandOuterMessage(eventAny, meta);
      const isSessionMessageSyncControlEnvelope = sessionMessageSyncSignal && isCommandOuter;
      if (sessionSyncDeliverySignal) {
        logDebug("skip inbound OpenClaw delivery visible message", {
          type: sessionSyncDeliverySignal.type,
          senderId,
          toId: toIdRaw,
          targetId,
          mode,
          selfId,
          session: sessionSyncDeliverySignal.session,
          source: sessionSyncDeliverySignal.source,
          role: sessionSyncDeliverySignal.role,
          messageId: sessionSyncDeliverySignal.messageId,
        });
        return;
      }
      if (sessionMessageSyncSignal && !isCommandOuter) {
        logDebug("ignore inbound session_message_sync hint: outer type is not command", {
          senderId,
          toId: toIdRaw,
          targetId,
          mode,
          selfId,
          session: sessionMessageSyncSignal.session,
          source: sessionMessageSyncSignal.source,
          role: sessionMessageSyncSignal.role,
          messageId: sessionMessageSyncSignal.messageId,
        });
      }
      if (mode === "direct" && senderId && toIdRaw && senderId === toIdRaw) {
        const isSelfLoopback = Boolean(selfId && senderId === selfId);
        if (isSessionMessageSyncControlEnvelope) {
          logDebug("consume loopback session_message_sync control envelope", {
            senderId,
            toId: toIdRaw,
            selfId,
            isSelfLoopback,
            session: sessionMessageSyncSignal.session,
            source: sessionMessageSyncSignal.source,
            role: sessionMessageSyncSignal.role,
            messageId: sessionMessageSyncSignal.messageId,
          });
          return;
        }
        if (isSelfLoopback && account.allowManage && configPatchRaw) {
          try {
            await ctx.sendConfigPatchMarkerToSelf({
              stage: "before",
              rawPatch: configPatchRaw,
            });
            await ctx.applyOpenClawConfigPatch(configPatchRaw);
            await ctx.sendConfigPatchMarkerToSelf({
              stage: "after",
              rawPatch: configPatchRaw,
            });
            logDebug("applied config patch from self loopback message", {
              senderId,
              toId: toIdRaw,
              patchBytes: Buffer.byteLength(configPatchRaw, "utf8"),
            });
          } catch (err) {
            logError("failed to apply config patch from self loopback message", {
              err,
              senderId,
              toId: toIdRaw,
              selfId,
              allowManage: account.allowManage,
              hasConfigPatch: Boolean(configPatchRaw),
              patchBytes: Buffer.byteLength(configPatchRaw, "utf8"),
            });
          }
          return;
        }
        if (isSelfLoopback && account.allowManage && presetPromptSync) {
          if (!isCommandOuterMessage(eventAny, meta)) {
            logDebug("skip loopback preset_prompt_sync: outer type is not command", {
              senderId,
              toId: toIdRaw,
              selfId,
            });
            return;
          }
          try {
            const cfg = await ctx.loadConfig();
            await ctx.sendPresetPromptSyncMarkerToSelf({
              stage: "before",
              chatbotId: presetPromptSync.chatbotId,
              chatbotName: presetPromptSync.chatbotName,
              prompt: presetPromptSync.prompt,
            });
            await ctx.handlePresetPromptSync({
              cfg,
              chatbotId: presetPromptSync.chatbotId,
              chatbotName: presetPromptSync.chatbotName,
              prompt: presetPromptSync.prompt,
            });
            await ctx.sendPresetPromptSyncMarkerToSelf({
              stage: "after",
              chatbotId: presetPromptSync.chatbotId,
              chatbotName: presetPromptSync.chatbotName,
              prompt: presetPromptSync.prompt,
            });
            logDebug("processed preset_prompt_sync from self loopback message", {
              senderId,
              toId: toIdRaw,
              chatbotId: presetPromptSync.chatbotId,
              promptBytes: Buffer.byteLength(presetPromptSync.prompt, "utf8"),
            });
          } catch (err) {
            logError("failed to process preset_prompt_sync from self loopback message", {
              err,
              senderId,
              toId: toIdRaw,
              selfId,
              chatbotId: presetPromptSync.chatbotId,
              promptBytes: Buffer.byteLength(presetPromptSync.prompt, "utf8"),
            });
          }
          return;
        }
        if (isSelfLoopback && account.allowManage && sessionMapSettingsSync) {
          if (!isCommandOuterMessage(eventAny, meta)) {
            logDebug("skip loopback session_map_settings_sync: outer type is not command", {
              senderId,
              toId: toIdRaw,
              selfId,
            });
            return;
          }
          try {
            const cfg = await ctx.loadConfig();
            await ctx.handleSessionMapSettingsSync({
              cfg,
              settings: sessionMapSettingsSync,
            });
            await ctx.sendSessionMapSettingsReportToSelf(sessionMapSettingsSync);
            logDebug("processed session_map_settings_sync from self loopback message", {
              senderId,
              toId: toIdRaw,
              selfId,
              sessionMapSync: sessionMapSettingsSync.sessionMapSync,
              mergeSubSessions: sessionMapSettingsSync.mergeSubSessions,
            });
          } catch (err) {
            logError("failed to process session_map_settings_sync from self loopback message", {
              err,
              senderId,
              toId: toIdRaw,
              selfId,
              sessionMapSync: sessionMapSettingsSync.sessionMapSync,
              mergeSubSessions: sessionMapSettingsSync.mergeSubSessions,
            });
          }
          return;
        }
        if (isSelfLoopback && sessionMappingSignal) {
          if (!isCommandOuterMessage(eventAny, meta)) {
            logDebug("skip loopback session_mapping signal: outer type is not command", {
              senderId,
              toId: toIdRaw,
              selfId,
              signalType: sessionMappingSignal.type,
            });
            return;
          }
          const cfg = await ctx.loadConfig();
          if (!ctx.isSessionMapSyncEnabled(cfg)) {
            logDebug("skip loopback session_mapping signal: session_map_sync disabled", {
              senderId,
              toId: toIdRaw,
              selfId,
              signalType: sessionMappingSignal.type,
            });
            return;
          }
          ctx.applySessionMappingSignal(sessionMappingSignal);
          logDebug("processed session mapping signal from self loopback message", {
            senderId,
            toId: toIdRaw,
            selfId,
            signalType: sessionMappingSignal.type,
            mappingsCount: sessionMappingSignal.mappings.length,
          });
          return;
        }
        if (routerSignal?.type === "router_reply") {
          logDebug("skip loopback router_reply", {
            senderId,
            toId: toIdRaw,
            selfId,
          });
          return;
        }
        if (
          isSelfLoopback &&
          account.allowManage &&
          (routerSignal?.type === "router_request" || routerSignal?.type === "router_context")
        ) {
          if (!isCommandOuterMessage(eventAny, meta)) {
            logDebug("skip loopback router signal: outer type is not command", {
              senderId,
              toId: toIdRaw,
              selfId,
              routerSignalType: routerSignal.type,
            });
            return;
          }
          logDebug("processing loopback router signal", {
            senderId,
            toId: toIdRaw,
            selfId,
            routerSignalType: routerSignal.type,
            knowledgeBytes: Buffer.byteLength(routerSignal.knowledge ?? "", "utf8"),
          });
          const requestSid =
            pickId(routerSignal.message.id) ||
            pickId((routerSignal.message as { message_id?: unknown }).message_id) ||
            "";
          const routerChatType = String(
            (routerSignal.message as { toType?: unknown }).toType ??
              (routerSignal.message as { to_type?: unknown }).to_type ??
              "",
          )
            .trim()
            .toLowerCase();
          const routerGroupId =
            routerChatType === "group"
              ? pickId(routerSignal.message.to) ||
                pickId((routerSignal.message as { group_id?: unknown }).group_id) ||
                ""
              : "";
          if (routerSignal.type === "router_context") {
            if (!routerGroupId) {
              logWarn("skip router_context: group target missing", {
                outerEventId: pickId(eventAny.id ?? meta.id) || undefined,
                requestSid: requestSid || undefined,
                routerMessageKeys: Object.keys(routerSignal.message),
              });
              return;
            }
            await runRouterSignalInGroupQueue({
              groupId: routerGroupId,
              requestSid,
              run: () => handleRouterContext(routerSignal.message, requestSid, routerGroupId),
            });
            return;
          }
          const replyTargetSnapshot = resolveRouterReplyTargetSnapshot(routerSignal.message);
          if (!replyTargetSnapshot) {
            logError("skip router_request: failed to resolve reply target snapshot", {
              outerEventId: pickId(eventAny.id ?? meta.id) || undefined,
              routerMessageKeys: Object.keys(routerSignal.message),
            });
            return;
          }
          if (replyTargetSnapshot.replyKind === "group") {
            await runRouterSignalInGroupQueue({
              groupId: replyTargetSnapshot.replyId,
              requestSid: replyTargetSnapshot.requestSid,
              run: () =>
                handleRouterRequest(
                  routerSignal.message,
                  account,
                  routerSignal.knowledge,
                  replyTargetSnapshot,
                ),
            });
            return;
          }
          await handleRouterRequest(
            routerSignal.message,
            account,
            routerSignal.knowledge,
            replyTargetSnapshot,
          );
          return;
        }
        logDebug("skip loopback message (from === to)", {
          senderId,
          toId: toIdRaw,
          selfId,
          allowManage: account.allowManage,
          hasConfigPatch: Boolean(configPatchRaw),
          hasPresetPromptSync: Boolean(presetPromptSync),
          routerSignalType: routerSignal?.type ?? "",
        });
        return;
      }
      if (isSessionMessageSyncControlEnvelope) {
        logDebug("skip inbound session_message_sync control envelope", {
          senderId,
          toId: toIdRaw,
          targetId,
          mode,
          session: sessionMessageSyncSignal.session,
          source: sessionMessageSyncSignal.source,
          role: sessionMessageSyncSignal.role,
          messageId: sessionMessageSyncSignal.messageId,
        });
        return;
      }
      if (senderId && selfId && senderId === selfId) {
        logDebug("skip self/multi-device sync message", {
          senderId,
          toId: toIdRaw,
          targetId,
          mode,
        });
        return;
      }

      const body = extractText(event);
      if (!body) {
        logDebug("skip empty inbound", { mode, eventType: event.type });
        return;
      }
      const toUserNickname = resolveToUserNicknameFromConfig(eventAny, meta);
      const cleanedBody = removeOpenclawEdgeMention(body, toUserNickname);
      const commandBody = stripLeadingAtMentions(cleanedBody);
      const isSlashCommand = commandBody.startsWith("/");
      const timestampNum = Number(
        eventAny.timestamp ?? meta.timestamp ?? (eventAny as { ts?: unknown }).ts ?? Date.now(),
      );

      if (mode === "group") {
        if (!isGroupAllowedByPolicy(account, groupId)) {
          logDebug("skip group inbound by groupPolicy", {
            groupPolicy: account.groupPolicy,
            groupId,
            eventName,
          });
          return;
        }
        if (!senderId) {
          logWarn("skip group inbound: sender id missing", {
            groupId,
            eventName,
          });
          return;
        }
        if (!isGroupSenderAllowed(account, groupId, senderId)) {
          logDebug("skip group inbound: sender not allowed", {
            groupId,
            senderId,
            eventName,
          });
          return;
        }
        const requireMention = resolveGroupRequireMention(account, groupId);
        if (!hasMentionHint(selfId, eventAny, meta, eventName) && requireMention) {
          appendPendingGroupContext({
            groupId,
            senderId,
            senderName: resolveSenderNameFromConfig(eventAny, meta) || undefined,
            body: commandBody,
            timestamp: Number.isFinite(timestampNum) ? timestampNum : Date.now(),
          });
          logDebug("skip group inbound: mention required", {
            groupId,
            senderId,
            eventName,
            requireMention,
            queuedAsContext: true,
          });
          return;
        }
      }

      logDebug("inbound message", {
        mode,
        eventName,
        groupId: mode === "group" ? groupId : undefined,
        senderId,
        toId: toIdRaw,
        targetId,
        bodyPreview: cleanedBody.slice(0, 80),
        keys: Object.keys(meta),
      });

      const cfg = await ctx.loadConfig();
      const messageSid =
        pickId(eventAny.id ?? meta.id) ||
        pickId((eventAny as { message_id?: unknown }).message_id) ||
        "";
      const inboundMid =
        pickId(eventAny.id ?? meta.id) ||
        pickId((eventAny as { message_id?: unknown }).message_id) ||
        pickId((eventAny as { mid?: unknown }).mid) ||
        pickId((eventAny as { message?: unknown }).message);
      const senderUid = pickNumberId(senderId);
      if (
        mode === "direct" &&
        senderId &&
        toIdRaw &&
        senderId !== toIdRaw &&
        senderId !== selfId &&
        senderUid !== null &&
        inboundMid
      ) {
        try {
          const readResult = ctx.getReadOnlyClient()?.rosterManage?.readRosterMessage(senderUid, inboundMid);
          await Promise.resolve(readResult);
          logDebug("marked inbound direct message as read", {
            senderUid,
            mid: inboundMid,
            senderId,
            toId: toIdRaw,
          });
        } catch (err) {
          logWarn("failed to mark inbound direct message as read", {
            err,
            senderUid,
            mid: inboundMid ?? undefined,
            senderId,
            toId: toIdRaw,
          });
        }
      }
      let bodyToDispatch = cleanedBody;
      if (mode === "group") {
        bodyToDispatch = buildBodyWithPendingGroupContext(groupId, commandBody, isSlashCommand);
      }
      const dispatchTo = mode === "group" ? groupId : toIdRaw || account.username;
      const outboundTarget: ClawchatMessageTarget =
        mode === "group"
          ? {
              kind: "group",
              id: groupId,
            }
          : {
              kind: "user",
              id: targetId,
            };

      const result = await recordAndDispatchInboundTurn({
        cfg,
        account,
        mode,
        targetId,
        senderId: senderId || targetId,
        senderName: resolveSenderNameFromConfig(eventAny, meta) || undefined,
        dispatchTo,
        rawBody: body,
        bodyForAgent: bodyToDispatch,
        commandBody,
        commandAuthorized: isSlashCommand,
        messageId: messageSid || undefined,
        timestamp: Number.isFinite(timestampNum) ? timestampNum : Date.now(),
        outboundTarget,
      });
      logDebug("reply dispatcher result", result);
    } catch (err) {
      logError("failed to process inbound message", err);
    }
  }

  return {
    appendPendingGroupContext,
    consumePendingGroupContext,
    buildBodyWithPendingGroupContext,
    handleRouterContext,
    runRouterSignalInGroupQueue,
    handleRouterRequest,
    onInbound,
  };
}
