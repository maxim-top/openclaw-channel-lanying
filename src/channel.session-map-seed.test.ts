/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import {
  resolvePluginVisibleDeliveryFactFromExt,
  resolveTranscriptVisibleDeliveryOwnership,
  resolveRouterDeliverySessionKey,
  shouldSeedSessionMappingFromLocalStoreEntry,
} from "./channel.js";

test("ended root session is still eligible for session map seed", () => {
  assert.equal(
    shouldSeedSessionMappingFromLocalStoreEntry({
      sessionKey: "agent:main:main",
      endedAt: Date.now(),
    }),
    true,
  );
});

test("ended child session is filtered out from session map seed", () => {
  assert.equal(
    shouldSeedSessionMappingFromLocalStoreEntry({
      sessionKey: "agent:main:subagent:child-1",
      endedAt: Date.now(),
      parentSessionKey: "agent:main:main",
    }),
    false,
  );
});

test("clawchat-created session is filtered out from session map seed", () => {
  assert.equal(
    shouldSeedSessionMappingFromLocalStoreEntry({
      sessionKey: "agent:main:clawchat:group:group-1",
    }),
    false,
  );
});

test("router group delivery session uses mapped effective target session for diagnostics", () => {
  const sessionKey = resolveRouterDeliverySessionKey({
    rawTarget: "router:group:group-1",
    appId: "app-1",
    openclawUserId: "openclaw-user",
    resolveSessionMapping: ({ appId, openclawUserId, groupId }) => {
      assert.equal(appId, "app-1");
      assert.equal(openclawUserId, "openclaw-user");
      assert.equal(groupId, "group-1");
      return {
        sessionKey: "agent:main:clawchat-router:group:parent-group",
        effectiveTargetSessionKey: "agent:main:subagent:child-1",
      };
    },
  });

  assert.equal(sessionKey, "agent:main:subagent:child-1");
});

test("router group delivery session falls back to router session without mapping", () => {
  const sessionKey = resolveRouterDeliverySessionKey({
    rawTarget: "router:group:group-1",
    appId: "app-1",
    openclawUserId: "openclaw-user",
    resolveSessionMapping: () => null,
  });

  assert.equal(sessionKey, "agent:main:clawchat-router:group:group-1");
});

test("root ClawChat assistant replies without plugin delivery fact stay connector-owned", () => {
  const ownership = resolveTranscriptVisibleDeliveryOwnership({
    sessionKey: "agent:main:clawchat-router:group:group-1",
    source: "control_ui_reply",
    role: "assistant",
    rootSessionKey: "agent:main:clawchat-router:group:group-1",
  });

  assert.equal(ownership.owner, "connector");
  assert.equal(ownership.reason, "transcript_sync");
});

test("root ClawChat assistant replies with plugin delivery fact are plugin-owned", () => {
  const ownership = resolveTranscriptVisibleDeliveryOwnership({
    sessionKey: "agent:main:clawchat-router:group:group-1",
    source: "control_ui_reply",
    role: "assistant",
    rootSessionKey: "agent:main:clawchat-router:group:group-1",
    hasPluginVisibleDeliveryFact: true,
  });

  assert.equal(ownership.owner, "plugin");
  assert.equal(ownership.reason, "plugin_visible_delivery");
});

test("subagent assistant transcript with matching plugin delivery fact is plugin-owned", () => {
  const ownership = resolveTranscriptVisibleDeliveryOwnership({
    sessionKey: "agent:main:subagent:child-1",
    source: "control_ui_reply",
    role: "assistant",
    parentSessionKey: "agent:main:main",
    rootSessionKey: "agent:main:main",
    hasPluginVisibleDeliveryFact: true,
  });

  assert.equal(ownership.owner, "plugin");
  assert.equal(ownership.reason, "plugin_visible_delivery");
});

test("subagent assistant transcript without plugin delivery fact stays connector-owned", () => {
  const ownership = resolveTranscriptVisibleDeliveryOwnership({
    sessionKey: "agent:main:subagent:child-1",
    source: "control_ui_reply",
    role: "assistant",
    parentSessionKey: "agent:main:main",
    rootSessionKey: "agent:main:main",
  });

  assert.equal(ownership.owner, "connector");
  assert.equal(ownership.reason, "transcript_sync");
});

test("plugin-owned session_sync_delivery ext produces a visible delivery fact", () => {
  const fact = resolvePluginVisibleDeliveryFactFromExt({
    text: "你好！有什么我可以帮忙的？",
    ext: {
      openclaw: {
        type: "session_sync_delivery",
        session: "agent:main:clawchat:group:6610620069649",
        source: "control_ui_reply",
        role: "assistant",
        visible_delivery_owner: "plugin",
        trigger_msg_id: "1552747048460091409",
        request_msg_id: "1552747048460091409",
      },
      ai: { role: "ai", ai_generate: false },
    },
  });

  assert.deepEqual(fact, {
    sessionKey: "agent:main:clawchat:group:6610620069649",
    text: "你好！有什么我可以帮忙的？",
    requestMsgId: "1552747048460091409",
  });
});

test("connector-owned session_sync_delivery ext does not produce a plugin delivery fact", () => {
  const fact = resolvePluginVisibleDeliveryFactFromExt({
    text: "你好！有什么我可以帮忙的？",
    ext: {
      openclaw: {
        type: "session_sync_delivery",
        session: "agent:main:clawchat:group:6610620069649",
        source: "control_ui_reply",
        role: "assistant",
      },
      ai: { ai_generate: false },
    },
  });

  assert.equal(fact, null);
});
