/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import { createClawchatSessionMessageFlow } from "./session-message-flow.js";
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
  routeSessionKey?: string;
}) {
  const recorded: Array<Record<string, unknown>> = [];
  const dispatched: Array<Record<string, unknown>> = [];
  const routes: Array<Record<string, unknown>> = [];
  const routerReplies: Array<Record<string, unknown>> = [];
  const texts: Array<{ target: unknown; text: string; ext?: Record<string, unknown> }> = [];
  const seededSyncs: Array<Record<string, unknown>> = [];
  const flow = createClawchatSessionMessageFlow({
    getSelfId: () => "openclaw-user",
    updateSelfIdFromClient: () => undefined,
    getReadOnlyClient: () => null,
    loadConfig: async () => ({} as OpenClawConfig),
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
    sendConfigPatchMarkerToSelf: async () => undefined,
    sendPresetPromptSyncMarkerToSelf: async () => undefined,
    applyOpenClawConfigPatch: async () => undefined,
    handlePresetPromptSync: async () => undefined,
    sendText: async (target, text, _account, ext) => {
      texts.push({ target, text, ext: ext as Record<string, unknown> | undefined });
      return "msg-1";
    },
    sendSessionMessageSyncToSelf: async (update) => {
      seededSyncs.push(update as Record<string, unknown>);
    },
    resolveSessionMapping: () =>
      options?.mappedSessionKey ? { sessionKey: options.mappedSessionKey } : null,
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
  };
}

function createSessionMessageSyncExt() {
  return JSON.stringify({
    openclaw: {
      type: "session_message_sync",
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

test("self loopback session_message_sync command is consumed as a control envelope", async () => {
  const harness = createMessageFlowHarness();

  await harness.flow.onInbound(
    {
      id: "sync-loopback-1",
      from: "openclaw-user",
      to: "openclaw-user",
      type: "command",
      toType: "roster",
      content: "must not dispatch",
      ext: createSessionMessageSyncExt(),
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

test("non-command session_message_sync loopback is dropped before normal inbound", async () => {
  const harness = createMessageFlowHarness();

  await harness.flow.onInbound(
    {
      id: "sync-loopback-text-1",
      from: "openclaw-user",
      to: "openclaw-user",
      type: "text",
      toType: "roster",
      content: "must not dispatch",
      ext: createSessionMessageSyncExt(),
      timestamp: 1002,
    },
    "direct",
    createBaseAccount(),
  );

  assert.equal(harness.recorded.length, 0);
  assert.equal(harness.dispatched.length, 0);
  assert.equal(harness.texts.length, 0);
});

test("non-self session_message_sync envelope is not treated as user text", async () => {
  const harness = createMessageFlowHarness();

  await harness.flow.onInbound(
    {
      id: "sync-non-self-1",
      from: "other-user",
      to: "openclaw-user",
      type: "command",
      toType: "roster",
      content: "must not dispatch",
      ext: createSessionMessageSyncExt(),
      timestamp: 1003,
    },
    "direct",
    createBaseAccount(),
  );

  assert.equal(harness.recorded.length, 0);
  assert.equal(harness.dispatched.length, 0);
  assert.equal(harness.texts.length, 0);
});

test("non-command inbound keeps normal processing even when ext carries session_message_sync hint", async () => {
  const harness = createMessageFlowHarness();

  await harness.flow.onInbound(
    {
      id: "sync-hint-text-1",
      from: "other-user",
      to: "openclaw-user",
      type: "text",
      toType: "roster",
      content: "hello from im",
      ext: createSessionMessageSyncExt(),
      timestamp: 1004,
    },
    "direct",
    createBaseAccount(),
  );

  assert.equal(harness.recorded.length, 1);
  assert.equal(harness.dispatched.length, 1);
  assert.equal(harness.texts.length, 1);
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
  assert.equal(replyExt?.ai?.role, "ai");
  assert.equal(replyExt?.ai?.ai_generate, false);
});
