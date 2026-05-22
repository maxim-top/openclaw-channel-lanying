/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import { createClawchatSessionMessageFlow } from "./session-message-flow.js";
import { normalizeClawchatSessionKey, resolveClawchatSessionKeyFacts } from "./message.js";
import type { OpenClawConfig, ResolvedClawchatAccount } from "../types.js";

function createBaseAccount(): ResolvedClawchatAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    configKey: "channels.clawchat",
    usesLegacyConfig: false,
    appId: "app-id",
    username: "openclaw-user",
    password: "secret",
    allowManage: true,
    dmPolicy: "open",
    allowFrom: ["*"],
    groupPolicy: "open",
    groupAllowFrom: ["*"],
    groups: {
      "*": {
        requireMention: false,
        allowFrom: ["*"],
      },
    },
  };
}

function createBaseRoute(sessionKey = "agent:main:route-session") {
  return {
    agentId: "main",
    channel: "clawchat",
    sessionKey,
    mainSessionKey: "agent:main:main",
    lastRoutePolicy: "session" as const,
    matchedBy: "default" as const,
    accountId: "default",
  };
}

function createMessageFlowHarness(options?: {
  mappedSessionKey?: string | null;
  effectiveTargetSessionKey?: string | null;
  routeSessionKey?: string;
  cfg?: OpenClawConfig;
  sessionMapSyncEnabled?: boolean;
  allowManage?: boolean;
}) {
  const recorded: Array<Record<string, unknown>> = [];
  const dispatched: Array<Record<string, unknown>> = [];
  const routes: Array<Record<string, unknown>> = [];
  const routerReplies: Array<Record<string, unknown>> = [];
  const texts: Array<{ target: unknown; text: string; ext?: Record<string, unknown> }> = [];
  const seededSyncs: Array<Record<string, unknown>> = [];
  const handledConfigBatchSync: Array<Record<string, unknown>> = [];
  const handledSessionMapSettingsSync: Array<Record<string, unknown>> = [];
  const handledProbeRequests: Array<Record<string, unknown>> = [];
  const reportedSessionMapSettings: Array<Record<string, unknown>> = [];
  const flow = createClawchatSessionMessageFlow({
    getSelfId: () => "openclaw-user",
    updateSelfIdFromClient: () => undefined,
    getReadOnlyClient: () => null,
    loadConfig: async () => ((options?.cfg ?? {}) as OpenClawConfig),
    resolveAgentRoute: () => createBaseRoute(options?.routeSessionKey),
    resolveStorePath: () => "/tmp/mock-sessions.json",
    readSessionUpdatedAt: () => undefined,
    recordInboundSession: async ({ ctx, updateLastRoute }) => {
      recorded.push(ctx);
      if (updateLastRoute) {
        routes.push(updateLastRoute as Record<string, unknown>);
      }
    },
    resolveEnvelopeFormatOptions: () => ({}),
    formatAgentEnvelope: ({ body }) => body,
    finalizeInboundContext: (ctx) => ({ ...ctx }),
    dispatchReplyWithBufferedBlockDispatcher: async ({ ctx, dispatcherOptions }) => {
      dispatched.push(ctx);
      await dispatcherOptions.deliver({ text: "assistant reply" });
      return { ok: true };
    },
    sendRouterReplyToSelf: async (message) => {
      routerReplies.push(message);
    },
    sendPresetPromptSyncMarkerToSelf: async () => undefined,
    sendSessionMapSettingsReportToSelf: async (params) => {
      reportedSessionMapSettings.push(params as Record<string, unknown>);
    },
    applyOpenClawConfigBatchSync: async (payload) => {
      handledConfigBatchSync.push(payload as Record<string, unknown>);
    },
    handlePresetPromptSync: async () => undefined,
    handleSessionMapSettingsSync: async (params) => {
      handledSessionMapSettingsSync.push(params as Record<string, unknown>);
    },
    handleProbeRequest: async (params) => {
      handledProbeRequests.push(params as Record<string, unknown>);
    },
    isSessionMapSyncEnabled: () =>
      options?.sessionMapSyncEnabled !== false && options?.allowManage !== false,
    sendText: async (target, text, _account, ext) => {
      texts.push({ target, text, ext: ext as Record<string, unknown> | undefined });
      return "msg-1";
    },
    sendSessionTranscriptObservedToSelf: async (update) => {
      seededSyncs.push(update as Record<string, unknown>);
    },
    resolveSessionMapping: () =>
      options?.mappedSessionKey
        ? {
            sessionKey: options.mappedSessionKey,
            ...(options?.effectiveTargetSessionKey
              ? { effectiveTargetSessionKey: options.effectiveTargetSessionKey }
              : {}),
          }
        : null,
    applySessionMappingSignal: () => undefined,
    pendingGroupContext: new Map(),
    routerGroupQueueByGroupId: new Map(),
  });

  return {
    flow,
    recorded,
    dispatched,
    routes,
    routerReplies,
    texts,
    seededSyncs,
    handledConfigBatchSync,
    handledSessionMapSettingsSync,
    handledProbeRequests,
    reportedSessionMapSettings,
  };
}

function createSessionTranscriptObservedExt() {
  return JSON.stringify({
    openclaw: {
      type: "session_transcript_observed",
      session: "agent:main:clawchat-router:group:group-42",
      source: "control_ui_reply",
      messageId: "sync-reply-1",
      message: {
        role: "assistant",
        content: "assistant reply must stay a control envelope",
      },
    },
  });
}

test("session key facts canonicalize legacy keys", () => {
  assert.equal(
    normalizeClawchatSessionKey("agent:main:router:group:group-42"),
    "agent:main:clawchat-router:group:group-42",
  );
  assert.deepEqual(resolveClawchatSessionKeyFacts("agent:main:group:group-42"), {
    rawSessionKey: "agent:main:group:group-42",
    canonicalSessionKey: "agent:main:clawchat:group:group-42",
    channel: "clawchat",
    chatType: "group",
    targetId: "group-42",
    isLegacyAlias: true,
    isClawchatSession: true,
    isRouter: false,
    isGroup: true,
    isDirect: false,
    isSubagent: false,
  });
  assert.equal(
    resolveClawchatSessionKeyFacts("agent:main:subagent:test-child").isSubagent,
    true,
  );
});

function createSessionSyncDeliveryExt() {
  return JSON.stringify({
    openclaw: {
      type: "session_sync_delivery",
      session: "agent:main:clawchat:direct:other-user",
      message_id: "delivery-1",
      source: "control_ui_reply",
      role: "assistant",
    },
  });
}

function createImReplyDeliveryExt() {
  return JSON.stringify({
    openclaw: {
      type: "im_reply_delivery",
      source: "im_reply",
      role: "assistant",
    },
    ai: {
      role: "ai",
      ai_generate: false,
    },
  });
}

function createProbeExt() {
  return JSON.stringify({
    openclaw: {
      type: "probe",
      probe_id: "probe-1",
      formatVersion: 1,
      checks: {
        health: {},
      },
    },
  });
}

test("self loopback session_transcript_observed command is consumed as a control envelope", async () => {
  const harness = createMessageFlowHarness();

  await harness.flow.onInbound(
    {
      id: "sync-loopback-1",
      from: "openclaw-user",
      to: "openclaw-user",
      type: "command",
      toType: "roster",
      content: "must not dispatch",
      ext: createSessionTranscriptObservedExt(),
      timestamp: 1001,
    },
    "direct",
    createBaseAccount(),
  );

  assert.equal(harness.recorded.length, 0);
  assert.equal(harness.dispatched.length, 0);
  assert.equal(harness.texts.length, 0);
  assert.equal(harness.routerReplies.length, 0);
});

test("self loopback probe command is consumed and dispatched to the probe handler", async () => {
  const harness = createMessageFlowHarness();

  await harness.flow.onInbound(
    {
      id: "probe-loopback-1",
      from: "openclaw-user",
      to: "openclaw-user",
      type: "command",
      toType: "roster",
      content: "",
      ext: createProbeExt(),
      timestamp: 1002,
    },
    "direct",
    createBaseAccount(),
  );

  assert.equal(harness.handledProbeRequests.length, 1);
  const handledProbe = harness.handledProbeRequests[0] as {
    probe?: {
      probeId?: string;
    };
  };
  assert.equal(handledProbe.probe?.probeId, "probe-1");
  assert.equal(harness.recorded.length, 0);
  assert.equal(harness.dispatched.length, 0);
});

test("non-command session_transcript_observed loopback is dropped before normal inbound", async () => {
  const harness = createMessageFlowHarness();

  await harness.flow.onInbound(
    {
      id: "sync-loopback-text-1",
      from: "openclaw-user",
      to: "openclaw-user",
      type: "text",
      toType: "roster",
      content: "must not dispatch",
      ext: createSessionTranscriptObservedExt(),
      timestamp: 1002,
    },
    "direct",
    createBaseAccount(),
  );

  assert.equal(harness.recorded.length, 0);
  assert.equal(harness.dispatched.length, 0);
  assert.equal(harness.texts.length, 0);
});

test("non-self session_transcript_observed envelope is not treated as user text", async () => {
  const harness = createMessageFlowHarness();

  await harness.flow.onInbound(
    {
      id: "sync-non-self-1",
      from: "other-user",
      to: "openclaw-user",
      type: "command",
      toType: "roster",
      content: "must not dispatch",
      ext: createSessionTranscriptObservedExt(),
      timestamp: 1003,
    },
    "direct",
    createBaseAccount(),
  );

  assert.equal(harness.recorded.length, 0);
  assert.equal(harness.dispatched.length, 0);
  assert.equal(harness.texts.length, 0);
});

test("non-command inbound keeps normal processing even when ext carries session_transcript_observed hint", async () => {
  const harness = createMessageFlowHarness();

  await harness.flow.onInbound(
    {
      id: "sync-hint-text-1",
      from: "other-user",
      to: "openclaw-user",
      type: "text",
      toType: "roster",
      content: "hello from im",
      ext: createSessionTranscriptObservedExt(),
      timestamp: 1004,
    },
    "direct",
    createBaseAccount(),
  );

  assert.equal(harness.recorded.length, 1);
  assert.equal(harness.dispatched.length, 1);
  assert.equal(harness.texts.length, 1);
});

test("group inbound uses mapped session only when session_map_sync is enabled", async () => {
  const disabledHarness = createMessageFlowHarness({
    mappedSessionKey: "agent:main:mapped-session",
    routeSessionKey: "agent:main:route-session",
    sessionMapSyncEnabled: false,
  });
  await disabledHarness.flow.onInbound(
    {
      id: "group-disabled-1",
      from: "user-1",
      to: "group-1",
      toType: "group",
      type: "text",
      content: "hello",
      config: { mentionList: [], senderNickname: "u1" },
      timestamp: 1004,
    },
    "group",
    createBaseAccount(),
  );
  assert.equal(disabledHarness.recorded[0]?.SessionKey, "agent:main:route-session");

  const enabledHarness = createMessageFlowHarness({
    mappedSessionKey: "agent:main:mapped-session",
    routeSessionKey: "agent:main:route-session",
    sessionMapSyncEnabled: true,
  });
  await enabledHarness.flow.onInbound(
    {
      id: "group-enabled-1",
      from: "user-1",
      to: "group-1",
      toType: "group",
      type: "text",
      content: "hello",
      config: { mentionList: [], senderNickname: "u1" },
      timestamp: 1005,
    },
    "group",
    createBaseAccount(),
  );
  assert.equal(enabledHarness.recorded[0]?.SessionKey, "agent:main:mapped-session");
});

test("group inbound does not use mapped session when allowManage is disabled", async () => {
  const harness = createMessageFlowHarness({
    mappedSessionKey: "agent:main:mapped-session",
    routeSessionKey: "agent:main:route-session",
    sessionMapSyncEnabled: true,
    allowManage: false,
  });
  const account = createBaseAccount();
  account.allowManage = false;

  await harness.flow.onInbound(
    {
      id: "group-allow-manage-disabled-1",
      from: "user-1",
      to: "group-1",
      toType: "group",
      type: "text",
      content: "hello",
      config: { mentionList: [], senderNickname: "u1" },
      timestamp: 1006,
    },
    "group",
    account,
  );

  assert.equal(harness.recorded[0]?.SessionKey, "agent:main:route-session");
});

test("self loopback session_map_settings_sync command is consumed and reported", async () => {
  const harness = createMessageFlowHarness();

  await harness.flow.onInbound(
    {
      id: "settings-sync-1",
      from: "openclaw-user",
      to: "openclaw-user",
      type: "command",
      toType: "roster",
      content: "",
      ext: JSON.stringify({
        openclaw: {
          type: "session_map_settings_sync",
          settings: {
            session_map_sync: "on",
            merge_sub_sessions: "on",
          },
        },
      }),
      timestamp: 1006,
    },
    "direct",
    createBaseAccount(),
  );

  assert.equal(harness.handledSessionMapSettingsSync.length, 1);
  assert.deepEqual(harness.handledSessionMapSettingsSync[0]?.settings, {
    sessionMapSync: true,
    mergeSubSessions: true,
  });
  assert.deepEqual(harness.reportedSessionMapSettings[0], {
    sessionMapSync: true,
    mergeSubSessions: true,
  });
  assert.equal(harness.dispatched.length, 0);
});

test("self loopback session_map_settings_sync command is consumed but not reported when allowManage is disabled", async () => {
  const harness = createMessageFlowHarness();
  const account = createBaseAccount();
  account.allowManage = false;

  await harness.flow.onInbound(
    {
      id: "settings-sync-allow-manage-disabled-1",
      from: "openclaw-user",
      to: "openclaw-user",
      type: "command",
      toType: "roster",
      content: "",
      ext: JSON.stringify({
        openclaw: {
          type: "session_map_settings_sync",
          settings: {
            session_map_sync: "on",
            merge_sub_sessions: "on",
          },
        },
      }),
      timestamp: 1007,
    },
    "direct",
    account,
  );

  assert.equal(harness.handledSessionMapSettingsSync.length, 1);
  assert.equal(harness.reportedSessionMapSettings.length, 0);
  assert.equal(harness.dispatched.length, 0);
});

test("self loopback config batch sync command is consumed before legacy config patch", async () => {
  const harness = createMessageFlowHarness();

  await harness.flow.onInbound(
    {
      id: "config-kv-sync-1",
      from: "openclaw-user",
      to: "openclaw-user",
      type: "command",
      toType: "roster",
      content: "",
      ext: JSON.stringify({
        openclaw: {
          type: "config_patch",
          batchEntries: [
            {
              path: "agents.defaults.model.primary",
              value: "lanying/openai/gpt-5-mini",
            },
            {
              path: "agents.defaults.model.fallbacks",
              value: ["lanying/volcengine/Doubao-1.5-pro-32k"],
            },
          ],
          restart: true,
        },
      }),
      timestamp: 1008,
    },
    "direct",
    createBaseAccount(),
  );

  assert.equal(harness.handledConfigBatchSync.length, 1);
  assert.deepEqual(harness.handledConfigBatchSync[0]?.batchEntries, [
    {
      path: "agents.defaults.model.primary",
      value: "lanying/openai/gpt-5-mini",
    },
    {
      path: "agents.defaults.model.fallbacks",
      value: ["lanying/volcengine/Doubao-1.5-pro-32k"],
    },
  ]);
  assert.equal(harness.handledConfigBatchSync[0]?.restartGateway, true);
  assert.equal(harness.dispatched.length, 0);
});

test("self-sent direct text delivery is not dispatched back into OpenClaw", async () => {
  const harness = createMessageFlowHarness();

  await harness.flow.onInbound(
    {
      id: "self-visible-direct-1",
      from: "openclaw-user",
      to: "other-user",
      type: "text",
      toType: "roster",
      content: "visible sync delivery must not trigger another reply",
      timestamp: 1005,
    },
    "direct",
    createBaseAccount(),
  );

  assert.equal(harness.recorded.length, 0);
  assert.equal(harness.dispatched.length, 0);
  assert.equal(harness.texts.length, 0);
});

test("self-sent group text delivery is not dispatched back into OpenClaw", async () => {
  const harness = createMessageFlowHarness();

  await harness.flow.onInbound(
    {
      id: "self-visible-group-1",
      from: "openclaw-user",
      to: "group-42",
      type: "text",
      toType: "group",
      content: "visible group sync delivery must not trigger another reply",
      timestamp: 1006,
    },
    "group",
    createBaseAccount(),
    "onGroupMessage",
  );

  assert.equal(harness.recorded.length, 0);
  assert.equal(harness.dispatched.length, 0);
  assert.equal(harness.texts.length, 0);
});

test("marked session sync delivery text is not dispatched even if sender is not self", async () => {
  const harness = createMessageFlowHarness();

  await harness.flow.onInbound(
    {
      id: "marked-visible-direct-1",
      from: "other-device-or-relay",
      to: "openclaw-user",
      type: "text",
      toType: "roster",
      content: "marked visible sync delivery must not trigger another reply",
      ext: createSessionSyncDeliveryExt(),
      timestamp: 1007,
    },
    "direct",
    createBaseAccount(),
  );

  assert.equal(harness.recorded.length, 0);
  assert.equal(harness.dispatched.length, 0);
  assert.equal(harness.texts.length, 0);
});

test("marked im reply delivery text is not dispatched even if sender is not self", async () => {
  const harness = createMessageFlowHarness();

  await harness.flow.onInbound(
    {
      id: "marked-visible-im-reply-1",
      from: "other-device-or-relay",
      to: "openclaw-user",
      type: "text",
      toType: "roster",
      content: "marked visible IM reply delivery must not trigger another reply",
      ext: createImReplyDeliveryExt(),
      timestamp: 1008,
    },
    "direct",
    createBaseAccount(),
  );

  assert.equal(harness.recorded.length, 0);
  assert.equal(harness.dispatched.length, 0);
  assert.equal(harness.texts.length, 0);
});

test("native mentioned slash command dispatches cleaned command while preserving raw text", async () => {
  const harness = createMessageFlowHarness({
    mappedSessionKey: "agent:main:clawchat:group:group-42",
  });

  await harness.flow.onInbound(
    {
      id: "native-mentioned-command-1",
      from: "sender-user",
      to: "group-42",
      type: "text",
      toType: "group",
      content: "@openclaw_15_b121553b  /subagents spawn main 讲个数字1的笑话吧",
      timestamp: 1005,
      config: {
        mentionList: ["openclaw-user"],
      },
    },
    "group",
    createBaseAccount(),
    "onGroupMessage",
  );

  assert.equal(harness.dispatched.length, 1);
  assert.equal(harness.dispatched[0]?.CommandBody, "/subagents spawn main 讲个数字1的笑话吧");
  assert.equal(harness.dispatched[0]?.BodyForCommands, "/subagents spawn main 讲个数字1的笑话吧");
  assert.equal(harness.dispatched[0]?.Body, "/subagents spawn main 讲个数字1的笑话吧");
  assert.equal(harness.dispatched[0]?.RawBody, "@openclaw_15_b121553b  /subagents spawn main 讲个数字1的笑话吧");
});

test("native normal message keeps normal dispatch", async () => {
  const harness = createMessageFlowHarness();

  await harness.flow.onInbound(
    {
      id: "native-normal-1",
      from: "sender-user",
      to: "group-42",
      type: "text",
      toType: "group",
      content: "@openclaw_15_b121553b 你好",
      timestamp: 1006,
      config: {
        mentionList: ["openclaw-user"],
      },
    },
    "group",
    createBaseAccount(),
    "onGroupMessage",
  );

  assert.equal(harness.dispatched.length, 1);
});

test("router_request keeps origin in execution ctx while sanitizing persisted mapped session metadata", async () => {
  const harness = createMessageFlowHarness({
    mappedSessionKey: "agent:main:clawchat:group:group-42",
  });

  await harness.flow.handleRouterRequest(
    {
      id: "router-1",
      from: "sender-user",
      to: "openclaw-user",
      content: "hello from router",
      toType: "group",
      group_id: "group-42",
      timestamp: 12345,
    },
    createBaseAccount(),
    "",
    {
      requestSid: "router-1",
      replyKind: "group",
      replyId: "group-42",
    },
  );

  assert.equal(harness.recorded.length, 1);
  assert.equal(harness.dispatched.length, 1);
  assert.equal(harness.recorded[0]?.OriginatingChannel, undefined);
  assert.equal(harness.recorded[0]?.OriginatingTo, undefined);
  assert.equal(harness.dispatched[0]?.OriginatingChannel, "clawchat");
  assert.equal(harness.dispatched[0]?.OriginatingTo, "router:group:group-42");
  assert.equal(harness.routes.length, 1);
  assert.equal(harness.routes[0]?.sessionKey, "agent:main:clawchat:group:group-42");
  assert.equal(harness.routes[0]?.channel, "clawchat");
  assert.equal(harness.routes[0]?.to, "router:group:group-42");
  assert.equal(harness.routerReplies.length, 1);
  assert.equal(harness.texts.length, 0);
  assert.equal(harness.seededSyncs.length, 0);
});

for (const [name, rawBody, commandBody] of [
  [
    "subagents spawn",
    "@openclaw_15_b121553b  /subagents spawn main 讲个数字3的笑话吧",
    "/subagents spawn main 讲个数字3的笑话吧",
  ],
  ["new", "@openclaw_15_b121553b /new", "/new"],
  ["reset", "@openclaw_15_b121553b /reset soft", "/reset soft"],
  ["status", "@openclaw_15_b121553b /status", "/status"],
] as const) {
  test(`router_request mentioned slash command ${name} is visible as cleaned command`, async () => {
    const harness = createMessageFlowHarness({
      mappedSessionKey: "agent:main:clawchat:group:group-42",
    });

    await harness.flow.handleRouterRequest(
      {
        id: `router-mentioned-${name}-1`,
        from: "sender-user",
        to: "openclaw-user",
        content: rawBody,
        toType: "group",
        group_id: "group-42",
        timestamp: 12346,
      },
      createBaseAccount(),
      "knowledge that must not be attached to slash commands",
      {
        requestSid: `router-mentioned-${name}-1`,
        replyKind: "group",
        replyId: "group-42",
      },
    );

    assert.equal(harness.recorded.length, 1);
    assert.equal(harness.dispatched.length, 1);
    assert.equal(harness.dispatched[0]?.Body, commandBody);
    assert.equal(harness.dispatched[0]?.BodyForAgent, commandBody);
    assert.equal(harness.dispatched[0]?.CommandBody, commandBody);
    assert.equal(harness.dispatched[0]?.BodyForCommands, commandBody);
    assert.equal(harness.dispatched[0]?.RawBody, rawBody);
    assert.equal(harness.dispatched[0]?.CommandAuthorized, true);
  });
}

test("group mapped session inbound preserves origin for execution while sanitizing persisted metadata", async () => {
  const harness = createMessageFlowHarness({
    mappedSessionKey: "agent:main:clawchat:group:group-7",
  });

  await harness.flow.onInbound(
    {
      id: "msg-1",
      from: "sender-user",
      to: "group-7",
      toType: "group",
      content: "group hello",
      timestamp: 67890,
    },
    "group",
    createBaseAccount(),
  );

  assert.equal(harness.recorded.length, 1);
  assert.equal(harness.dispatched.length, 1);
  assert.equal(harness.recorded[0]?.OriginatingChannel, undefined);
  assert.equal(harness.recorded[0]?.OriginatingTo, undefined);
  assert.equal(harness.dispatched[0]?.OriginatingChannel, "clawchat");
  assert.equal(harness.dispatched[0]?.OriginatingTo, "group-7");
  assert.equal(harness.routes.length, 1);
  assert.equal(harness.routes[0]?.sessionKey, "agent:main:clawchat:group:group-7");
  assert.equal(harness.routes[0]?.channel, "clawchat");
  assert.equal(harness.routes[0]?.to, "group-7");
  assert.equal(harness.texts.length, 1);
  assert.deepEqual(harness.texts[0]?.target, { kind: "group", id: "group-7" });
  const sentExt = (harness.texts[0]?.ext ?? {}) as Record<string, any>;
  assert.equal(sentExt?.openclaw?.type, "session_sync_delivery");
  assert.equal(sentExt?.openclaw?.source, "control_ui_reply");
  assert.equal(sentExt?.openclaw?.role, "assistant");
  assert.equal(sentExt?.openclaw?.visible_delivery_owner, "plugin");
  assert.equal(sentExt?.openclaw?.trigger_msg_id, "msg-1");
  assert.equal(sentExt?.openclaw?.request_msg_id, "msg-1");
  assert.equal(sentExt?.openclaw?.request_sid, undefined);
  assert.equal(sentExt?.ai?.role, "ai");
  assert.equal(sentExt?.ai?.ai_generate, false);
});

test("group inbound uses mapped subagent session when group mapping points to child session", async () => {
  const harness = createMessageFlowHarness({
    mappedSessionKey: "agent:main:subagent:child-7",
    routeSessionKey: "agent:main:clawchat:group:group-7",
  });

  await harness.flow.onInbound(
    {
      id: "msg-group-child-mapping-1",
      from: "sender-user",
      to: "group-7",
      toType: "group",
      content: "hello after child mapping drift",
      timestamp: 67901,
    },
    "group",
    createBaseAccount(),
  );

  assert.equal(harness.recorded.length, 1);
  assert.equal(harness.dispatched.length, 1);
  assert.equal(harness.recorded[0]?.SessionKey, "agent:main:subagent:child-7");
  assert.equal(harness.dispatched[0]?.SessionKey, "agent:main:subagent:child-7");
  assert.equal(harness.routes.length, 1);
  assert.equal(harness.routes[0]?.sessionKey, "agent:main:subagent:child-7");
  assert.equal(harness.dispatched[0]?.OriginatingTo, "group-7");
  assert.equal(harness.seededSyncs.length, 0);
});

test("group inbound uses effective target session when merge_sub_sessions remaps child session", async () => {
  const harness = createMessageFlowHarness({
    mappedSessionKey: "agent:main:subagent:child-7",
    effectiveTargetSessionKey: "agent:main:clawchat:group:group-7",
    routeSessionKey: "agent:main:clawchat:group:group-7",
  });

  await harness.flow.onInbound(
    {
      id: "msg-group-child-merge-1",
      from: "sender-user",
      to: "group-7",
      toType: "group",
      content: "hello after child session is merged",
      timestamp: 67902,
    },
    "group",
    createBaseAccount(),
  );

  assert.equal(harness.recorded.length, 1);
  assert.equal(harness.dispatched.length, 1);
  assert.equal(harness.recorded[0]?.SessionKey, "agent:main:clawchat:group:group-7");
  assert.equal(harness.dispatched[0]?.SessionKey, "agent:main:clawchat:group:group-7");
  assert.equal(harness.routes.length, 1);
  assert.equal(harness.routes[0]?.sessionKey, "agent:main:clawchat:group:group-7");
});

test("direct inbound seeds the external sender user instead of the OpenClaw user", async () => {
  const harness = createMessageFlowHarness({
    routeSessionKey: "agent:main:clawchat:group:parent-group",
  });

  await harness.flow.onInbound(
    {
      id: "msg-direct-1",
      from: "real-user",
      to: "openclaw-user",
      toType: "roster",
      content: "/subagents spawn main hi",
      timestamp: 11111,
    },
    "direct",
    createBaseAccount(),
  );

  assert.equal(harness.seededSyncs.length, 1);
  assert.equal(harness.seededSyncs[0]?.senderUserId, "real-user");
  assert.equal(harness.seededSyncs[0]?.observedSenderUserId, "real-user");
  assert.equal(harness.seededSyncs[0]?.observedFromUserId, "real-user");
  assert.equal(harness.seededSyncs[0]?.observedToId, "real-user");
  assert.equal(harness.seededSyncs[0]?.observedChatType, "direct");
  assert.equal(harness.seededSyncs[0]?.observedChannel, "clawchat");
  assert.equal(harness.seededSyncs[0]?.observedMessageType, "im_inbound_user");
  assert.equal(harness.seededSyncs[0]?.source, "control_ui_user");
});

test("direct router replies still self-loop via router_reply instead of plain outbound text", async () => {
  const harness = createMessageFlowHarness();

  await harness.flow.handleRouterRequest(
    {
      id: "router-direct-1",
      from: "sender-user",
      to: "openclaw-user",
      content: "hello direct router",
      toType: "roster",
      timestamp: 123,
    },
    createBaseAccount(),
    "",
    {
      requestSid: "router-direct-1",
      replyKind: "user",
      replyId: "sender-user",
    },
  );

  assert.equal(harness.routerReplies.length, 1);
  assert.equal(harness.texts.length, 0);
  assert.equal(harness.dispatched[0]?.OriginatingChannel, "clawchat");
  assert.equal(harness.dispatched[0]?.OriginatingTo, "router:direct:sender-user");
  assert.equal(harness.routes.length, 1);
  assert.equal(harness.routes[0]?.channel, "clawchat");
  assert.equal(harness.routes[0]?.to, "router:direct:sender-user");
  assert.equal(harness.routerReplies[0]?.to, "sender-user");
  assert.equal(harness.routerReplies[0]?.toType, "roster");
  const replyExt = JSON.parse(String(harness.routerReplies[0]?.ext ?? "{}")) as Record<string, any>;
  assert.equal(replyExt?.openclaw?.type, "session_sync_delivery");
  assert.equal(replyExt?.openclaw?.source, "control_ui_reply");
  assert.equal(replyExt?.openclaw?.role, "assistant");
  assert.equal(replyExt?.openclaw?.session, "agent:main:route-session");
  assert.equal(replyExt?.openclaw?.visible_delivery_owner, "plugin");
  assert.equal(replyExt?.ai?.role, "ai");
  assert.equal(replyExt?.ai?.ai_generate, false);
});
