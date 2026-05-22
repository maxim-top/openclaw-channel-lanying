/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildManagedAgentsContentForProbe,
  buildProbeValueDigest,
  evaluatePresetPromptHookConfig,
  getConfigValueAtPath,
} from "./probe.js";

test("buildProbeValueDigest distinguishes missing values from explicit null", () => {
  assert.notEqual(buildProbeValueDigest(null, true), buildProbeValueDigest(undefined, false));
});

test("buildProbeValueDigest normalizes provider model lists by id", () => {
  const path = "models.providers.lanying.models";
  const left = [
    { id: "lanying/openai/gpt-5-mini", name: "GPT 5 Mini", maxTokens: 8192 },
    { id: "lanying/volcengine/DeepSeek-R1", reasoning: true },
  ];
  const right = [
    { id: "lanying/volcengine/DeepSeek-R1", name: "DeepSeek", contextWindow: 128000 },
    { id: "lanying/openai/gpt-5-mini", reasoning: false },
  ];

  assert.equal(
    buildProbeValueDigest(left, true, path),
    buildProbeValueDigest(right, true, path),
  );
});

test("getConfigValueAtPath resolves dotted and quoted paths", () => {
  const cfg = {
    hooks: {
      internal: {
        entries: {
          "bootstrap-extra-files": {
            enabled: true,
          },
        },
      },
    },
  };
  assert.deepEqual(getConfigValueAtPath(cfg, 'hooks.internal.entries["bootstrap-extra-files"].enabled'), {
    found: true,
    value: true,
  });
  assert.deepEqual(getConfigValueAtPath(cfg, "hooks.internal.missing"), {
    found: false,
  });
});

test("buildManagedAgentsContentForProbe matches managed file template", () => {
  assert.equal(
    buildManagedAgentsContentForProbe({
      chatbotId: "bot-1",
      chatbotName: "Bot One",
      prompt: "System prompt",
    }),
    [
      "# AGENTS.md",
      "",
      "This file is managed by the ClawChat plugin for OpenClaw prompt injection.",
      "",
      "Chatbot ID: bot-1",
      "Chatbot Name: Bot One",
      "",
      "## Synced System Preset Prompt",
      "",
      "System prompt",
      "",
    ].join("\n"),
  );
});

test("evaluatePresetPromptHookConfig uses semantic checks instead of object equality", () => {
  assert.deepEqual(
    evaluatePresetPromptHookConfig({
      hooks: {
        internal: {
          enabled: true,
          entries: {
            "bootstrap-extra-files": {
              enabled: true,
              paths: ["existing.txt", "clawchat/AGENTS.md"],
              customField: "keep-me",
            },
          },
        },
      },
    }),
    {
      match: true,
      missingRequirements: [],
    },
  );

  assert.deepEqual(
    evaluatePresetPromptHookConfig({
      hooks: {
        internal: {
          enabled: false,
          entries: {},
        },
      },
    }),
    {
      match: false,
      missingRequirements: [
        "internal_hooks_disabled",
        "bootstrap_extra_files_missing",
      ],
    },
  );
});
