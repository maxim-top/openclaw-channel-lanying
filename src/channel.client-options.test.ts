/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import { buildClawchatClientOptions } from "./channel.js";

test("buildClawchatClientOptions keeps the SDK on the Node websocket path", () => {
  const options = buildClawchatClientOptions({
    accountId: "default",
    enabled: true,
    configured: true,
    configKey: "default",
    usesLegacyConfig: false,
    appId: "tosd-app-id",
    username: "openclaw_user",
    password: "secret",
    allowManage: false,
    dmPolicy: "open",
    allowFrom: [],
    groupPolicy: "disabled",
    groupAllowFrom: [],
    groups: {},
  });

  assert.deepEqual(options, {
    appid: "tosd-app-id",
    ws: true,
    forceNode: true,
    transports: ["websocket"],
    autoLogin: false,
    logLevel: "off",
  });
});
