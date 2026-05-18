/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import {
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

test("root ClawChat assistant replies remain plugin-owned visible deliveries", () => {
  const ownership = resolveTranscriptVisibleDeliveryOwnership({
    sessionKey: "agent:main:clawchat-router:group:group-1",
    source: "control_ui_reply",
    role: "assistant",
    rootSessionKey: "agent:main:clawchat-router:group:group-1",
  });

  assert.equal(ownership.owner, "plugin");
  assert.equal(ownership.reason, "normal_channel_reply");
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
