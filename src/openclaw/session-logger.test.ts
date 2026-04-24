/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import {
  installGlobalOpenClawSessionLogger,
  resetGlobalOpenClawSessionLoggerStatus,
} from "./session-logger.js";

function createRuntime() {
  const listeners = new Set<(update: Record<string, unknown>) => void>();
  return {
    runtime: {
      events: {
        onSessionTranscriptUpdate(listener: (update: Record<string, unknown>) => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
    emit(update: Record<string, unknown>) {
      for (const listener of listeners) {
        listener(update);
      }
    },
  };
}

test("subagent bootstrap user turn is observed but not forwarded as session sync", async () => {
  resetGlobalOpenClawSessionLoggerStatus();
  const harness = createRuntime();
  const forwarded: Array<Record<string, unknown>> = [];
  const dispose = installGlobalOpenClawSessionLogger(harness.runtime, {
    onSessionTranscriptUpdate: async (update) => {
      forwarded.push(update as Record<string, unknown>);
    },
  });

  harness.emit({
    sessionFile: "agent:main:subagent:child-1",
    messageId: "bootstrap-1",
    message: {
      role: "user",
      content:
        "[Fri 2026-04-24 15:31 GMT+8] [Subagent Context] You are running as a subagent (depth 1/1). Results auto-announce to your requester; do not busy-poll for status. [Subagent Task]: /new",
      provenance: {
        sourceChannel: "webchat",
      },
    },
  });

  dispose();
  assert.equal(forwarded.length, 0);
});

test("normal control UI user turns still forward", async () => {
  resetGlobalOpenClawSessionLoggerStatus();
  const harness = createRuntime();
  const forwarded: Array<Record<string, unknown>> = [];
  const dispose = installGlobalOpenClawSessionLogger(harness.runtime, {
    onSessionTranscriptUpdate: async (update) => {
      forwarded.push(update as Record<string, unknown>);
    },
  });

  harness.emit({
    sessionFile: "agent:main:clawchat:group:group-1",
    messageId: "user-1",
    message: {
      role: "user",
      content: "/new",
      provenance: {
        sourceChannel: "webchat",
      },
    },
  });

  dispose();
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0]?.source, "control_ui_user");
});
