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

function installForwardCollector() {
  resetGlobalOpenClawSessionLoggerStatus();
  const harness = createRuntime();
  const forwarded: Array<Record<string, unknown>> = [];
  const dispose = installGlobalOpenClawSessionLogger(harness.runtime, {
    onSessionTranscriptUpdate: async (update) => {
      forwarded.push(update as Record<string, unknown>);
    },
  });
  return { ...harness, dispose, forwarded };
}

test("subagent bootstrap user turn is observed and forwarded as control_ui_user", async () => {
  const harness = installForwardCollector();

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

  harness.dispose();
  assert.equal(harness.forwarded.length, 1);
  assert.equal(harness.forwarded[0]?.source, "control_ui_user");
});

test("normal control UI user turns still forward", async () => {
  const harness = installForwardCollector();

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

  harness.dispose();
  assert.equal(harness.forwarded.length, 1);
  assert.equal(harness.forwarded[0]?.source, "control_ui_user");
});

test("normal control UI user and assistant turns both forward to IM", async () => {
  const harness = installForwardCollector();

  harness.emit({
    sessionFile: "agent:main:clawchat:direct:user-1",
    messageId: "control-user-1",
    message: {
      role: "user",
      content: "hello from OpenClaw",
      provenance: {
        sourceChannel: "webchat",
      },
    },
  });
  harness.emit({
    sessionFile: "agent:main:clawchat:direct:user-1",
    messageId: "control-assistant-1",
    message: {
      role: "assistant",
      content: "hello back from OpenClaw",
    },
  });

  harness.dispose();
  assert.deepEqual(
    harness.forwarded.map((update) => update.source),
    ["control_ui_user", "control_ui_reply"],
  );
});

test("control UI subagent bootstrap and assistant result both forward to IM", async () => {
  const harness = installForwardCollector();

  harness.emit({
    sessionFile: "agent:main:subagent:child-from-control",
    messageId: "control-bootstrap-1",
    message: {
      role: "user",
      content:
        "[Subagent Context] You are running as a subagent (depth 1/1). Results auto-announce to your requester; do not busy-poll for status.\n\n[Subagent Task]: 讲个数字14的笑话吧",
      provenance: {
        sourceChannel: "webchat",
      },
    },
  });
  harness.emit({
    sessionFile: "agent:main:subagent:child-from-control",
    messageId: "control-subagent-assistant-1",
    message: {
      role: "assistant",
      content: "控制台触发的子代理结果需要同步给 IM。",
    },
  });

  harness.dispose();
  assert.deepEqual(
    harness.forwarded.map((update) => update.source),
    ["control_ui_user", "control_ui_reply"],
  );
});

test("subagent bootstrap inherited from ClawChat inbound is not forwarded back to IM", async () => {
  const harness = installForwardCollector();

  harness.emit({
    sessionFile: "agent:main:subagent:child-from-im",
    messageId: "bootstrap-im-1",
    message: {
      role: "user",
      content:
        "[Subagent Context] You are running as a subagent (depth 1/1). Results auto-announce to your requester; do not busy-poll for status.\n\n[Subagent Task]: 讲个数字14的笑话吧",
      InputProvenance: {
        kind: "external_user",
        sourceChannel: "clawchat",
        sourceTool: "clawchat_im",
      },
    },
  });

  harness.emit({
    sessionFile: "agent:main:subagent:child-from-im",
    messageId: "assistant-im-1",
    message: {
      role: "assistant",
      content: "为什么数字14总是很慷慨？因为它一半是7，另一半也得分给别人！",
    },
  });

  harness.dispose();
  assert.equal(harness.forwarded.length, 0);
});

for (const [name, sourceTool, sessionFile] of [
  ["direct", "clawchat_im", "agent:main:clawchat:direct:user-1"],
  ["group", "clawchat_im", "agent:main:clawchat:group:group-1"],
  ["router direct", "clawchat_router", "agent:main:clawchat-router:direct:user-1"],
  ["router group", "clawchat_router", "agent:main:clawchat-router:group:group-1"],
] as const) {
  test(`ClawChat ${name} user and assistant turns are not forwarded back to IM`, async () => {
    const harness = installForwardCollector();

    harness.emit({
      sessionFile,
      messageId: `${name}-user-1`,
      message: {
        role: "user",
        content: `hello from ClawChat ${name}`,
        InputProvenance: {
          kind: "external_user",
          sourceChannel: "clawchat",
          sourceTool,
        },
      },
    });
    harness.emit({
      sessionFile,
      messageId: `${name}-assistant-1`,
      message: {
        role: "assistant",
        content: `assistant reply for ClawChat ${name}`,
      },
    });

    harness.dispose();
    assert.equal(harness.forwarded.length, 0);
  });
}

for (const [name, sourceTool] of [
  ["direct", "clawchat_im"],
  ["group", "clawchat_im"],
  ["router direct", "clawchat_router"],
  ["router group", "clawchat_router"],
] as const) {
  test(`ClawChat ${name} subagent bootstrap and assistant result are not forwarded back to IM`, async () => {
    const harness = installForwardCollector();

    harness.emit({
      sessionFile: `agent:main:subagent:child-from-${name.replace(/\s+/g, "-")}`,
      messageId: `${name}-bootstrap-1`,
      message: {
        role: "user",
        content:
          "[Subagent Context] You are running as a subagent (depth 1/1). Results auto-announce to your requester; do not busy-poll for status.\n\n[Subagent Task]: 讲个数字14的笑话吧",
        InputProvenance: {
          kind: "external_user",
          sourceChannel: "clawchat",
          sourceTool,
        },
      },
    });
    harness.emit({
      sessionFile: `agent:main:subagent:child-from-${name.replace(/\s+/g, "-")}`,
      messageId: `${name}-subagent-assistant-1`,
      message: {
        role: "assistant",
        content: `subagent result for ClawChat ${name}`,
      },
    });

    harness.dispose();
    assert.equal(harness.forwarded.length, 0);
  });
}
