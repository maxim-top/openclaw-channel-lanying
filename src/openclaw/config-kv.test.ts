/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyConfigBatchEntries,
  buildConfigSetBatchArgv,
  buildConfigSetBatchEntries,
  buildGatewayRestartArgv,
  createConfigBatchSyncDigest,
  isRetryableConfigConflictMessage,
} from "./config-kv.js";
import { setClawchatRuntime } from "../runtime.js";

test("buildConfigSetBatchEntries renders batch-json payload directly from batch entries", () => {
  assert.deepEqual(buildConfigSetBatchEntries([
    {
      path: "agents.defaults.model.primary",
      value: "lanying/openai/gpt-5-mini",
    },
    {
      path: "models.providers.lanying.models",
      value: [{ id: "openai/gpt-5-mini" }],
    },
    {
      path: "channels.clawchat.allowManage",
      value: true,
    },
    {
      path: "gateway.port",
      value: 19001,
    },
    {
      path: "models.providers.lanying.apiKey",
      value: null,
    },
  ]), [
    {
      path: "agents.defaults.model.primary",
      value: "lanying/openai/gpt-5-mini",
    },
    {
      path: "models.providers.lanying.models",
      value: [{ id: "openai/gpt-5-mini" }],
    },
    {
      path: "channels.clawchat.allowManage",
      value: true,
    },
    {
      path: "gateway.port",
      value: 19001,
    },
    {
      path: "models.providers.lanying.apiKey",
      value: null,
    },
  ]);
});

test("buildConfigSetBatchArgv renders a single config set batch command", () => {
  const kvList = [
    {
      path: "models.providers.lanying.baseUrl",
      value: "https://connector.lanyingim.com/v1",
    },
    {
      path: "agents.defaults.model.fallbacks",
      value: ["lanying/volcengine/DeepSeek-R1"],
    },
  ];
  assert.deepEqual(buildConfigSetBatchArgv(kvList), [
    "openclaw",
    "config",
    "set",
    "--batch-json",
    JSON.stringify([
      {
        path: "models.providers.lanying.baseUrl",
        value: "https://connector.lanyingim.com/v1",
      },
      {
        path: "agents.defaults.model.fallbacks",
        value: ["lanying/volcengine/DeepSeek-R1"],
      },
    ]),
  ]);
});

test("buildConfigSetBatchEntries rejects empty paths", () => {
  assert.throws(() => buildConfigSetBatchEntries([
    {
      path: "  ",
      value: "noop",
    },
  ]), /path is required/);
});

test("buildGatewayRestartArgv renders a safe gateway restart command", () => {
  assert.deepEqual(buildGatewayRestartArgv(), [
    "openclaw",
    "gateway",
    "restart",
    "--safe",
  ]);
});

test("createConfigBatchSyncDigest stays stable for identical batch payloads", () => {
  const kvList = [
    {
      path: "models.providers.lanying.baseUrl",
      value: "https://connector.lanyingim.com/v1",
    },
    {
      path: "agents.defaults.model.fallbacks",
      value: ["lanying/volcengine/DeepSeek-R1"],
    },
  ];
  assert.equal(createConfigBatchSyncDigest(kvList), createConfigBatchSyncDigest(kvList));
});

test("isRetryableConfigConflictMessage only matches stale config conflicts", () => {
  assert.equal(isRetryableConfigConflictMessage("config changed since last load"), true);
  assert.equal(
    isRetryableConfigConflictMessage("ConfigMutationConflictError: config changed since last load"),
    true,
  );
  assert.equal(isRetryableConfigConflictMessage("validation failed: expected string"), false);
});

test("applyConfigBatchEntries retries retryable config conflicts", async () => {
  const calls: string[][] = [];
  let attempts = 0;
  setClawchatRuntime({
    system: {
      runCommandWithTimeout: async (argv: string[]) => {
        calls.push(argv);
        attempts += 1;
        if (attempts < 3) {
          return {
            exitCode: 1,
            stderr: "ConfigMutationConflictError: config changed since last load",
          };
        }
        return { exitCode: 0, stdout: "" };
      },
    },
  });

  await applyConfigBatchEntries([
    {
      path: "agents.defaults.model.primary",
      value: "lanying/openai/gpt-5-mini",
    },
  ]);

  assert.equal(attempts, 3);
  assert.equal(calls.length, 3);
});

test("applyConfigBatchEntries does not retry non-conflict failures", async () => {
  let attempts = 0;
  setClawchatRuntime({
    system: {
      runCommandWithTimeout: async () => {
        attempts += 1;
        return {
          exitCode: 1,
          stderr: "validation failed: expected string",
        };
      },
    },
  });

  await assert.rejects(
    applyConfigBatchEntries([
      {
        path: "agents.defaults.model.primary",
        value: "lanying/openai/gpt-5-mini",
      },
    ]),
    /validation failed: expected string/,
  );
  assert.equal(attempts, 1);
});
