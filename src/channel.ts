import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { getClawchatRuntime } from "./runtime.js";
import {
  CLAWCHAT_CHANNEL_ID,
  CLAWCHAT_DEFAULT_ACCOUNT_ID,
  CLAWCHAT_LEGACY_CHANNEL_ID,
  type ClawchatChannelConfig,
  type ClawchatInboundEvent,
  type ClawchatMessageTarget,
  type ResolvedClawchatAccount,
} from "./types.js";

type OpenClawConfig = Record<string, any>;

type FlooFactory = (options: Record<string, unknown>) => ClawchatImClient;

type ClawchatImClient = {
  login: (params: {
    name?: string;
    password: string;
  }) => Promise<unknown>;
  on: (
    eventOrMap: string | Record<string, (...args: unknown[]) => void>,
    cb?: (...args: unknown[]) => void,
  ) => unknown;
  off?: (
    eventOrMap: string | Record<string, (...args: unknown[]) => void>,
    cb?: (...args: unknown[]) => void,
  ) => unknown;
  disConnect?: () => unknown;
  logout?: () => unknown;
  cleanup?: () => unknown;
  isReady?: () => boolean;
  isLogin?: () => boolean;
  listen: (
    eventOrMap: string | Record<string, (...args: unknown[]) => void>,
    cb?: (...args: unknown[]) => void,
  ) => unknown;
  sysManage: {
    sendRosterMessage: (params: {
      type: string;
      uid: string;
      content: string;
      ext?: string;
      attachment?: unknown;
    }) => Promise<unknown>;
    sendGroupMessage: (params: {
      type: string;
      gid: string;
      content: string;
      ext?: string;
      attachment?: unknown;
    }) => Promise<unknown>;
  };
  rosterManage?: {
    readRosterMessage: (rosterId: number, mid?: number | string) => unknown;
  };
  userManage?: {
    getUid?: () => unknown;
  };
};

const meta = {
  id: CLAWCHAT_CHANNEL_ID,
  label: "ClawChat",
  selectionLabel: "ClawChat IM",
  detailLabel: "ClawChat IM",
  docsPath: "/channels/clawchat",
  docsLabel: "clawchat",
  blurb: "ClawChat IM channel for OpenClaw.",
  order: 90,
};

const require = createRequire(import.meta.url);
const sdkModulePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "./lanying-im-sdk/floo-3.0.0.js",
);
let cachedFlooFactory: FlooFactory | null = null;
const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 250;
const RECONNECT_BASE_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const CONFIG_PATCH_RETRY_MAX = 3;
const CONFIG_PATCH_DEDUPE_TTL_MS = 60_000;
const GROUP_CONTEXT_MAX_MESSAGES = 30;
const GROUP_CONTEXT_MAX_CHARS = 6_000;
const CLAWCHAT_MANAGED_DIR = "clawchat";
const CLAWCHAT_MANAGED_AGENTS_PATH = `${CLAWCHAT_MANAGED_DIR}/AGENTS.md`;
const DEFAULT_AGENT_ID = "main";
const LOG_MASK = "******";
const SENSITIVE_KEY_PATTERN =
  "(?:password|pass|pwd|api[_-]?key|token|secret|authorization|auth|cookie|session|private[_-]?key)";
const SENSITIVE_KEY_RE = new RegExp(SENSITIVE_KEY_PATTERN, "i");
const SENSITIVE_INLINE_RE = new RegExp(
  `((?:${SENSITIVE_KEY_PATTERN})\\s*[:=]\\s*["']?)([^"',\\s}]+)(["']?)`,
  "gi",
);
const SENSITIVE_ESCAPED_JSON_RE = new RegExp(
  `((?:\\\\?["'])${SENSITIVE_KEY_PATTERN}(?:\\\\?["'])\\s*:\\s*(?:\\\\?["']))([^"\\\\]*(?:\\\\.[^"\\\\]*)*)(\\\\?["'])`,
  "gi",
);
let consoleRedactionInstalled = false;

installConsoleRedaction();

class NodeXmlHttpRequest {
  readyState = 0;
  status = 0;
  statusText = "";
  responseType = "";
  response: unknown = null;
  responseText = "";
  timeout = 0;
  withCredentials = false;
  onreadystatechange: ((this: any, ev: any) => any) | null = null;
  onloadend: ((this: any, ev: any) => any) | null = null;
  onerror: ((this: any, ev: any) => any) | null = null;
  ontimeout: ((this: any, ev: any) => any) | null = null;
  onabort: ((this: any, ev: any) => any) | null = null;
  private method = "GET";
  private url = "";
  private requestHeaders = new Headers();
  private responseHeaders = "";
  private aborted = false;
  private abortController: AbortController | null = null;

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
    this.readyState = 1;
    this.emitReadyStateChange();
  }

  setRequestHeader(name: string, value: string): void {
    this.requestHeaders.set(name, value);
  }

  getAllResponseHeaders(): string {
    return this.responseHeaders;
  }

  abort(): void {
    this.aborted = true;
    this.abortController?.abort();
    this.readyState = 4;
    this.emitReadyStateChange();
    this.emit("onabort");
    this.emit("onloadend");
  }

  send(data?: BodyInit | null): void {
    this.abortController = new AbortController();
    const timeoutId =
      this.timeout > 0
        ? setTimeout(() => {
            this.abortController?.abort();
            this.emit("ontimeout");
            this.emit("onloadend");
          }, this.timeout)
        : null;

    fetch(this.url, {
      method: this.method,
      headers: this.requestHeaders,
      body: this.method === "GET" || this.method === "HEAD" ? undefined : data ?? undefined,
      signal: this.abortController.signal,
    })
      .then(async (res) => {
        if (this.aborted) {
          return;
        }
        this.status = res.status;
        this.statusText = res.statusText;
        this.responseHeaders = "";
        res.headers.forEach((value, key) => {
          this.responseHeaders += `${key}: ${value}\r\n`;
        });
        const text = await res.text();
        this.responseText = text;
        this.response = text;
        this.readyState = 4;
        this.emitReadyStateChange();
        this.emit("onloadend");
      })
      .catch((err) => {
        if (this.aborted) {
          return;
        }
        logWarn("xhr polyfill fetch error", err);
        this.readyState = 4;
        this.emitReadyStateChange();
        this.emit("onerror");
        this.emit("onloadend");
      })
      .finally(() => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      });
  }

  private emitReadyStateChange(): void {
    this.onreadystatechange?.call(this, { type: "readystatechange" });
  }

  private emit(
    key: "onloadend" | "onerror" | "ontimeout" | "onabort",
  ): void {
    const fn = this[key];
    fn?.call(this, { type: key });
  }
}

function ensureXmlHttpRequestPolyfill(): void {
  if (typeof (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest !== "undefined") {
    return;
  }
  (globalThis as unknown as { XMLHttpRequest: typeof NodeXmlHttpRequest }).XMLHttpRequest =
    NodeXmlHttpRequest;
  logDebug("installed XMLHttpRequest polyfill for clawchat sdk");
}

function maskText(value: string): string {
  if (!value) {
    return value;
  }
  return LOG_MASK;
}

function redactString(value: string): string {
  const parsed = maybeParseJson(value);
  if (parsed && typeof parsed === "object") {
    try {
      return JSON.stringify(redactForLog(parsed));
    } catch {
      // Fall back to inline replacement.
    }
  }
  return value
    .replace(
      SENSITIVE_ESCAPED_JSON_RE,
      (_full, prefix: string, _secret: string, suffix: string) => {
        return `${prefix}${LOG_MASK}${suffix}`;
      },
    )
    .replace(SENSITIVE_INLINE_RE, (_full, prefix: string, _secret: string, suffix: string) => {
      return `${prefix}${LOG_MASK}${suffix}`;
    });
}

function redactForLog(value: unknown, parentKey = "", depth = 0): unknown {
  if (depth > 8) {
    return "[redaction-depth-limit]";
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(String(value.message ?? "")),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }
  if (typeof value === "string") {
    if (SENSITIVE_KEY_RE.test(parentKey)) {
      return maskText(value);
    }
    return redactString(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    if (SENSITIVE_KEY_RE.test(parentKey)) {
      return LOG_MASK;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactForLog(item, parentKey, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = LOG_MASK;
        continue;
      }
      out[k] = redactForLog(v, k, depth + 1);
    }
    return out;
  }
  return value;
}

function installConsoleRedaction(): void {
  if (consoleRedactionInstalled) {
    return;
  }
  consoleRedactionInstalled = true;
  const methods: Array<"log" | "warn" | "error" | "info" | "debug"> = [
    "log",
    "warn",
    "error",
    "info",
    "debug",
  ];
  for (const method of methods) {
    const current = console[method].bind(console);
    console[method] = ((...args: unknown[]) => {
      const sanitized = args.map((arg) => redactForLog(arg));
      current(...sanitized);
    }) as typeof console[typeof method];
  }
}

function logDebug(message: string, data?: unknown): void {
  if (data === undefined) {
    console.log(`[clawchat] ${message}`);
    return;
  }
  console.log(`[clawchat] ${message}`, redactForLog(data));
}

function logWarn(message: string, data?: unknown): void {
  if (data === undefined) {
    console.warn(`[clawchat] ${message}`);
    return;
  }
  console.warn(`[clawchat] ${message}`, redactForLog(data));
}

function logError(message: string, err?: unknown): void {
  if (err === undefined) {
    console.error(`[clawchat] ${message}`);
    return;
  }
  console.error(`[clawchat] ${message}`, redactForLog(err));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatPairingApproveHint(channel: string): string {
  return `/pair approve ${channel} <code>`;
}

function loadFlooFactory(): FlooFactory {
  if (cachedFlooFactory) {
    return cachedFlooFactory;
  }

  ensureXmlHttpRequestPolyfill();
  logDebug("loading clawchat sdk", { sdkModulePath });
  const code = readFileSync(sdkModulePath, "utf8");
  const hash = createHash("sha1").update(code).digest("hex").slice(0, 12);
  const runtimeCjsDir = path.join(os.tmpdir(), "openclaw-clawchat-sdk");
  const runtimeCjsPath = path.join(runtimeCjsDir, `floo-3.0.0-${hash}.cjs`);

  if (!existsSync(runtimeCjsDir)) {
    mkdirSync(runtimeCjsDir, { recursive: true });
  }
  if (!existsSync(runtimeCjsPath)) {
    copyFileSync(sdkModulePath, runtimeCjsPath);
    logDebug("copied sdk to cjs runtime path", { runtimeCjsPath });
  }

  const sdk = require(runtimeCjsPath) as Record<string, unknown>;
  const floo =
    typeof sdk.flooim === "function"
      ? sdk.flooim
      : typeof sdk.default === "function"
        ? sdk.default
        : sdk;

  if (typeof floo !== "function") {
    throw new Error("Invalid ClawChat SDK export: flooim factory not found");
  }

  cachedFlooFactory = floo as FlooFactory;
  logDebug("clawchat sdk loaded");
  return cachedFlooFactory;
}

function pickId(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (value && typeof value === "object") {
    const uid = (value as { uid?: unknown }).uid;
    if (typeof uid === "string" || typeof uid === "number") {
      return String(uid);
    }
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string" || typeof id === "number") {
      return String(id);
    }
  }
  return "";
}

function pickNumberId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  if (value && typeof value === "object") {
    const nested = pickNumberId((value as { id?: unknown }).id);
    if (nested !== null) {
      return nested;
    }
    return pickNumberId((value as { uid?: unknown }).uid);
  }
  return null;
}

function maybeParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function asPlainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function isConfigChangedSinceLastLoadError(err: unknown): boolean {
  const text =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? `${err.message}\n${err.stack ?? ""}`
        : "";
  return /config changed since last load; re-run config\.get and retry/i.test(text);
}

function parseJsonFromMixedText(text: string): unknown {
  const cleaned = stripAnsi(text).trim();
  if (!cleaned) {
    return null;
  }

  const direct = maybeParseJson(cleaned);
  if (direct !== null) {
    return direct;
  }

  const fencedMatches = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/gi) ?? [];
  for (const block of fencedMatches) {
    const body = block.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
    const parsed = maybeParseJson(body);
    if (parsed !== null) {
      return parsed;
    }
  }

  const firstObj = cleaned.indexOf("{");
  const lastObj = cleaned.lastIndexOf("}");
  if (firstObj >= 0 && lastObj > firstObj) {
    const parsed = maybeParseJson(cleaned.slice(firstObj, lastObj + 1));
    if (parsed !== null) {
      return parsed;
    }
  }

  const firstArr = cleaned.indexOf("[");
  const lastArr = cleaned.lastIndexOf("]");
  if (firstArr >= 0 && lastArr > firstArr) {
    const parsed = maybeParseJson(cleaned.slice(firstArr, lastArr + 1));
    if (parsed !== null) {
      return parsed;
    }
  }

  for (const line of cleaned.split(/\r?\n/)) {
    const t = line.trim();
    const parsed = maybeParseJson(t);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function parseExtValue(value: unknown): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    const parsed = maybeParseJson(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function parseConfigValue(value: unknown): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    const parsed = maybeParseJson(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function hasSelfMentionInConfig(
  eventAny: Record<string, unknown>,
  meta: Record<string, unknown>,
  selfId: string,
): boolean {
  const selfNorm = selfId.trim();
  if (!selfNorm) {
    return false;
  }
  const payload = (eventAny.payload ?? meta.payload) as Record<string, unknown> | undefined;
  const configCandidates = [
    parseConfigValue((eventAny as { config?: unknown }).config),
    parseConfigValue((meta as { config?: unknown }).config),
    parseConfigValue(payload?.config),
  ].filter(Boolean) as Record<string, unknown>[];

  for (const config of configCandidates) {
    const mentionListRaw = (config as { mentionList?: unknown; mention_list?: unknown }).mentionList
      ?? (config as { mention_list?: unknown }).mention_list;
    if (!Array.isArray(mentionListRaw)) {
      continue;
    }
    for (const item of mentionListRaw) {
      const mentionId = pickId(item);
      if (mentionId && mentionId.trim() === selfNorm) {
        return true;
      }
    }
  }
  return false;
}

function resolveToUserNicknameFromConfig(
  eventAny: Record<string, unknown>,
  meta: Record<string, unknown>,
): string {
  const payload = (eventAny.payload ?? meta.payload) as Record<string, unknown> | undefined;
  const configCandidates = [
    parseConfigValue((eventAny as { config?: unknown }).config),
    parseConfigValue((meta as { config?: unknown }).config),
    parseConfigValue(payload?.config),
  ].filter(Boolean) as Record<string, unknown>[];

  for (const config of configCandidates) {
    const nickname = (config.to_user_nickname ?? config.toUserNickname) as unknown;
    if (typeof nickname === "string" && nickname.trim()) {
      return nickname.trim();
    }
  }
  return "";
}

function removeOpenclawEdgeMention(content: string, toUserNickname: string): string {
  const nickname = toUserNickname.trim();
  if (!nickname) {
    return content;
  }
  const escapedNickname = nickname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withoutPrefix = content.replace(new RegExp(`^@${escapedNickname}(?:\\u2005| )+`), "");
  const withoutSuffix = withoutPrefix.replace(new RegExp(`@${escapedNickname}(?:\\u2005| )*$`), "");
  return withoutSuffix.trim();
}

function extractConfigPatchRaw(
  eventAny: Record<string, unknown>,
  meta: Record<string, unknown>,
): string | null {
  const payload = (eventAny.payload ?? meta.payload) as Record<string, unknown> | undefined;
  const extObjCandidates = [
    parseExtValue(eventAny.ext),
    parseExtValue(meta.ext),
    parseExtValue(payload?.ext),
  ].filter(Boolean) as Record<string, unknown>[];

  for (const extObj of extObjCandidates) {
    const openclaw = extObj.openclaw;
    if (!openclaw || typeof openclaw !== "object" || Array.isArray(openclaw)) {
      continue;
    }
    const openclawObj = openclaw as Record<string, unknown>;
    if (openclawObj.type !== "config_patch") {
      continue;
    }
    const raw = openclawObj.raw ?? openclawObj.patch ?? openclawObj.config_patch;
    if (typeof raw === "string" && raw.trim()) {
      return raw;
    }
  }
  return null;
}

function parseMetaMessage(value: unknown): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    const parsed = maybeParseJson(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function extractPresetPromptSync(
  eventAny: Record<string, unknown>,
  meta: Record<string, unknown>,
): { chatbotId: string; chatbotName: string; prompt: string } | null {
  const payload = (eventAny.payload ?? meta.payload) as Record<string, unknown> | undefined;
  const extObjCandidates = [
    parseExtValue(eventAny.ext),
    parseExtValue(meta.ext),
    parseExtValue(payload?.ext),
  ].filter(Boolean) as Record<string, unknown>[];

  for (const extObj of extObjCandidates) {
    const openclaw = extObj.openclaw;
    if (!openclaw || typeof openclaw !== "object" || Array.isArray(openclaw)) {
      continue;
    }
    const openclawObj = openclaw as Record<string, unknown>;
    if (String(openclawObj.type ?? "").trim() !== "preset_prompt_sync") {
      continue;
    }
    return {
      chatbotId: String(openclawObj.chatbotId ?? "").trim(),
      chatbotName: String(openclawObj.chatbotName ?? "").trim(),
      prompt: typeof openclawObj.prompt === "string" ? openclawObj.prompt : "",
    };
  }
  return null;
}

function extractRouterSignal(
  eventAny: Record<string, unknown>,
  meta: Record<string, unknown>,
):
  | {
      type: "router_request";
      message: Record<string, unknown>;
      knowledge: string;
    }
  | { type: "router_reply" }
  | null {
  const payload = (eventAny.payload ?? meta.payload) as Record<string, unknown> | undefined;
  const extObjCandidates = [
    parseExtValue(eventAny.ext),
    parseExtValue(meta.ext),
    parseExtValue(payload?.ext),
  ].filter(Boolean) as Record<string, unknown>[];

  for (const extObj of extObjCandidates) {
    const openclaw = extObj.openclaw;
    if (!openclaw || typeof openclaw !== "object" || Array.isArray(openclaw)) {
      continue;
    }
    const openclawObj = openclaw as Record<string, unknown>;
    const signalType = String(openclawObj.type ?? "").trim();
    if (signalType === "router_reply") {
      return { type: "router_reply" };
    }
    if (signalType !== "router_request") {
      continue;
    }
    const message = parseMetaMessage(openclawObj.message);
    if (message) {
      const knowledge =
        typeof openclawObj.knowledge === "string" ? openclawObj.knowledge.trim() : "";
      return {
        type: "router_request",
        message,
        knowledge,
      };
    }
    logWarn("skip router_request: openclaw.message is invalid", {
      signalType,
      messageType: typeof openclawObj.message,
    });
  }
  return null;
}

type RouterReplyTargetSnapshot = {
  requestSid: string;
  replyKind: "group" | "user";
  replyId: string;
};

function resolveRouterReplyTargetSnapshot(
  routerMessage: Record<string, unknown>,
): RouterReplyTargetSnapshot | null {
  const requestSid =
    pickId(routerMessage.id) || pickId((routerMessage as { message_id?: unknown }).message_id);
  if (!requestSid) {
    return null;
  }
  const fromId =
    pickId(routerMessage.from) ||
    pickId((routerMessage as { sender_id?: unknown }).sender_id) ||
    "";
  const toId =
    pickId(routerMessage.to) ||
    pickId((routerMessage as { uid?: unknown }).uid) ||
    "";
  const toType = String(
    (routerMessage as { toType?: unknown }).toType ??
      (routerMessage as { to_type?: unknown }).to_type ??
      "",
  )
    .trim()
    .toLowerCase();
  const explicitGroupId =
    pickId((routerMessage as { gid?: unknown }).gid) ||
    pickId((routerMessage as { group_id?: unknown }).group_id) ||
    pickId((routerMessage as { conversation_id?: unknown }).conversation_id) ||
    "";
  const replyGroupId = explicitGroupId || (toType === "group" ? toId : "");
  if (replyGroupId) {
    return {
      requestSid,
      replyKind: "group",
      replyId: replyGroupId,
    };
  }
  if (!fromId) {
    return null;
  }
  return {
    requestSid,
    replyKind: "user",
    replyId: fromId,
  };
}

function isCommandOuterMessage(
  eventAny: Record<string, unknown>,
  meta: Record<string, unknown>,
): boolean {
  const payload = (eventAny.payload ?? meta.payload) as Record<string, unknown> | undefined;
  const rawTypeCandidates = [
    eventAny.type,
    meta.type,
    payload?.type,
    (eventAny as { messageType?: unknown }).messageType,
    (meta as { messageType?: unknown }).messageType,
  ];
  return rawTypeCandidates.some((value) => String(value ?? "").trim().toLowerCase() === "command");
}

async function runGatewayCall(command: string, params: Record<string, unknown>): Promise<unknown> {
  const runtime = getClawchatRuntime();
  const argv = ["openclaw", "gateway", "call", command, "--params", JSON.stringify(params)];
  logDebug("exec openclaw gateway call", {
    command,
    paramsKeys: Object.keys(params),
  });
  const result = await runtime.system.runCommandWithTimeout(argv, {
    timeoutMs: 30_000,
  });
  const resultObj = asPlainObject(result);
  const stdout =
    typeof resultObj?.stdout === "string"
      ? resultObj.stdout
      : typeof resultObj?.output === "string"
        ? resultObj.output
        : typeof result === "string"
          ? result
          : "";
  const stderr =
    typeof resultObj?.stderr === "string"
      ? resultObj.stderr
      : typeof resultObj?.error === "string"
        ? resultObj.error
        : "";
  const exitCode =
    typeof resultObj?.exitCode === "number"
      ? resultObj.exitCode
      : typeof resultObj?.code === "number"
        ? resultObj.code
        : 0;
  if (stderr.trim()) {
    logWarn(`openclaw ${command} stderr`, stderr.trim());
  }
  if (exitCode !== 0) {
    const combined = `${stdout}\n${stderr}`;
    if (/pairing required/i.test(combined)) {
      throw new Error(
        "Gateway pairing required for config updates. Run `openclaw devices list` and approve the pending operator request.",
      );
    }
    throw new Error(`openclaw gateway call ${command} failed with exit code ${exitCode}`);
  }
  const parsed = parseJsonFromMixedText(stdout);
  const stdoutTrimmed = stdout.trim();
  const stdoutNoAnsi = stripAnsi(stdout);
  logDebug("openclaw gateway call completed", {
    command,
    stdoutBytes: Buffer.byteLength(stdout, "utf8"),
    stdoutSha1: createHash("sha1").update(stdout).digest("hex").slice(0, 12),
    parsedAsJson: parsed !== null,
    parsedType:
      parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed,
    parsedKeys:
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? Object.keys(parsed as Record<string, unknown>).slice(0, 20)
        : [],
    containsBaseHashToken: /base[_-]?hash/i.test(stdoutNoAnsi),
  });
  return parsed ?? stdoutTrimmed;
}

function findBaseHash(value: unknown): string {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    const parsed = parseJsonFromMixedText(value);
    if (parsed !== null) {
      return findBaseHash(parsed);
    }
    const text = stripAnsi(value);
    const regexes = [
      /"baseHash"\s*:\s*"([^"]+)"/i,
      /"base_hash"\s*:\s*"([^"]+)"/i,
      /\bbaseHash\b\s*[:=]\s*["']?([A-Za-z0-9._:-]+)["']?/i,
      /\bbase_hash\b\s*[:=]\s*["']?([A-Za-z0-9._:-]+)["']?/i,
    ];
    for (const re of regexes) {
      const matched = text.match(re);
      const candidate = matched?.[1]?.trim();
      if (candidate) {
        return candidate;
      }
    }
    return "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findBaseHash(item);
      if (nested) {
        return nested;
      }
    }
    return "";
  }
  if (typeof value !== "object") {
    return "";
  }

  const obj = value as Record<string, unknown>;
  const directCandidates = [
    obj.baseHash,
    obj.base_hash,
    obj.hash,
    obj.configHash,
    obj.config_hash,
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  for (const nested of Object.values(obj)) {
    const found = findBaseHash(nested);
    if (found) {
      return found;
    }
  }
  return "";
}

function isHistoryEvent(eventAny: Record<string, unknown>, meta: Record<string, unknown>): boolean {
  const isHistoryRaw = (eventAny.isHistory ?? meta.isHistory) as unknown;
  return (
    isHistoryRaw === true ||
    isHistoryRaw === "true" ||
    isHistoryRaw === 1 ||
    isHistoryRaw === "1"
  );
}

function collectHashCandidates(
  value: unknown,
  path = "$",
  out: Array<{ path: string; value: string }> = [],
): Array<{ path: string; value: string }> {
  if (out.length >= 20 || value == null) {
    return out;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length && out.length < 20; i += 1) {
      collectHashCandidates(value[i], `${path}[${i}]`, out);
    }
    return out;
  }
  if (typeof value !== "object") {
    return out;
  }

  const obj = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(obj)) {
    if (out.length >= 20) {
      break;
    }
    const keyLower = key.toLowerCase();
    if (keyLower.includes("hash") && typeof nested === "string" && nested.trim()) {
      out.push({
        path: `${path}.${key}`,
        value: nested.trim().slice(0, 24),
      });
    }
    collectHashCandidates(nested, `${path}.${key}`, out);
  }
  return out;
}

function extractText(event: ClawchatInboundEvent): string {
  const eventAny = event as Record<string, unknown>;
  const meta = (eventAny.meta ?? eventAny) as Record<string, unknown>;
  const candidates: unknown[] = [
    event.msg,
    event.text,
    event.content,
    event.payload?.msg,
    event.payload?.text,
    event.payload?.content,
    (event as { body?: unknown }).body,
    (event as { message?: unknown }).message,
    (event as { data?: unknown }).data,
    meta.content,
    (meta.payload as Record<string, unknown> | undefined)?.content,
    (meta.payload as Record<string, unknown> | undefined)?.text,
  ];

  for (const item of candidates) {
    if (item == null) {
      continue;
    }
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (!trimmed) {
        continue;
      }
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          const parsedText = [parsed.msg, parsed.text, parsed.content].find(
            (x) => typeof x === "string" && x.trim().length > 0,
          );
          if (typeof parsedText === "string") {
            return parsedText;
          }
        } catch {
          // Keep raw string fallback.
        }
      }
      return trimmed;
    }
      if (typeof item === "object") {
      const asObj = item as Record<string, unknown>;
      const nested = [asObj.msg, asObj.text, asObj.content].find(
        (x) => typeof x === "string" && x.trim().length > 0,
      );
      if (typeof nested === "string") {
        return nested;
      }
    }
  }

  return "";
}

function normalizeAllowEntry(raw: unknown): string {
  return String(raw ?? "")
    .replace(/^(?:clawchat|lanying):/i, "")
    .trim()
    .toLowerCase();
}

function isAllowedByAllowlist(allowlist: string[], candidate: string): boolean {
  if (allowlist.includes("*")) {
    return true;
  }
  const normalized = normalizeAllowEntry(candidate);
  if (!normalized) {
    return false;
  }
  return allowlist.some((entry) => normalizeAllowEntry(entry) === normalized);
}

function parseGroupId(
  eventAny: Record<string, unknown>,
  meta: Record<string, unknown>,
  event: ClawchatInboundEvent,
): string {
  const toType =
    String(
      (eventAny as { toType?: unknown }).toType ??
        (eventAny as { to_type?: unknown }).to_type ??
        (meta as { toType?: unknown }).toType ??
        (meta as { to_type?: unknown }).to_type ??
        "",
    )
      .trim()
      .toLowerCase() || "";
  const isGroupToType = toType === "group";
  const groupIdByTo =
    pickId(event.to) ||
    pickId((eventAny as { to?: unknown }).to) ||
    pickId((meta as { to?: unknown }).to);

  if (isGroupToType && groupIdByTo) {
    return groupIdByTo;
  }

  return (
    pickId(event.gid) ||
    pickId(event.group_id) ||
    pickId(event.conversation_id) ||
    pickId(eventAny.gid) ||
    pickId((eventAny as { group_id?: unknown }).group_id) ||
    pickId((eventAny as { conversation_id?: unknown }).conversation_id) ||
    pickId(meta.gid) ||
    pickId((meta as { group_id?: unknown }).group_id) ||
    pickId((meta as { conversation_id?: unknown }).conversation_id) ||
    groupIdByTo
  );
}

function getGroupEntry(
  account: ResolvedClawchatAccount,
  groupId: string,
): { entry?: ResolvedClawchatAccount["groups"][string]; source: "group" | "wildcard" | "none" } {
  const groupEntry = account.groups[groupId];
  if (groupEntry) {
    return { entry: groupEntry, source: "group" };
  }
  const wildcard = account.groups["*"];
  if (wildcard) {
    return { entry: wildcard, source: "wildcard" };
  }
  return { source: "none" };
}

function isGroupAllowedByPolicy(account: ResolvedClawchatAccount, groupId: string): boolean {
  if (account.groupPolicy === "disabled") {
    return false;
  }
  const matched = getGroupEntry(account, groupId);
  if (matched.entry?.enabled === false) {
    return false;
  }
  if (account.groupPolicy === "open") {
    return true;
  }
  return matched.source !== "none";
}

function isGroupSenderAllowed(
  account: ResolvedClawchatAccount,
  groupId: string,
  senderId: string,
): boolean {
  if (!senderId) {
    return false;
  }
  const matched = getGroupEntry(account, groupId);
  const senderAllowFrom =
    matched.entry && matched.entry.allowFrom.length > 0
      ? matched.entry.allowFrom
      : account.groupAllowFrom;
  if (senderAllowFrom.length === 0) {
    return false;
  }
  return isAllowedByAllowlist(senderAllowFrom, senderId);
}

function resolveGroupRequireMention(account: ResolvedClawchatAccount, groupId: string): boolean {
  const groupEntry = account.groups[groupId];
  if (typeof groupEntry?.requireMention === "boolean") {
    return groupEntry.requireMention;
  }
  const wildcardEntry = account.groups["*"];
  if (typeof wildcardEntry?.requireMention === "boolean") {
    return wildcardEntry.requireMention;
  }
  return true;
}

function hasMentionHint(
  _body: string,
  selfId: string,
  _username: string,
  eventAny: Record<string, unknown>,
  meta: Record<string, unknown>,
  eventName?: string,
): boolean {
  if (hasSelfMentionInConfig(eventAny, meta, selfId)) {
    return true;
  }
  if (eventName === "onMentionMessage") {
    return true;
  }
  return false;
}

function resolveSenderNameFromConfig(
  eventAny: Record<string, unknown>,
  meta: Record<string, unknown>,
): string {
  const payload = (eventAny.payload ?? meta.payload) as Record<string, unknown> | undefined;
  const configCandidates = [
    parseConfigValue((eventAny as { config?: unknown }).config),
    parseConfigValue((meta as { config?: unknown }).config),
    parseConfigValue(payload?.config),
  ].filter(Boolean) as Record<string, unknown>[];
  for (const config of configCandidates) {
    const nickname = (config.senderNickname ?? config.sender_nickname) as unknown;
    if (typeof nickname === "string" && nickname.trim()) {
      return nickname.trim();
    }
  }
  return "";
}

function normalizeTarget(raw: string): ClawchatMessageTarget | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.replace(/^(?:clawchat|lanying):/i, "");
  if (/^(group|g):/i.test(normalized)) {
    return { kind: "group", id: normalized.replace(/^(group|g):/i, "").trim() };
  }
  if (/^(user|u):/i.test(normalized)) {
    return { kind: "user", id: normalized.replace(/^(user|u):/i, "").trim() };
  }
  return { kind: "user", id: normalized };
}

function sanitizeAccountForLog(account: ResolvedClawchatAccount): Record<string, unknown> {
  return {
    accountId: account.accountId,
    enabled: account.enabled,
    configured: account.configured,
    appId: account.appId ? `${account.appId.slice(0, 4)}***` : "",
    username: account.username,
    dmPolicy: account.dmPolicy,
    allowFromCount: account.allowFrom.length,
    groupPolicy: account.groupPolicy,
    groupAllowFromCount: account.groupAllowFrom.length,
    groupsCount: Object.keys(account.groups).length,
  };
}

function resolveClawchatConfig(cfg: OpenClawConfig): ClawchatChannelConfig {
  const channels = cfg?.channels as Record<string, unknown> | undefined;
  const primary = channels?.[CLAWCHAT_CHANNEL_ID];
  if (primary && typeof primary === "object") {
    return primary as ClawchatChannelConfig;
  }
  const legacy = channels?.[CLAWCHAT_LEGACY_CHANNEL_ID];
  if (legacy && typeof legacy === "object") {
    return legacy as ClawchatChannelConfig;
  }
  return {};
}

function resolveClawchatAccount(cfg: OpenClawConfig): ResolvedClawchatAccount {
  const channels = cfg?.channels as Record<string, unknown> | undefined;
  const usingPrimary = Boolean(
    channels?.[CLAWCHAT_CHANNEL_ID] && typeof channels[CLAWCHAT_CHANNEL_ID] === "object",
  );
  const channelCfg = resolveClawchatConfig(cfg);
  const appIdRaw = channelCfg.appId ?? channelCfg.app_id ?? "";
  const usernameRaw = channelCfg.username ?? "";
  const passwordRaw = channelCfg.password ?? "";

  const appId = String(appIdRaw).trim();
  const username = String(usernameRaw).trim();
  const password = String(passwordRaw).trim();
  const hasCredentials = Boolean(appId && username && password);
  const enabledFlag =
    typeof channelCfg.enabled === "boolean"
      ? channelCfg.enabled
      : typeof channelCfg.enable === "boolean"
        ? channelCfg.enable
        : false;
  const enabled = enabledFlag === true;
  const dmPolicy = channelCfg.dmPolicy ?? "pairing";
  const parsedAllowFrom = (channelCfg.allowFrom ?? [])
    .map((entry) => String(entry).trim())
    .filter(Boolean);
  const allowFrom = dmPolicy === "open" && parsedAllowFrom.length === 0 ? ["*"] : parsedAllowFrom;
  const rawGroupPolicy = String(channelCfg.groupPolicy ?? "disabled").trim().toLowerCase();
  const groupPolicy: ResolvedClawchatAccount["groupPolicy"] =
    rawGroupPolicy === "open" || rawGroupPolicy === "disabled" || rawGroupPolicy === "allowlist"
      ? rawGroupPolicy
      : "allowlist";
  const groupAllowFrom = (channelCfg.groupAllowFrom ?? [])
    .map((entry) => String(entry).trim())
    .filter(Boolean);
  const groupsRaw = channelCfg.groups;
  const groups: ResolvedClawchatAccount["groups"] = {};
  if (groupsRaw && typeof groupsRaw === "object" && !Array.isArray(groupsRaw)) {
    for (const [groupIdRaw, value] of Object.entries(groupsRaw)) {
      const groupId = String(groupIdRaw).trim();
      if (!groupId || !value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      const groupObj = value as {
        requireMention?: unknown;
        enabled?: unknown;
        allowFrom?: unknown;
      };
      const allowFrom = Array.isArray(groupObj.allowFrom)
        ? groupObj.allowFrom.map((entry) => String(entry).trim()).filter(Boolean)
        : [];
      groups[groupId] = {
        requireMention:
          typeof groupObj.requireMention === "boolean" ? groupObj.requireMention : undefined,
        enabled: typeof groupObj.enabled === "boolean" ? groupObj.enabled : undefined,
        allowFrom,
      };
    }
  }

  return {
    accountId: CLAWCHAT_DEFAULT_ACCOUNT_ID,
    enabled,
    configured: Boolean(enabled && hasCredentials),
    configKey: usingPrimary ? CLAWCHAT_CHANNEL_ID : CLAWCHAT_LEGACY_CHANNEL_ID,
    usesLegacyConfig: !usingPrimary && Boolean(channels?.[CLAWCHAT_LEGACY_CHANNEL_ID]),
    appId,
    username,
    password,
    allowManage: channelCfg.allowManage === true,
    dmPolicy,
    allowFrom,
    groupPolicy,
    groupAllowFrom,
    groups,
    defaultTo: channelCfg.defaultTo?.trim() || undefined,
  };
}

class ClawchatSession {
  private client: ClawchatImClient | null = null;
  private accountKey: string | null = null;
  private ensureReadyInFlight: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private loginPromise: Promise<void> | null = null;
  private reconnectPromise: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private reconnectForceRecreate = false;
  private listenersBound = false;
  private shuttingDown = false;
  private loginSuccessSeen = false;
  private socketConnectedSeen = false;
  private selfId = "";
  private lastConfig?: ResolvedClawchatAccount;
  private onlineMarkerSent = false;
  private offlineMarkerSent = false;
  private runtimeStatusUpdater:
    | ((next: Record<string, unknown> & { accountId?: string }) => void)
    | null = null;
  private runtimeAccountId: string | null = null;
  private configPatchQueue: Promise<void> = Promise.resolve();
  private recentConfigPatchByDigest = new Map<string, number>();
  private pendingGroupContext = new Map<
    string,
    Array<{ senderId: string; senderName?: string; body: string; timestamp: number }>
  >();
  private routerGroupQueueByGroupId = new Map<string, { tail: Promise<void>; pending: number }>();

  private appendPendingGroupContext(params: {
    groupId: string;
    senderId: string;
    senderName?: string;
    body: string;
    timestamp: number;
  }): void {
    const current = this.pendingGroupContext.get(params.groupId) ?? [];
    current.push({
      senderId: params.senderId,
      senderName: params.senderName,
      body: params.body,
      timestamp: params.timestamp,
    });
    while (current.length > GROUP_CONTEXT_MAX_MESSAGES) {
      current.shift();
    }
    let totalChars = current.reduce((acc, item) => acc + item.body.length, 0);
    while (current.length > 0 && totalChars > GROUP_CONTEXT_MAX_CHARS) {
      const removed = current.shift();
      totalChars -= removed?.body.length ?? 0;
    }
    this.pendingGroupContext.set(params.groupId, current);
  }

  private consumePendingGroupContext(groupId: string): string {
    const pending = this.pendingGroupContext.get(groupId) ?? [];
    if (pending.length === 0) {
      return "";
    }
    this.pendingGroupContext.delete(groupId);
    const lines = pending.map((item) => {
      const speaker = item.senderName?.trim() || item.senderId;
      return `[${speaker}] ${item.body}`;
    });
    return `[Group context messages since last trigger]\n${lines.join("\n")}`;
  }

  private async runRouterRequestInGroupQueue(params: {
    groupId: string;
    requestSid: string;
    run: () => Promise<void>;
  }): Promise<void> {
    const groupId = params.groupId.trim();
    if (!groupId) {
      await params.run();
      return;
    }
    let queueEntry = this.routerGroupQueueByGroupId.get(groupId);
    if (!queueEntry) {
      queueEntry = {
        tail: Promise.resolve(),
        pending: 0,
      };
      this.routerGroupQueueByGroupId.set(groupId, queueEntry);
    }
    queueEntry.pending += 1;
    logDebug("router_request group queue enqueue", {
      groupId,
      requestSid: params.requestSid || undefined,
      queueLength: queueEntry.pending,
    });
    const runQueued = async () => {
      logDebug("router_request group queue start", {
        groupId,
        requestSid: params.requestSid || undefined,
        queueLength: queueEntry.pending,
      });
      try {
        await params.run();
      } finally {
        queueEntry.pending = Math.max(0, queueEntry.pending - 1);
        const queueLength = queueEntry.pending;
        if (queueLength === 0 && this.routerGroupQueueByGroupId.get(groupId) === queueEntry) {
          this.routerGroupQueueByGroupId.delete(groupId);
        }
        logDebug("router_request group queue dequeue", {
          groupId,
          requestSid: params.requestSid || undefined,
          queueLength,
        });
      }
    };
    const queued = queueEntry.tail.then(runQueued, runQueued);
    queueEntry.tail = queued.catch(() => undefined);
    await queued;
  }

  bindRuntimeStatus(params: {
    accountId: string;
    update: (next: Record<string, unknown> & { accountId?: string }) => void;
  }): void {
    this.runtimeAccountId = params.accountId;
    this.runtimeStatusUpdater = params.update;
  }

  clearRuntimeStatus(accountId?: string): void {
    if (accountId && this.runtimeAccountId && this.runtimeAccountId !== accountId) {
      return;
    }
    this.runtimeAccountId = null;
    this.runtimeStatusUpdater = null;
  }

  private updateRuntimeStatus(next: Record<string, unknown>): void {
    if (!this.runtimeStatusUpdater) {
      return;
    }
    this.runtimeStatusUpdater({
      accountId: this.runtimeAccountId ?? undefined,
      ...next,
    });
  }

  private async applyOpenClawConfigPatch(rawPatch: string): Promise<void> {
    const patchBytes = Buffer.byteLength(rawPatch, "utf8");
    const digest = createHash("sha1").update(rawPatch).digest("hex").slice(0, 16);
    logDebug("apply config patch requested", { patchBytes, digest });

    const work = async (): Promise<void> => {
      const now = Date.now();
      for (const [key, ts] of this.recentConfigPatchByDigest.entries()) {
        if (now - ts > CONFIG_PATCH_DEDUPE_TTL_MS) {
          this.recentConfigPatchByDigest.delete(key);
        }
      }
      if (this.recentConfigPatchByDigest.has(digest)) {
        logDebug("skip duplicated config patch in short window", { patchBytes, digest });
        return;
      }

      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= CONFIG_PATCH_RETRY_MAX; attempt += 1) {
        try {
          const getResult = await runGatewayCall("config.get", {});
          logDebug("config.get result summary", {
            attempt,
            resultType: Array.isArray(getResult) ? "array" : typeof getResult,
            rootKeys:
              getResult && typeof getResult === "object" && !Array.isArray(getResult)
                ? Object.keys(getResult as Record<string, unknown>).slice(0, 20)
                : [],
            hashCandidates: collectHashCandidates(getResult),
          });
          const baseHash = findBaseHash(getResult);
          if (!baseHash) {
            if (typeof getResult === "string") {
              const cleaned = stripAnsi(getResult);
              const hashLines = cleaned
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter((line) => /hash/i.test(line))
                .slice(0, 8)
                .map((line) => line.slice(0, 220));
              logWarn("config.get string output debug", {
                attempt,
                textBytes: Buffer.byteLength(getResult, "utf8"),
                hasHashToken: /hash/i.test(cleaned),
                hashLines,
              });
            }
            throw new Error("Failed to read baseHash from config.get output.");
          }
          logDebug("resolved baseHash for config.patch", {
            attempt,
            baseHashPreview: baseHash.slice(0, 12),
            baseHashLength: baseHash.length,
          });
          await runGatewayCall("config.patch", {
            raw: rawPatch,
            baseHash,
          });
          this.recentConfigPatchByDigest.set(digest, Date.now());
          logDebug("config.patch call finished", { attempt, digest });
          return;
        } catch (err) {
          lastErr = err;
          if (attempt < CONFIG_PATCH_RETRY_MAX && isConfigChangedSinceLastLoadError(err)) {
            logWarn("config.patch baseHash conflict; retrying", {
              attempt,
              maxAttempts: CONFIG_PATCH_RETRY_MAX,
              digest,
            });
            continue;
          }
          throw err;
        }
      }
      throw lastErr;
    };

    const queued = this.configPatchQueue.then(work, work);
    this.configPatchQueue = queued.catch(() => undefined);
    await queued;
  }

  private resolveUserPath(input: string): string {
    const trimmed = input.trim();
    if (!trimmed) {
      return "";
    }
    if (trimmed === "~") {
      return os.homedir();
    }
    if (trimmed.startsWith("~/")) {
      return path.join(os.homedir(), trimmed.slice(2));
    }
    return path.resolve(trimmed);
  }

  private resolveStateDir(): string {
    return path.join(os.homedir(), ".openclaw");
  }

  private resolveDefaultAgentWorkspaceDir(): string {
    return path.join(os.homedir(), ".openclaw", "workspace");
  }

  private listAgentEntries(cfg: OpenClawConfig): Array<Record<string, unknown>> {
    const agents = asPlainObject(cfg?.agents);
    const list = agents?.list;
    if (!Array.isArray(list)) {
      return [];
    }
    return list
      .map((entry) => asPlainObject(entry))
      .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  }

  private resolveDefaultAgentId(cfg: OpenClawConfig): string {
    const agents = this.listAgentEntries(cfg);
    if (agents.length === 0) {
      return DEFAULT_AGENT_ID;
    }
    const explicitDefault =
      agents.find((entry) => entry.default === true) ?? agents[0] ?? null;
    const id = typeof explicitDefault?.id === "string" ? explicitDefault.id.trim() : "";
    return id || DEFAULT_AGENT_ID;
  }

  private resolveAgentWorkspaceDir(cfg: OpenClawConfig, agentId: string): string {
    const normalizedAgentId = agentId.trim() || DEFAULT_AGENT_ID;
    const agents = asPlainObject(cfg?.agents);
    const agentEntries = this.listAgentEntries(cfg);
    const matchingAgent =
      agentEntries.find((entry) => {
        const entryId = typeof entry.id === "string" ? entry.id.trim() : "";
        return entryId === normalizedAgentId;
      }) ?? null;
    const explicitWorkspace =
      typeof matchingAgent?.workspace === "string" ? matchingAgent.workspace.trim() : "";
    if (explicitWorkspace) {
      return this.resolveUserPath(explicitWorkspace);
    }
    const defaults = asPlainObject(agents?.defaults);
    const fallbackWorkspace =
      typeof defaults?.workspace === "string" ? defaults.workspace.trim() : "";
    const defaultAgentId = this.resolveDefaultAgentId(cfg);
    if (normalizedAgentId === defaultAgentId) {
      return fallbackWorkspace
        ? this.resolveUserPath(fallbackWorkspace)
        : this.resolveDefaultAgentWorkspaceDir();
    }
    if (fallbackWorkspace) {
      return path.join(this.resolveUserPath(fallbackWorkspace), normalizedAgentId);
    }
    return path.join(this.resolveStateDir(), `workspace-${normalizedAgentId}`);
  }

  private resolveManagedAgentsLocation(cfg: OpenClawConfig): {
    managedDir: string;
    managedFile: string;
    injectionPath: string;
  } {
    const defaultAgentId = this.resolveDefaultAgentId(cfg);
    const workspaceDir = this.resolveAgentWorkspaceDir(cfg, defaultAgentId);
    return {
      managedDir: path.join(workspaceDir, CLAWCHAT_MANAGED_DIR),
      managedFile: path.join(workspaceDir, CLAWCHAT_MANAGED_AGENTS_PATH),
      injectionPath: CLAWCHAT_MANAGED_AGENTS_PATH,
    };
  }

  private buildManagedAgentsContent(params: {
    chatbotId: string;
    chatbotName: string;
    prompt: string;
  }): string {
    const title = params.chatbotName || params.chatbotId || "unknown-chatbot";
    const body =
      params.prompt.trim().length > 0
        ? params.prompt
        : "No synced system preset prompt. Previous synced content has been cleared.";
    return [
      "# AGENTS.md",
      "",
      "This file is managed by the ClawChat plugin for OpenClaw prompt injection.",
      "",
      `Chatbot ID: ${params.chatbotId || "unknown"}`,
      `Chatbot Name: ${title}`,
      "",
      "## Synced System Preset Prompt",
      "",
      body,
      "",
    ].join("\n");
  }

  private ensureManagedAgentsFile(params: {
    cfg: OpenClawConfig;
    chatbotId: string;
    chatbotName: string;
    prompt: string;
  }): void {
    const location = this.resolveManagedAgentsLocation(params.cfg);
    const content = this.buildManagedAgentsContent({
      chatbotId: params.chatbotId,
      chatbotName: params.chatbotName,
      prompt: params.prompt,
    });
    mkdirSync(location.managedDir, { recursive: true });
    writeFileSync(location.managedFile, content, "utf8");
    logDebug("managed AGENTS.md updated", {
      chatbotId: params.chatbotId,
      chatbotName: params.chatbotName,
      managedFile: location.managedFile,
      injectionPath: location.injectionPath,
      promptBytes: Buffer.byteLength(params.prompt, "utf8"),
    });
  }

  private async ensureBootstrapExtraFilesConfigured(cfg: OpenClawConfig): Promise<void> {
    const { injectionPath } = this.resolveManagedAgentsLocation(cfg);
    const getResult = await runGatewayCall("config.get", {});
    const root = asPlainObject(getResult);
    if (!root) {
      throw new Error("config.get did not return an object");
    }
    const hooks = asPlainObject(root.hooks) ?? {};
    const internal = asPlainObject(hooks.internal) ?? {};
    const entries = asPlainObject(internal.entries) ?? {};
    const bootstrapEntry = asPlainObject(entries["bootstrap-extra-files"]) ?? {};
    const existingPathsRaw =
      Array.isArray(bootstrapEntry.paths)
        ? bootstrapEntry.paths
        : Array.isArray(bootstrapEntry.patterns)
          ? bootstrapEntry.patterns
          : Array.isArray(bootstrapEntry.files)
            ? bootstrapEntry.files
            : [];
    const existingPaths = existingPathsRaw
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);
    const nextPaths = existingPaths.includes(injectionPath)
      ? existingPaths
      : [...existingPaths, injectionPath];
    const hooksEnabled = internal.enabled === true;
    const bootstrapEnabled = bootstrapEntry.enabled === true;
    const alreadyConfigured =
      hooksEnabled &&
      bootstrapEnabled &&
      existingPaths.includes(injectionPath) &&
      Array.isArray(bootstrapEntry.paths);
    if (alreadyConfigured) {
      return;
    }
    const rawPatch = JSON.stringify({
      hooks: {
        internal: {
          enabled: true,
          entries: {
            "bootstrap-extra-files": {
              ...bootstrapEntry,
              enabled: true,
              paths: nextPaths,
            },
          },
        },
      },
    });
    await this.applyOpenClawConfigPatch(rawPatch);
    logDebug("bootstrap-extra-files ensured for managed AGENTS.md", {
      path: injectionPath,
      pathsCount: nextPaths.length,
    });
  }

  private async handlePresetPromptSync(params: {
    cfg: OpenClawConfig;
    chatbotId: string;
    chatbotName: string;
    prompt: string;
  }): Promise<void> {
    this.ensureManagedAgentsFile(params);
    await this.ensureBootstrapExtraFilesConfigured(params.cfg);
  }

  private currentConfigKey(account: ResolvedClawchatAccount): string {
    return `${account.appId}::${account.username}::${account.password}`;
  }

  private async createClient(account: ResolvedClawchatAccount): Promise<ClawchatImClient> {
    const flooFactory = loadFlooFactory();
    const im = flooFactory({
      appid: account.appId,
      ws: true,
      autoLogin: false,
      logLevel: "off",
    });
    logDebug("im client created", { appId: `${account.appId.slice(0, 4)}***` });
    return im;
  }

  private bindListeners(account: ResolvedClawchatAccount): void {
    if (!this.client || this.listenersBound) {
      return;
    }
    this.listenersBound = true;
    logDebug("binding inbound listeners");
    const onDirect = (name: string, event: unknown) => {
      const eventAny = (event ?? {}) as Record<string, unknown>;
      const meta = (eventAny.meta ?? eventAny) as Record<string, unknown>;
      if (!isHistoryEvent(eventAny, meta)) {
        logDebug(`inbound event: ${name}`, event);
      }
      void this.onInbound(event as ClawchatInboundEvent, "direct", account, name);
    };
    const onGroup = (name: string, event: unknown) => {
      logDebug(`inbound event: ${name}`, event);
      void this.onInbound(event as ClawchatInboundEvent, "group", account, name);
    };

    // Subscribe only to documented public events from floo-web types.
    this.client.listen({
      onRosterMessage: (event: unknown) => onDirect("onRosterMessage", event),
      onRosterMessageContentAppend: (event: unknown) =>
        onDirect("onRosterMessageContentAppend", event),
      onRosterMessageReplace: (event: unknown) => onDirect("onRosterMessageReplace", event),
      onRosterRTCMessage: (event: unknown) => onDirect("onRosterRTCMessage", event),
      onGroupMessage: (event: unknown) => onGroup("onGroupMessage", event),
      onGroupMessageContentAppend: (event: unknown) =>
        onGroup("onGroupMessageContentAppend", event),
      onGroupMessageReplace: (event: unknown) => onGroup("onGroupMessageReplace", event),
      onMentionMessage: (event: unknown) => logDebug("onMentionMessage event ignored", event),
      onReceiveHistoryMsg: (event: unknown) => logDebug("onReceiveHistoryMsg event", event),
      onMessageStatusChanged: (event: unknown) => logDebug("onMessageStatusChanged event", event),
      onSendingMessageStatusChanged: (event: unknown) => {
        logDebug("onSendingMessageStatusChanged event", event);
        this.updateSelfIdFromClient("sending status event");
      },
      onUnreadChange: (event: unknown) => logDebug("onUnreadChange event", event),
      onRosterListUpdate: (event: unknown) => logDebug("onRosterListUpdate event", event),
      onGroupListUpdate: (event: unknown) => logDebug("onGroupListUpdate event", event),
      onGroupMemberChanged: (event: unknown) => logDebug("onGroupMemberChanged event", event),
      loginSuccess: (event: unknown) => {
        this.loginSuccessSeen = true;
        this.updateSelfIdFromClient("loginSuccess event");
        void this.sendLoginMarkerToSelf();
        logDebug("loginSuccess event", event);
      },
      loginMessage: (event: unknown) => logDebug("loginMessage event", event),
      loginFail: (event: unknown) => {
        this.loginSuccessSeen = false;
        this.socketConnectedSeen = false;
        logWarn("loginFail event", event);
        this.updateRuntimeStatus({
          running: true,
          connected: false,
          lastError: "loginFail",
          lastDisconnect: { at: Date.now(), error: "loginFail" },
        });
      },
      messageNormal: (event: unknown) => logDebug("messageNormal event", event),
      flooNotice: (event: unknown) => {
        logDebug("flooNotice event", event);
      },
      flooError: (event: unknown) => {
        logWarn("flooError event", event);
        this.socketConnectedSeen = false;
        this.updateRuntimeStatus({
          running: true,
          connected: false,
          lastError: "flooError",
          lastDisconnect: { at: Date.now(), error: "flooError" },
        });
      },
      fireplaceError: (event: unknown) => {
        logWarn("fireplaceError event", event);
        this.socketConnectedSeen = false;
        this.updateRuntimeStatus({
          running: true,
          connected: false,
          lastError: "fireplaceError",
          lastDisconnect: { at: Date.now(), error: "fireplaceError" },
        });
        this.scheduleReconnect("fireplaceError", { forceRecreate: true });
      },
      reconnect: (event: unknown) => {
        logWarn("reconnect event", event);
        this.socketConnectedSeen = false;
        this.updateRuntimeStatus({
          running: true,
          connected: false,
          lastError: "reconnect",
          lastDisconnect: { at: Date.now(), error: "reconnect" },
        });
      },
      disconnected: (event: unknown) => {
        logWarn("disconnected", event);
        this.socketConnectedSeen = false;
        this.updateRuntimeStatus({
          running: true,
          connected: false,
          lastDisconnect: { at: Date.now(), error: "disconnected" },
        });
      },
      connected: (event: unknown) => {
        logDebug("connected", event);
        this.socketConnectedSeen = true;
        this.updateRuntimeStatus({
          running: true,
          connected: true,
          reconnectAttempts: 0,
          lastConnectedAt: Date.now(),
          lastError: null,
        });
        this.resetReconnectState("connected");
      },
      auth: (event: unknown) => {
        logDebug("auth event", event);
      },
      message: (event: unknown) => {
        logDebug("generic message event", event);
      },
    });
  }

  private resetReconnectState(reason: string): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    this.reconnectForceRecreate = false;
    this.reconnectPromise = null;
    logDebug("reconnect state reset", { reason });
  }

  private scheduleReconnect(trigger: string, options?: { forceRecreate?: boolean }): void {
    if (this.shuttingDown) {
      logDebug("skip reconnect: session is shutting down", { trigger });
      return;
    }
    if (!this.client) {
      logDebug("skip reconnect: client missing", { trigger });
      return;
    }
    if (!this.lastConfig || !this.lastConfig.enabled || !this.lastConfig.configured) {
      logWarn("skip reconnect: account config unavailable", { trigger });
      return;
    }
    if (this.loginPromise || this.reconnectPromise) {
      logDebug("skip reconnect: login/reconnect in progress", { trigger });
      return;
    }
    if (this.client.isLogin?.()) {
      logDebug("skip reconnect: already logged in", { trigger });
      this.resetReconnectState("already_logged_in");
      return;
    }
    if (this.reconnectTimer) {
      logDebug("skip reconnect: timer already scheduled", { trigger });
      return;
    }

    this.reconnectForceRecreate = this.reconnectForceRecreate || Boolean(options?.forceRecreate);

    const exp = Math.min(this.reconnectAttempts, 6);
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** exp);
    this.reconnectAttempts += 1;
    logWarn("schedule reconnect", {
      trigger,
      attempt: this.reconnectAttempts,
      delayMs: delay,
    });
    this.updateRuntimeStatus({
      running: true,
      connected: false,
      reconnectAttempts: this.reconnectAttempts,
      lastDisconnect: { at: Date.now(), error: trigger },
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      const run = (async () => {
        const cfg = this.lastConfig;
        if (!cfg || this.shuttingDown) {
          return;
        }
        try {
          logWarn("reconnect attempt start", {
            attempt: this.reconnectAttempts,
            username: cfg.username,
          });
          if (this.reconnectForceRecreate) {
            logWarn("reconnect attempt will recreate sdk session", {
              attempt: this.reconnectAttempts,
              username: cfg.username,
            });
            await this.shutdown();
            this.shuttingDown = false;
          }
          await this.ensureReady(cfg);
          logWarn("reconnect attempt success", {
            attempt: this.reconnectAttempts,
            username: cfg.username,
          });
          this.updateRuntimeStatus({
            running: true,
            connected: true,
            reconnectAttempts: 0,
            lastConnectedAt: Date.now(),
            lastError: null,
          });
          this.resetReconnectState("reconnect_success");
        } catch (err) {
          logError("reconnect attempt failed", err);
          this.updateRuntimeStatus({
            running: true,
            connected: false,
            reconnectAttempts: this.reconnectAttempts,
            lastError: err instanceof Error ? err.message : String(err),
            lastDisconnect: {
              at: Date.now(),
              error: err instanceof Error ? err.message : String(err),
            },
          });
          this.reconnectPromise = null;
          this.scheduleReconnect("reconnect_failed");
        }
      })();
      this.reconnectPromise = run;
      void run.finally(() => {
        if (this.reconnectPromise === run) {
          this.reconnectPromise = null;
        }
      });
    }, delay);
  }

  private async sendRouterReplyToSelf(message: Record<string, unknown>): Promise<void> {
    if (!this.client || !this.selfId) {
      logWarn("skip router_reply: client or selfId unavailable", {
        hasClient: Boolean(this.client),
        hasSelfId: Boolean(this.selfId),
      });
      return;
    }
    await this.client.sysManage.sendRosterMessage({
      type: "command",
      uid: this.selfId,
      content: "",
      ext: JSON.stringify({
        openclaw: {
          type: "router_reply",
          message,
        },
        ai: {
          role: "ai",
        },
      }),
    });
  }

  private async handleRouterRequest(
    routerMessage: Record<string, unknown>,
    account: ResolvedClawchatAccount,
    knowledge = "",
    replyTargetSnapshot?: RouterReplyTargetSnapshot,
  ): Promise<void> {
    if (!replyTargetSnapshot) {
      logError("skip router_request: reply target snapshot missing", {
        keys: Object.keys(routerMessage),
      });
      return;
    }
    const body = extractText(routerMessage as ClawchatInboundEvent);
    if (!body.trim()) {
      logWarn("skip router_request: message.content is empty", {
        keys: Object.keys(routerMessage),
      });
      return;
    }
    const fromId =
      pickId(routerMessage.from) ||
      pickId((routerMessage as { sender_id?: unknown }).sender_id) ||
      this.selfId;
    const toId =
      pickId(routerMessage.to) ||
      pickId((routerMessage as { uid?: unknown }).uid) ||
      this.selfId;
    const messageSid =
      pickId(routerMessage.id) || pickId((routerMessage as { message_id?: unknown }).message_id);
    const timestampNum = Number(
      (routerMessage as { timestamp?: unknown }).timestamp ??
        (routerMessage as { ts?: unknown }).ts ??
        Date.now(),
    );
    const routerRelayMark = true;
    const runtime = getClawchatRuntime();
    const cfg = await runtime.config.loadConfig();
    const routerMeta = routerMessage as Record<string, unknown>;
    const toUserNickname = resolveToUserNicknameFromConfig(routerMeta, routerMeta);
    const cleanedBody = removeOpenclawEdgeMention(body, toUserNickname);
    const trimmedBody = cleanedBody.trim();
    const isSlashCommand = trimmedBody.startsWith("/");
    const bodyWithKnowledge =
      knowledge.trim().length > 0
        ? ["[Retrieved knowledge context]", knowledge.trim(), "[End knowledge context]", "", cleanedBody].join("\n")
        : cleanedBody;
    let replySeq = 0;
    let deliveredCount = 0;
    const replyFrom = this.selfId || toId || fromId;
    const replyTo = replyTargetSnapshot.replyId;
    const replyToType = replyTargetSnapshot.replyKind === "group" ? "group" : "roster";
    const dispatchTo = replyTargetSnapshot.replyKind === "group" ? replyTo : toId || this.selfId;
    const sessionKey =
      replyTargetSnapshot.replyKind === "group"
        ? `router:group:${replyTo}`
        : `router:direct:${fromId || toId || this.selfId || CLAWCHAT_CHANNEL_ID}`;
    logDebug("router_request target resolved", {
      requestSid: replyTargetSnapshot.requestSid,
      replyKind: replyTargetSnapshot.replyKind,
      replyId: replyTo,
      resolvedBy: "snapshot",
      fromId: fromId || undefined,
      toId: toId || undefined,
    });

    const result = await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: {
        Body: bodyWithKnowledge,
        BodyForAgent: bodyWithKnowledge,
        CommandBody: cleanedBody,
        BodyForCommands: cleanedBody,
        CommandAuthorized: isSlashCommand,
        From: fromId || toId || this.selfId,
        To: dispatchTo,
        SessionKey: sessionKey,
        RouterRelay: routerRelayMark,
        AccountId: account.accountId,
        MessageSid: messageSid || undefined,
        Timestamp: Number.isFinite(timestampNum) ? timestampNum : Date.now(),
        OriginatingChannel: CLAWCHAT_CHANNEL_ID as any,
        OriginatingTo: replyTo,
        ChatType: replyTargetSnapshot.replyKind === "group" ? "group" : "direct",
        Provider: CLAWCHAT_CHANNEL_ID,
        Surface: CLAWCHAT_CHANNEL_ID,
        SenderId: fromId || undefined,
        SenderName: fromId || undefined,
      },
      cfg,
      dispatcherOptions: {
        deliver: async (payload: { text?: string; body?: string }) => {
          const response = (payload?.text ?? payload?.body ?? "").trim();
          if (!response) {
            return;
          }
          replySeq += 1;
          const now = Date.now();
          const replyMessage: Record<string, unknown> = {
            id: `router_reply_${now}_${replySeq}`,
            from: replyFrom,
            to: replyTo,
            content: response,
            type: "text",
            ext: "",
            config: "",
            attach: "",
            status: 1,
            timestamp: String(now),
            toType: replyToType,
          };
          await this.sendRouterReplyToSelf(replyMessage);
          deliveredCount += 1;
        },
        onError: (err: unknown, info: { kind: "tool" | "block" | "final" }) => {
          logError(`router_request dispatcher failed (kind=${info.kind})`, err);
        },
        onSkip: (
          payload: { text?: string; body?: string },
          info: { kind: "tool" | "block" | "final"; reason: string },
        ) => {
          logDebug(
            `router_request dispatcher skipped payload (kind=${info.kind}, reason=${info.reason})`,
            {
              textPreview: (payload.text ?? payload.body ?? "").slice(0, 80),
            },
          );
        },
      },
    });
    logDebug("router_request dispatcher result", result);
    if (deliveredCount === 0) {
      logDebug("router_request produced empty replies; no router_reply sent");
      return;
    }
    logDebug("router_reply stream sent for router_request", {
      requestSid: replyTargetSnapshot.requestSid,
      requestFrom: fromId || undefined,
      replyTo: this.selfId,
      deliveredCount,
    });
  }

  private async onInbound(
    event: ClawchatInboundEvent,
    mode: "direct" | "group",
    account: ResolvedClawchatAccount,
    eventName?: string,
  ): Promise<void> {
    try {
      const eventAny = event as Record<string, unknown>;
      const meta = (eventAny.meta ?? eventAny) as Record<string, unknown>;
      const isHistory = isHistoryEvent(eventAny, meta);
      if (isHistory) {
        logDebug("skip history inbound event", {
          mode,
          id: pickId(eventAny.id ?? meta.id),
        });
        return;
      }
      const senderId =
        pickId(event.from) ||
        pickId(event.sender_id) ||
        pickId((event as { sender?: unknown }).sender) ||
        pickId((event as { uid?: unknown }).uid) ||
        pickId(meta.from);
      const toIdRaw =
        pickId(event.to) ||
        pickId((event as { to_id?: unknown }).to_id) ||
        pickId(meta.to) ||
        pickId(meta.uid) ||
        pickId(meta.xid);
      const groupId = parseGroupId(eventAny, meta, event);
      const directPeer =
        pickId(event.from) ||
        pickId((event as { to_id?: unknown }).to_id) ||
        pickId((event as { xid?: unknown }).xid) ||
        toIdRaw;
      const targetId = mode === "group" ? groupId : directPeer;
      if (!targetId) {
        logWarn("inbound message missing target id", {
          mode,
          eventName,
          senderId,
          toId: toIdRaw,
          groupId,
          event,
        });
        return;
      }
      this.updateSelfIdFromClient("inbound event");
      const configPatchRaw = extractConfigPatchRaw(eventAny, meta);
      const presetPromptSync = extractPresetPromptSync(eventAny, meta);
      const routerSignal = extractRouterSignal(eventAny, meta);
      if (mode === "direct" && senderId && toIdRaw && senderId === toIdRaw) {
        const isSelfLoopback = Boolean(this.selfId && senderId === this.selfId);
        if (isSelfLoopback && account.allowManage && configPatchRaw) {
          try {
            await this.sendConfigPatchMarkerToSelf({
              stage: "before",
              rawPatch: configPatchRaw,
            });
            await this.applyOpenClawConfigPatch(configPatchRaw);
            await this.sendConfigPatchMarkerToSelf({
              stage: "after",
              rawPatch: configPatchRaw,
            });
            logDebug("applied config patch from self loopback message", {
              senderId,
              toId: toIdRaw,
              patchBytes: Buffer.byteLength(configPatchRaw, "utf8"),
            });
          } catch (err) {
            logError("failed to apply config patch from self loopback message", {
              err,
              senderId,
              toId: toIdRaw,
              selfId: this.selfId,
              allowManage: account.allowManage,
              hasConfigPatch: Boolean(configPatchRaw),
              patchBytes: Buffer.byteLength(configPatchRaw, "utf8"),
            });
          }
          return;
        }
        if (isSelfLoopback && account.allowManage && presetPromptSync) {
          if (!isCommandOuterMessage(eventAny, meta)) {
            logDebug("skip loopback preset_prompt_sync: outer type is not command", {
              senderId,
              toId: toIdRaw,
              selfId: this.selfId,
            });
            return;
          }
          try {
            const cfg = await getClawchatRuntime().config.loadConfig();
            await this.sendPresetPromptSyncMarkerToSelf({
              stage: "before",
              chatbotId: presetPromptSync.chatbotId,
              chatbotName: presetPromptSync.chatbotName,
              prompt: presetPromptSync.prompt,
            });
            await this.handlePresetPromptSync({
              cfg,
              chatbotId: presetPromptSync.chatbotId,
              chatbotName: presetPromptSync.chatbotName,
              prompt: presetPromptSync.prompt,
            });
            await this.sendPresetPromptSyncMarkerToSelf({
              stage: "after",
              chatbotId: presetPromptSync.chatbotId,
              chatbotName: presetPromptSync.chatbotName,
              prompt: presetPromptSync.prompt,
            });
            logDebug("processed preset_prompt_sync from self loopback message", {
              senderId,
              toId: toIdRaw,
              chatbotId: presetPromptSync.chatbotId,
              promptBytes: Buffer.byteLength(presetPromptSync.prompt, "utf8"),
            });
          } catch (err) {
            logError("failed to process preset_prompt_sync from self loopback message", {
              err,
              senderId,
              toId: toIdRaw,
              selfId: this.selfId,
              chatbotId: presetPromptSync.chatbotId,
              promptBytes: Buffer.byteLength(presetPromptSync.prompt, "utf8"),
            });
          }
          return;
        }
        if (routerSignal?.type === "router_reply") {
          logDebug("skip loopback router_reply", {
            senderId,
            toId: toIdRaw,
            selfId: this.selfId,
          });
          return;
        }
        if (isSelfLoopback && account.allowManage && routerSignal?.type === "router_request") {
          if (!isCommandOuterMessage(eventAny, meta)) {
            logDebug("skip loopback router_request: outer type is not command", {
              senderId,
              toId: toIdRaw,
              selfId: this.selfId,
            });
            return;
          }
          logDebug("processing loopback router_request", {
            senderId,
            toId: toIdRaw,
            selfId: this.selfId,
            knowledgeBytes: Buffer.byteLength(routerSignal.knowledge ?? "", "utf8"),
          });
          const replyTargetSnapshot = resolveRouterReplyTargetSnapshot(routerSignal.message);
          if (!replyTargetSnapshot) {
            logError("skip router_request: failed to resolve reply target snapshot", {
              outerEventId: pickId(eventAny.id ?? meta.id) || undefined,
              routerMessageKeys: Object.keys(routerSignal.message),
            });
            return;
          }
          if (replyTargetSnapshot.replyKind === "group") {
            await this.runRouterRequestInGroupQueue({
              groupId: replyTargetSnapshot.replyId,
              requestSid: replyTargetSnapshot.requestSid,
              run: () =>
                this.handleRouterRequest(
                  routerSignal.message,
                  account,
                  routerSignal.knowledge,
                  replyTargetSnapshot,
                ),
            });
            return;
          }
          await this.handleRouterRequest(
            routerSignal.message,
            account,
            routerSignal.knowledge,
            replyTargetSnapshot,
          );
          return;
        }
        logDebug("skip loopback message (from === to)", {
          senderId,
          toId: toIdRaw,
          selfId: this.selfId,
          allowManage: account.allowManage,
          hasConfigPatch: Boolean(configPatchRaw),
          hasPresetPromptSync: Boolean(presetPromptSync),
          routerSignalType: routerSignal?.type ?? "",
        });
        return;
      }
      if (senderId && this.selfId && senderId === this.selfId) {
        logDebug("skip self/multi-device sync message", {
          senderId,
          toId: toIdRaw,
          targetId,
          mode,
        });
        return;
      }

      const body = extractText(event);
      if (!body) {
        logDebug("skip empty inbound", { mode, eventType: event.type });
        return;
      }
      const toUserNickname = resolveToUserNicknameFromConfig(eventAny, meta);
      const cleanedBody = removeOpenclawEdgeMention(body, toUserNickname);
      const isSlashCommand = cleanedBody.startsWith("/");
      const timestampNum = Number(
        eventAny.timestamp ?? meta.timestamp ?? (eventAny as { ts?: unknown }).ts ?? Date.now(),
      );

      if (mode === "group") {
        if (!isGroupAllowedByPolicy(account, groupId)) {
          logDebug("skip group inbound by groupPolicy", {
            groupPolicy: account.groupPolicy,
            groupId,
            eventName,
          });
          return;
        }
        if (!senderId) {
          logWarn("skip group inbound: sender id missing", {
            groupId,
            eventName,
          });
          return;
        }
        if (!isGroupSenderAllowed(account, groupId, senderId)) {
          logDebug("skip group inbound: sender not allowed", {
            groupId,
            senderId,
            eventName,
          });
          return;
        }
        const requireMention = resolveGroupRequireMention(account, groupId);
        if (
          !hasMentionHint(body, this.selfId, account.username, eventAny, meta, eventName) &&
          requireMention
        ) {
          this.appendPendingGroupContext({
            groupId,
            senderId,
            senderName: resolveSenderNameFromConfig(eventAny, meta) || undefined,
            body: cleanedBody,
            timestamp: Number.isFinite(timestampNum) ? timestampNum : Date.now(),
          });
          logDebug("skip group inbound: mention required", {
            groupId,
            senderId,
            eventName,
            requireMention,
            queuedAsContext: true,
          });
          return;
        }
      }

      logDebug("inbound message", {
        mode,
        eventName,
        groupId: mode === "group" ? groupId : undefined,
        senderId,
        toId: toIdRaw,
        targetId,
        bodyPreview: cleanedBody.slice(0, 80),
        keys: Object.keys(meta),
      });

      const runtime = getClawchatRuntime();
      const cfg = await runtime.config.loadConfig();
      const messageSid =
        pickId(eventAny.id ?? meta.id) ||
        pickId((eventAny as { message_id?: unknown }).message_id) ||
        "";
      const inboundMid =
        pickId(eventAny.id ?? meta.id) ||
        pickId((eventAny as { message_id?: unknown }).message_id) ||
        pickId((eventAny as { mid?: unknown }).mid) ||
        pickId((eventAny as { message?: unknown }).message);
      const senderUid = pickNumberId(senderId);
      if (
        mode === "direct" &&
        senderId &&
        toIdRaw &&
        senderId !== toIdRaw &&
        senderId !== this.selfId &&
        senderUid !== null &&
        inboundMid
      ) {
        try {
          const readResult = this.client?.rosterManage?.readRosterMessage(senderUid, inboundMid);
          await Promise.resolve(readResult);
          logDebug("marked inbound direct message as read", {
            senderUid,
            mid: inboundMid,
            senderId,
            toId: toIdRaw,
          });
        } catch (err) {
          logWarn("failed to mark inbound direct message as read", {
            err,
            senderUid,
            mid: inboundMid ?? undefined,
            senderId,
            toId: toIdRaw,
          });
        }
      }
      let bodyToDispatch = cleanedBody;
      if (mode === "group") {
        const pendingContext = this.consumePendingGroupContext(groupId);
        if (pendingContext && !isSlashCommand) {
          bodyToDispatch = `${pendingContext}\n\n[Current message]\n${cleanedBody}`;
          const contextBytes = Buffer.byteLength(pendingContext, "utf8");
          const contextPreview = Buffer.from(pendingContext, "utf8").subarray(0, 4096).toString("utf8");
          logDebug("group pending context attached", {
            groupId,
            contextBytes,
            contextPreview,
            contextPreviewTruncated: contextBytes > 4096,
          });
        }
      }
      const dispatchTo = mode === "group" ? groupId : toIdRaw || account.username;
      const sessionKey = mode === "group" ? `group:${groupId}` : targetId;
      const outboundTarget: ClawchatMessageTarget =
        mode === "group"
          ? {
              kind: "group",
              id: groupId,
            }
          : {
              kind: "user",
              id: targetId,
            };

      const result = await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: {
          Body: bodyToDispatch,
          BodyForCommands: cleanedBody,
          CommandBody: cleanedBody,
          CommandAuthorized: isSlashCommand,
          From: senderId || targetId,
          To: dispatchTo,
          SessionKey: sessionKey,
          AccountId: account.accountId,
          MessageSid: messageSid || undefined,
          Timestamp: Number.isFinite(timestampNum) ? timestampNum : Date.now(),
          OriginatingChannel: CLAWCHAT_CHANNEL_ID as any,
          OriginatingTo: mode === "group" ? groupId : targetId,
          ChatType: mode,
          Provider: CLAWCHAT_CHANNEL_ID,
          Surface: CLAWCHAT_CHANNEL_ID,
          SenderId: senderId || undefined,
          SenderName: senderId || undefined,
        },
        cfg,
        dispatcherOptions: {
          deliver: async (payload: { text?: string; body?: string }) => {
            const response = payload?.text ?? payload?.body ?? "";
            if (!response.trim()) {
              return;
            }
            await this.sendText(outboundTarget, response, account);
          },
          onError: (err: unknown, info: { kind: "tool" | "block" | "final" }) => {
            logError(`reply dispatcher send failed (kind=${info.kind})`, err);
          },
          onSkip: (
            payload: { text?: string; body?: string },
            info: { kind: "tool" | "block" | "final"; reason: string },
          ) => {
            logDebug(`reply dispatcher skipped payload (kind=${info.kind}, reason=${info.reason})`, {
              textPreview: (payload.text ?? payload.body ?? "").slice(0, 80),
            });
          },
        },
      });
      logDebug("reply dispatcher result", result);
    } catch (err) {
      logError("failed to process inbound message", err);
    }
  }

  async ensureReady(account: ResolvedClawchatAccount): Promise<void> {
    if (this.ensureReadyInFlight) {
      try {
        await this.ensureReadyInFlight;
      } catch {
        // Prior in-flight ensure may fail; continue with current attempt.
      }
    }
    const run = this.ensureReadyOnce(account);
    this.ensureReadyInFlight = run;
    try {
      await run;
    } finally {
      if (this.ensureReadyInFlight === run) {
        this.ensureReadyInFlight = null;
      }
    }
  }

  private async ensureReadyOnce(account: ResolvedClawchatAccount): Promise<void> {
    if (!account.configured) {
      throw new Error("ClawChat account is not configured (enabled/appId/username/password).");
    }

    const nextKey = this.currentConfigKey(account);
    const needNewClient = !this.client || !this.accountKey || this.accountKey !== nextKey;

    if (needNewClient) {
      await this.shutdown();
      this.shuttingDown = false;
      this.client = await this.createClient(account);
      this.onlineMarkerSent = false;
      this.offlineMarkerSent = false;
      this.loginSuccessSeen = false;
      this.socketConnectedSeen = false;
      this.accountKey = nextKey;
      this.lastConfig = account;
      this.bindListeners(account);
    } else if (!this.listenersBound) {
      this.bindListeners(account);
    }

    this.lastConfig = account;
    if (this.client?.isLogin?.()) {
      this.resetReconnectState("already_logged_in_before_ensure");
      return;
    }

    if (this.loginPromise) {
      await this.loginPromise;
      return;
    }

    this.loginPromise = (async () => {
      if (!this.client) {
        throw new Error("ClawChat client not initialized");
      }
      this.loginSuccessSeen = false;
      logDebug("attempting login", { username: account.username });
      await this.client.login({
        name: account.username,
        password: account.password,
      });

      logDebug("login request returned", {
        username: account.username,
      });
      this.updateRuntimeStatus({
        running: true,
        connected: false,
        reconnectAttempts: 0,
        lastError: null,
      });

      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const ready = Boolean(this.client?.isReady?.());
        const loggedIn = Boolean(this.client?.isLogin?.());
        const connected = this.socketConnectedSeen;
        const loginSuccess = this.loginSuccessSeen;
        if (loggedIn && (connected || ready || loginSuccess)) {
          if (!this.socketConnectedSeen && (ready || loginSuccess)) {
            this.socketConnectedSeen = true;
            logDebug("sdk ready without explicit connected event; using fallback readiness", {
              ready,
              loggedIn,
              connected,
              loginSuccess,
            });
          }
          this.updateSelfIdFromClient("login fully ready");
          logDebug("sdk ready", {
            ready,
            loggedIn,
            connected: this.socketConnectedSeen,
            loginSuccess,
          });
          this.updateRuntimeStatus({
            running: true,
            connected: true,
            reconnectAttempts: 0,
            lastConnectedAt: Date.now(),
            lastError: null,
          });
          this.resetReconnectState("login_success");
          return;
        }
        await sleep(READY_POLL_MS);
      }
      throw new Error(
        this.client?.isLogin?.()
          ? "ClawChat SDK login completed but socket did not reach connected state before timeout"
          : "ClawChat SDK not logged in after login timeout",
      );
    })();

    try {
      await this.loginPromise;
    } catch (err) {
      logError("login failed", err);
      this.updateRuntimeStatus({
        running: true,
        connected: false,
        lastError: err instanceof Error ? err.message : String(err),
        lastDisconnect: {
          at: Date.now(),
          error: err instanceof Error ? err.message : String(err),
        },
      });
      this.loginPromise = null;
      throw err;
    } finally {
      this.loginPromise = null;
    }
  }

  private updateSelfIdFromClient(reason: string): void {
    const uid = pickId(this.client?.userManage?.getUid?.());
    if (!uid) {
      return;
    }
    if (uid !== this.selfId) {
      this.selfId = uid;
      logDebug("updated selfId from client userManage.getUid", { reason, selfId: this.selfId });
    }
  }

  private async sendLoginMarkerToSelf(): Promise<void> {
    if (!this.client || !this.selfId || this.onlineMarkerSent) {
      return;
    }
    const client = this.client;
    const selfId = this.selfId;
    try {
      if (this.client !== client) {
        return;
      }
      if (!client?.isLogin?.()) {
        return;
      }
      const runtime = getClawchatRuntime();
      const cfg = (await runtime.config.loadConfig()) as OpenClawConfig & {
        models?: {
          providers?: Record<string, unknown>;
        };
      };
      const providerInited = Boolean(
        (cfg.models?.providers?.clawchat &&
          typeof cfg.models.providers.clawchat === "object" &&
          !Array.isArray(cfg.models.providers.clawchat)) ||
          (cfg.models?.providers?.lanying &&
            typeof cfg.models.providers.lanying === "object" &&
            !Array.isArray(cfg.models.providers.lanying)),
      );
      await client.sysManage.sendRosterMessage({
        type: "text",
        uid: selfId,
        content: "ClawChat 插件已上线",
        ext: JSON.stringify({
          openclaw: {
            type: "online",
            provider_inited: providerInited,
          },
        }),
      });
      this.onlineMarkerSent = true;
      this.offlineMarkerSent = false;
      logDebug("sent login marker message to self", { selfId });
    } catch (err) {
      logWarn("failed to send login marker message to self", {
        err,
        selfId,
      });
    }
  }

  private async sendOfflineMarkerToSelf(): Promise<void> {
    if (!this.client || !this.selfId || this.offlineMarkerSent) {
      return;
    }
    try {
      await this.client.sysManage.sendRosterMessage({
        type: "text",
        uid: this.selfId,
        content: "ClawChat 插件已下线",
        ext: JSON.stringify({ openclaw: { type: "offline" } }),
      });
      this.offlineMarkerSent = true;
      logDebug("sent offline marker message to self", { selfId: this.selfId });
    } catch (err) {
      logWarn("failed to send offline marker message to self", { err, selfId: this.selfId });
    }
  }

  private async sendPresetPromptSyncMarkerToSelf(params: {
    stage: "before" | "after";
    chatbotId: string;
    chatbotName: string;
    prompt: string;
  }): Promise<void> {
    if (!this.client || !this.selfId) {
      return;
    }
    const chatbotLabel = params.chatbotName || params.chatbotId || "unknown-chatbot";
    const content =
      params.stage === "before"
        ? `ClawChat 插件正在更新系统提示词：${chatbotLabel}`
        : `ClawChat 插件已更新系统提示词：${chatbotLabel}`;
    try {
      await this.client.sysManage.sendRosterMessage({
        type: "text",
        uid: this.selfId,
        content,
        ext: JSON.stringify({
          openclaw: {
            type: "preset_prompt_sync_marker",
            stage: params.stage,
            chatbotId: params.chatbotId,
            chatbotName: params.chatbotName,
            promptBytes: Buffer.byteLength(params.prompt, "utf8"),
          },
        }),
      });
      logDebug("sent preset_prompt_sync marker message to self", {
        stage: params.stage,
        selfId: this.selfId,
        chatbotId: params.chatbotId,
      });
    } catch (err) {
      logWarn("failed to send preset_prompt_sync marker message to self", {
        err,
        stage: params.stage,
        selfId: this.selfId,
        chatbotId: params.chatbotId,
      });
    }
  }

  private async sendConfigPatchMarkerToSelf(params: {
    stage: "before" | "after";
    rawPatch: string;
  }): Promise<void> {
    if (!this.client || !this.selfId) {
      return;
    }
    const content =
      params.stage === "before"
        ? "ClawChat 插件正在更新配置"
        : "ClawChat 插件已更新配置";
    try {
      await this.client.sysManage.sendRosterMessage({
        type: "text",
        uid: this.selfId,
        content,
        ext: JSON.stringify({
          openclaw: {
            type: "config_patch_marker",
            stage: params.stage,
            patchBytes: Buffer.byteLength(params.rawPatch, "utf8"),
          },
        }),
      });
      logDebug("sent config_patch marker message to self", {
        stage: params.stage,
        selfId: this.selfId,
        patchBytes: Buffer.byteLength(params.rawPatch, "utf8"),
      });
    } catch (err) {
      logWarn("failed to send config_patch marker message to self", {
        err,
        stage: params.stage,
        selfId: this.selfId,
        patchBytes: Buffer.byteLength(params.rawPatch, "utf8"),
      });
    }
  }

  async sendText(
    target: ClawchatMessageTarget,
    text: string,
    account?: ResolvedClawchatAccount,
  ): Promise<unknown> {
    const cfgToUse = account ?? this.lastConfig;
    if (!cfgToUse) {
      throw new Error("ClawChat session has no account context");
    }
    await this.ensureReady(cfgToUse);
    if (!this.client) {
      throw new Error("ClawChat client is not ready");
    }

    const payload = {
      type: "text",
      content: text,
    };

    logDebug("sending message", {
      kind: target.kind,
      id: target.id,
      textPreview: text.slice(0, 80),
    });

    if (target.kind === "group") {
      return await this.client.sysManage.sendGroupMessage({
        ...payload,
        gid: target.id,
      });
    }
    return await this.client.sysManage.sendRosterMessage({
      ...payload,
      uid: target.id,
    });
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      await this.shutdownPromise;
      return;
    }
    const run = (async () => {
      this.shuttingDown = true;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.reconnectPromise = null;
      this.reconnectAttempts = 0;
      this.reconnectForceRecreate = false;
      if (!this.client) {
        this.updateRuntimeStatus({
          running: false,
          connected: false,
          reconnectAttempts: 0,
          lastStopAt: Date.now(),
        });
        return;
      }
      const client = this.client;
      logDebug("shutting down clawchat session");
      await this.sendOfflineMarkerToSelf();
      try {
        client.disConnect?.();
      } catch (err) {
        logWarn("disConnect failed during shutdown", err);
      }
      try {
        client.logout?.();
      } catch (err) {
        logWarn("logout failed during shutdown", err);
      }
      if (this.client === client) {
        this.client = null;
        this.accountKey = null;
      }
      this.ensureReadyInFlight = null;
      this.listenersBound = false;
      this.loginPromise = null;
      this.loginSuccessSeen = false;
      this.socketConnectedSeen = false;
      this.selfId = "";
      this.onlineMarkerSent = false;
      this.routerGroupQueueByGroupId.clear();
      this.updateRuntimeStatus({
        running: false,
        connected: false,
        reconnectAttempts: 0,
        lastStopAt: Date.now(),
      });
    })();
    this.shutdownPromise = run;
    try {
      await run;
    } finally {
      if (this.shutdownPromise === run) {
        this.shutdownPromise = null;
      }
      this.shuttingDown = false;
    }
  }
}

const session = new ClawchatSession();

export const clawchatPlugin: any = {
  id: CLAWCHAT_CHANNEL_ID,
  meta,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: false,
    reactions: false,
    threads: false,
    blockStreaming: false,
  },
  reload: { configPrefixes: ["channels.clawchat", "channels.lanying"] },
  configSchema: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        appId: { type: "string" },
        username: { type: "string" },
        password: { type: "string" },
        allowManage: { type: "boolean" },
        dmPolicy: { type: "string", enum: ["open", "pairing"] },
        allowFrom: {
          type: "array",
          items: {
            oneOf: [{ type: "string" }, { type: "number" }],
          },
        },
        groupPolicy: { type: "string", enum: ["open", "disabled", "allowlist"] },
        groupAllowFrom: {
          type: "array",
          items: {
            oneOf: [{ type: "string" }, { type: "number" }],
          },
        },
        groups: {
          type: "object",
          additionalProperties: {
            type: "object",
            additionalProperties: false,
            properties: {
              requireMention: { type: "boolean" },
              enabled: { type: "boolean" },
              allowFrom: {
                type: "array",
                items: {
                  oneOf: [{ type: "string" }, { type: "number" }],
                },
              },
            },
          },
        },
        defaultTo: { type: "string" },
      },
    },
    uiHints: {
      enabled: {
        label: "Enabled",
        help: "Enable the ClawChat channel.",
      },
      appId: {
        label: "App ID",
        help: "ClawChat application App ID.",
        placeholder: "xxxxx",
      },
      username: {
        label: "Username",
        help: "ClawChat login username.",
        placeholder: "your-account",
      },
      password: {
        label: "Password",
        help: "ClawChat login password.",
        sensitive: true,
      },
      allowManage: {
        label: "Allow Manage",
        help: "Allow self-loopback config patch messages to modify OpenClaw config.",
        advanced: true,
      },
      dmPolicy: {
        label: "DM Policy",
        help: "Direct message access policy.",
      },
      allowFrom: {
        label: "Allow From",
        help: 'Allowed senders. With dmPolicy="open", an empty list is treated as ["*"].',
      },
      groupPolicy: {
        label: "Group Policy",
        help: 'Group inbound policy: "allowlist", "open", or "disabled".',
      },
      groupAllowFrom: {
        label: "Group Allow From",
        help: "Allowed senders in groups. Empty means no sender restriction.",
      },
      groups: {
        label: "Groups",
        help: 'Allowed groups map. Use group ID keys (or "*" wildcard) with requireMention/enabled.',
      },
      defaultTo: {
        label: "Default Target",
        help: "Default outbound target when no explicit target is provided.",
        placeholder: "user:123456",
      },
    },
  },
  config: {
    listAccountIds: () => [CLAWCHAT_DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg: any) => resolveClawchatAccount(cfg),
    defaultAccountId: () => CLAWCHAT_DEFAULT_ACCOUNT_ID,
    isConfigured: (account: any) => account.configured,
    describeAccount: (account: any) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      allowManage: account.allowManage,
      dmPolicy: account.dmPolicy,
      groupPolicy: account.groupPolicy,
      groupAllowFromCount: account.groupAllowFrom?.length ?? 0,
      groupsCount: Object.keys(account.groups ?? {}).length,
    }),
    resolveAllowFrom: ({ cfg }: any) => resolveClawchatAccount(cfg).allowFrom,
    formatAllowFrom: ({ allowFrom }: any) =>
      allowFrom.map((entry: any) => String(entry).trim()).filter(Boolean),
    resolveDefaultTo: ({ cfg }: any) => resolveClawchatAccount(cfg).defaultTo,
  },
  pairing: {
    idLabel: "clawchatUserId",
    normalizeAllowEntry: (entry: any) => entry.replace(/^(?:clawchat|lanying):/i, "").trim(),
    notifyApproval: async ({ cfg, id }: any) => {
      const account = resolveClawchatAccount(cfg);
      if (!account.configured || !account.enabled) {
        return;
      }
      await session.sendText(
        { kind: "user", id: String(id) },
        "OpenClaw: your access has been approved.",
        account,
      );
    },
  },
  security: {
    resolveDmPolicy: ({ account }: any) => ({
      policy: account.dmPolicy ?? "pairing",
      allowFrom: account.allowFrom ?? [],
      policyPath: "channels.clawchat.dmPolicy",
      allowFromPath: "channels.clawchat.allowFrom",
      approveHint: formatPairingApproveHint("clawchat"),
      normalizeEntry: (raw: any) => raw.replace(/^(?:clawchat|lanying):/i, "").trim(),
    }),
    collectWarnings: ({ account }: any) => {
      if (account.enabled && !account.configured) {
        return [
          "- ClawChat is enabled but not configured. Set channels.clawchat.appId, channels.clawchat.username, channels.clawchat.password.",
        ];
      }
      if (
        account.enabled &&
        account.configured &&
        account.groupPolicy === "allowlist" &&
        Object.keys(account.groups ?? {}).length === 0
      ) {
        return [
          '- ClawChat groups: groupPolicy="allowlist" but no channels.clawchat.groups configured; group messages will be blocked.',
        ];
      }
      return [];
    },
  },
  messaging: {
    normalizeTarget: (raw: any) => normalizeTarget(raw)?.id,
    targetResolver: {
      looksLikeId: (raw: any) => {
        const normalized = normalizeTarget(raw);
        return Boolean(normalized?.id);
      },
      hint: "<userId|group:groupId>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 2000,
    sendText: async ({ cfg, to, text }: any) => {
      const account = resolveClawchatAccount(cfg);
      logDebug("outbound sendText requested", {
        to,
        account: sanitizeAccountForLog(account),
      });
      if (!account.enabled) {
        throw new Error("ClawChat channel is disabled.");
      }
      const target = normalizeTarget(to);
      if (!target || !target.id) {
        throw new Error(`Invalid ClawChat target: ${to}`);
      }
      const messageId = await session.sendText(target, text, account);
      return {
        channel: CLAWCHAT_CHANNEL_ID,
        messageId: String(messageId ?? ""),
        chatId: target.id,
      };
    },
  },
  auth: {
    login: async ({ cfg }: any) => {
      const account = resolveClawchatAccount(cfg);
      logDebug("auth.login called", { account: sanitizeAccountForLog(account) });
      if (!account.enabled) {
        throw new Error("ClawChat channel is disabled.");
      }
      await session.ensureReady(account);
    },
  },
  gateway: {
    startAccount: async (ctx: any) => {
      const account = resolveClawchatAccount(ctx.cfg);
      if (!account.enabled) {
        ctx.log?.info?.("[clawchat] account disabled, skip startup");
        return { stop: () => {} };
      }
      if (!account.configured) {
        const reason = "ClawChat is not configured (appId/username/password)";
        ctx.log?.warn?.(`[clawchat] ${reason}`);
        throw new Error(reason);
      }

      if (account.usesLegacyConfig) {
        ctx.log?.warn?.(
          "[clawchat] legacy config detected at channels.lanying; migrate to channels.clawchat.",
        );
      }
      ctx.log?.info?.(`[clawchat] starting account ${ctx.accountId}`);
      ctx.log?.debug?.(
        `[clawchat] resolved account: ${JSON.stringify(sanitizeAccountForLog(account))}`,
      );
      session.bindRuntimeStatus({
        accountId: ctx.accountId,
        update: (next) => ctx.setStatus(next as any),
      });
      ctx.setStatus({
        accountId: ctx.accountId,
        enabled: account.enabled,
        configured: account.configured,
        running: false,
        connected: false,
        reconnectAttempts: 0,
        lastStartAt: Date.now(),
      });

      await session.ensureReady(account);
      ctx.setStatus({
        accountId: ctx.accountId,
        enabled: account.enabled,
        configured: account.configured,
        running: true,
        connected: true,
      });

      ctx.abortSignal.addEventListener(
        "abort",
        () => {
          session.clearRuntimeStatus(ctx.accountId);
          void session.shutdown();
        },
        { once: true },
      );

      await new Promise<void>((resolve) => {
        if (ctx.abortSignal.aborted) {
          resolve();
          return;
        }
        ctx.abortSignal.addEventListener(
          "abort",
          () => {
            resolve();
          },
          { once: true },
        );
      });
    },
    stopAccount: async (ctx: any) => {
      ctx.log?.info?.("[clawchat] stopAccount called");
      session.clearRuntimeStatus(ctx.accountId);
      await session.shutdown();
    },
  },
};
