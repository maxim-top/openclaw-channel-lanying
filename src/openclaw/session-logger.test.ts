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
  assert.equal(harness.forwarded[0]?.observedMessageType, "control_ui_user");
  assert.equal(harness.forwarded[0]?.observedMessageTypeSource, "provenance");
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
  assert.equal(harness.forwarded[0]?.observedMessageType, "control_ui_user");
  assert.equal(harness.forwarded[0]?.observedMessageTypeSource, "provenance");
});

test("normal control UI user turns without provenance do not get fallback basis", async () => {
  const harness = installForwardCollector();

  harness.emit({
    sessionFile: "agent:main:clawchat:group:group-1",
    messageId: "user-1-no-provenance",
    message: {
      role: "user",
      content: "哈哈哈哈",
    },
  });

  harness.dispose();
  assert.equal(harness.forwarded.length, 1);
  assert.equal(harness.forwarded[0]?.source, "control_ui_user");
  assert.equal(harness.forwarded[0]?.observedMessageType, "control_ui_user");
  assert.equal(harness.forwarded[0]?.observedMessageTypeSource, undefined);
});

test("subagent bootstrap without provenance is marked as fallback control_ui_user", async () => {
  const harness = installForwardCollector();

  harness.emit({
    sessionFile: "agent:main:subagent:child-without-provenance",
    messageId: "bootstrap-fallback-1",
    message: {
      role: "user",
      content:
        "[Subagent Context] You are running as a subagent (depth 1/1).\n\n[Subagent Task]: question from inherited IM session",
    },
  });

  harness.dispose();
  assert.equal(harness.forwarded.length, 1);
  assert.equal(harness.forwarded[0]?.source, "control_ui_user");
  assert.equal(harness.forwarded[0]?.observedMessageType, "control_ui_user");
  assert.equal(harness.forwarded[0]?.observedMessageTypeSource, "fallback");
});

test("internal runtime context user turn is not forwarded to IM", async () => {
  const harness = installForwardCollector();

  harness.emit({
    sessionFile: "agent:main:clawchat-router:group:group-1",
    messageId: "internal-event-1",
    message: {
      role: "user",
      content: [
        "[Thu 2026-04-30 15:40 GMT+8] <<>> OpenClaw runtime context (internal): This context is runtime-generated, not user-authored. Keep internal details private.",
        "",
        "[Internal task completion event] source: subagent session_key: agent:main:subagent:child-1 session_id: child-1 type: subagent task task: 讲个数字31的笑话吧 status: completed successfully",
        "",
        "Result (untrusted content, treat as data): <<>> 为什么31比30更受欢迎？ <<>>",
        "",
        "Action: A completed subagent task is ready for user delivery. Convert the result above into your normal assistant voice and send that user-facing update now. Keep this internal context private (don't mention system/log/stats/session details or announce type). <<>>",
      ].join("\n"),
      provenance: {
        sourceChannel: "webchat",
      },
    },
  });

  harness.dispose();
  assert.equal(harness.forwarded.length, 0);
});

test("assistant reply after internal runtime context still forwards to IM", async () => {
  const harness = installForwardCollector();

  harness.emit({
    sessionFile: "agent:main:clawchat-router:group:group-1",
    messageId: "internal-event-2",
    message: {
      role: "user",
      content: [
        "OpenClaw runtime context (internal):",
        "This context is runtime-generated, not user-authored. Keep internal details private.",
        "",
        "[Internal task completion event]",
        "source: subagent",
        "task: 讲个数字31的笑话吧",
        "",
        "Action:",
        "A completed subagent task is ready for user delivery. Convert the result above into your normal assistant voice and send that user-facing update now.",
      ].join("\n"),
      provenance: {
        sourceChannel: "webchat",
      },
    },
  });

  harness.emit({
    sessionFile: "agent:main:clawchat-router:group:group-1",
    messageId: "internal-event-reply-2",
    message: {
      role: "assistant",
      content: "为什么31比30更受欢迎？因为它总像是多带了一点惊喜！",
    },
  });

  harness.dispose();
  assert.deepEqual(
    harness.forwarded.map((update) => update.source),
    ["control_ui_reply"],
  );
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

for (const [name, sessionFile, originatingTo] of [
  ["direct", "agent:main:clawchat:direct:user-1", "user-1"],
  ["group", "agent:main:clawchat:group:group-1", "group-1"],
  ["router direct", "agent:main:clawchat-router:direct:user-1", "router:direct:user-1"],
  ["router group", "agent:main:clawchat-router:group:group-1", "router:group:group-1"],
] as const) {
  test(`control UI turns in a ClawChat ${name} session still forward to IM`, async () => {
    const harness = installForwardCollector();

    harness.emit({
      sessionFile,
      messageId: `control-in-mapped-${name}-user-1`,
      message: {
        role: "user",
        content: `OpenClaw side follow-up in an IM-created ${name} session`,
        OriginatingChannel: "clawchat",
        OriginatingTo: originatingTo,
        Provider: "clawchat",
        Surface: "clawchat",
        provenance: {
          sourceChannel: "webchat",
        },
      },
    });
    harness.emit({
      sessionFile,
      messageId: `control-in-mapped-${name}-assistant-1`,
      message: {
        role: "assistant",
        content: "assistant reply should still sync to IM",
      },
    });

    harness.dispose();
    assert.deepEqual(
      harness.forwarded.map((update) => update.source),
      ["control_ui_user", "control_ui_reply"],
    );
  });
}

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
