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
  const texts: Array<{ target: unknown; text: string }> = [];
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
    sendText: async (target, text) => {
      texts.push({ target, text });
      return "msg-1";
    },
    sendSessionMessageSyncToSelf: async () => undefined,
    rememberSessionSenderUserId: () => undefined,
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
  };
}

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
});

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
});
