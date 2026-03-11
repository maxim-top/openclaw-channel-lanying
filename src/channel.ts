import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import {
  formatPairingApproveHint,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import { getLanyingRuntime } from "./runtime.js";
import {
  LANYING_CHANNEL_ID,
  LANYING_DEFAULT_ACCOUNT_ID,
  type LanyingChannelConfig,
  type LanyingInboundEvent,
  type LanyingMessageTarget,
  type ResolvedLanyingAccount,
} from "./types.js";

type FlooFactory = (options: Record<string, unknown>) => LanyingImClient;

type LanyingImClient = {
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
  id: LANYING_CHANNEL_ID,
  label: "Lanying",
  selectionLabel: "Lanying IM",
  detailLabel: "Lanying IM",
  docsPath: "/channels/lanying",
  docsLabel: "lanying",
  blurb: "Lanying IM channel for OpenClaw.",
  order: 90,
};

const require = createRequire(import.meta.url);
const sdkModulePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "./lanying-im-sdk/floo-3.0.0.js",
);
let cachedFlooFactory: FlooFactory | null = null;
const execFile = promisify(execFileCb);
const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 250;
const RECONNECT_BASE_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const LOG_MASK = "******";
const SENSITIVE_KEY_RE =
  /(password|pass|pwd|api[_-]?key|token|secret|authorization|auth|cookie|session|private[_-]?key)/i;
const SENSITIVE_INLINE_RE =
  /((?:password|pass|pwd|api[_-]?key|token|secret|authorization|auth|cookie|session|private[_-]?key)\s*[:=]\s*["']?)([^"',\s}]+)(["']?)/gi;
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
  (globalThis as { XMLHttpRequest: typeof NodeXmlHttpRequest }).XMLHttpRequest =
    NodeXmlHttpRequest;
  logDebug("installed XMLHttpRequest polyfill for lanying sdk");
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
  return value.replace(SENSITIVE_INLINE_RE, (_full, prefix: string, _secret: string, suffix: string) => {
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
    console.log(`[lanying] ${message}`);
    return;
  }
  console.log(`[lanying] ${message}`, redactForLog(data));
}

function logWarn(message: string, data?: unknown): void {
  if (data === undefined) {
    console.warn(`[lanying] ${message}`);
    return;
  }
  console.warn(`[lanying] ${message}`, redactForLog(data));
}

function logError(message: string, err?: unknown): void {
  if (err === undefined) {
    console.error(`[lanying] ${message}`);
    return;
  }
  console.error(`[lanying] ${message}`, redactForLog(err));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadFlooFactory(): FlooFactory {
  if (cachedFlooFactory) {
    return cachedFlooFactory;
  }

  ensureXmlHttpRequestPolyfill();
  logDebug("loading lanying sdk", { sdkModulePath });
  const code = readFileSync(sdkModulePath, "utf8");
  const hash = createHash("sha1").update(code).digest("hex").slice(0, 12);
  const runtimeCjsDir = path.join(os.tmpdir(), "openclaw-lanying-sdk");
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
    throw new Error("Invalid Lanying SDK export: flooim factory not found");
  }

  cachedFlooFactory = floo as FlooFactory;
  logDebug("lanying sdk loaded");
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

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
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

async function runGatewayCall(command: string, params: Record<string, unknown>): Promise<unknown> {
  const args = ["gateway", "call", command, "--params", JSON.stringify(params)];
  logDebug("exec openclaw gateway call", {
    command,
    paramsKeys: Object.keys(params),
  });
  const { stdout, stderr } = await execFile("openclaw", args, {
    maxBuffer: 2 * 1024 * 1024,
  });
  if (stderr.trim()) {
    logWarn(`openclaw ${command} stderr`, stderr.trim());
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

function extractText(event: LanyingInboundEvent): string {
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

function normalizeTarget(raw: string): LanyingMessageTarget | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.replace(/^lanying:/i, "");
  if (/^(group|g):/i.test(normalized)) {
    return { kind: "group", id: normalized.replace(/^(group|g):/i, "").trim() };
  }
  if (/^(user|u):/i.test(normalized)) {
    return { kind: "user", id: normalized.replace(/^(user|u):/i, "").trim() };
  }
  return { kind: "user", id: normalized };
}

function sanitizeAccountForLog(account: ResolvedLanyingAccount): Record<string, unknown> {
  return {
    accountId: account.accountId,
    enabled: account.enabled,
    configured: account.configured,
    appId: account.appId ? `${account.appId.slice(0, 4)}***` : "",
    username: account.username,
    dmPolicy: account.dmPolicy,
    allowFromCount: account.allowFrom.length,
  };
}

function resolveLanyingConfig(cfg: OpenClawConfig): LanyingChannelConfig {
  const channels = cfg?.channels as Record<string, unknown> | undefined;
  const raw = channels?.[LANYING_CHANNEL_ID];
  if (!raw || typeof raw !== "object") {
    return {};
  }
  return raw as LanyingChannelConfig;
}

function resolveLanyingAccount(cfg: OpenClawConfig): ResolvedLanyingAccount {
  const channelCfg = resolveLanyingConfig(cfg);
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

  return {
    accountId: LANYING_DEFAULT_ACCOUNT_ID,
    enabled,
    configured: Boolean(enabled && hasCredentials),
    appId,
    username,
    password,
    allowManage: channelCfg.allowManage === true,
    dmPolicy: channelCfg.dmPolicy ?? "pairing",
    allowFrom: (channelCfg.allowFrom ?? []).map((entry) => String(entry).trim()).filter(Boolean),
    defaultTo: channelCfg.defaultTo?.trim() || undefined,
  };
}

class LanyingSession {
  private client: LanyingImClient | null = null;
  private accountKey: string | null = null;
  private loginPromise: Promise<void> | null = null;
  private reconnectPromise: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private listenersBound = false;
  private shuttingDown = false;
  private selfId = "";
  private lastConfig?: ResolvedLanyingAccount;
  private onlineMarkerSent = false;
  private offlineMarkerSent = false;

  private async applyOpenClawConfigPatch(rawPatch: string): Promise<void> {
    logDebug("apply config patch requested", {
      patchBytes: Buffer.byteLength(rawPatch, "utf8"),
    });
    const getResult = await runGatewayCall("config.get", {});
    logDebug("config.get result summary", {
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
          textBytes: Buffer.byteLength(getResult, "utf8"),
          hasHashToken: /hash/i.test(cleaned),
          hashLines,
        });
      }
      throw new Error("Failed to read baseHash from config.get output.");
    }
    logDebug("resolved baseHash for config.patch", {
      baseHashPreview: baseHash.slice(0, 12),
      baseHashLength: baseHash.length,
    });
    await runGatewayCall("config.patch", {
      raw: rawPatch,
      baseHash,
    });
    logDebug("config.patch call finished");
  }

  private currentConfigKey(account: ResolvedLanyingAccount): string {
    return `${account.appId}::${account.username}::${account.password}`;
  }

  private async createClient(account: ResolvedLanyingAccount): Promise<LanyingImClient> {
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

  private bindListeners(account: ResolvedLanyingAccount): void {
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
      void this.onInbound(event as LanyingInboundEvent, "direct", account);
    };
    const onGroup = (name: string, event: unknown) => {
      logDebug(`inbound event: ${name}`, event);
      logDebug("skip group event (direct-only mode)", { name });
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
      onMentionMessage: (event: unknown) => onGroup("onMentionMessage", event),
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
      loginSuccess: (event: unknown) => logDebug("loginSuccess event", event),
      loginFail: (event: unknown) => {
        logWarn("loginFail event", event);
        this.scheduleReconnect("loginFail");
      },
      messageNormal: (event: unknown) => logDebug("messageNormal event", event),
      flooNotice: (event: unknown) => {
        logDebug("flooNotice event", event);
      },
      flooError: (event: unknown) => {
        logWarn("flooError event", event);
        this.scheduleReconnect("flooError");
      },
      reconnect: (event: unknown) => {
        logWarn("reconnect event", event);
        this.scheduleReconnect("reconnect");
      },
      disconnected: (event: unknown) => {
        logWarn("disconnected", event);
        this.scheduleReconnect("disconnected");
      },
      connected: (event: unknown) => {
        logDebug("connected", event);
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
    this.reconnectPromise = null;
    logDebug("reconnect state reset", { reason });
  }

  private scheduleReconnect(trigger: string): void {
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

    const exp = Math.min(this.reconnectAttempts, 6);
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** exp);
    this.reconnectAttempts += 1;
    logWarn("schedule reconnect", {
      trigger,
      attempt: this.reconnectAttempts,
      delayMs: delay,
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
          await this.ensureReady(cfg);
          logWarn("reconnect attempt success", {
            attempt: this.reconnectAttempts,
            username: cfg.username,
          });
          this.resetReconnectState("reconnect_success");
        } catch (err) {
          logError("reconnect attempt failed", err);
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

  private async onInbound(
    event: LanyingInboundEvent,
    mode: "direct" | "group",
    account: ResolvedLanyingAccount,
  ): Promise<void> {
    try {
      if (mode !== "direct") {
        logDebug("skip non-direct inbound", { mode });
        return;
      }
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

      const toId =
        pickId(event.to) ||
        pickId((event as { to_id?: unknown }).to_id) ||
        pickId(meta.to) ||
        pickId(meta.uid) ||
        pickId(meta.xid);
      const directPeer =
        pickId(event.from) ||
        pickId((event as { to_id?: unknown }).to_id) ||
        pickId((event as { xid?: unknown }).xid) ||
        toId;
      const targetId = directPeer;
      if (!targetId) {
        logWarn("inbound message missing target id", { mode, event });
        return;
      }
      this.updateSelfIdFromClient("inbound event");
      const configPatchRaw = extractConfigPatchRaw(eventAny, meta);
      if (senderId && toId && senderId === toId) {
        const isSelfLoopback = Boolean(this.selfId && senderId === this.selfId);
        if (isSelfLoopback && account.allowManage && configPatchRaw) {
          try {
            await this.applyOpenClawConfigPatch(configPatchRaw);
            logDebug("applied config patch from self loopback message", {
              senderId,
              toId,
              patchBytes: Buffer.byteLength(configPatchRaw, "utf8"),
            });
          } catch (err) {
            logError("failed to apply config patch from self loopback message", {
              err,
              senderId,
              toId,
              selfId: this.selfId,
              allowManage: account.allowManage,
              hasConfigPatch: Boolean(configPatchRaw),
              patchBytes: Buffer.byteLength(configPatchRaw, "utf8"),
            });
          }
          return;
        }
        logDebug("skip loopback message (from === to)", {
          senderId,
          toId,
          selfId: this.selfId,
          allowManage: account.allowManage,
          hasConfigPatch: Boolean(configPatchRaw),
        });
        return;
      }

      const body = extractText(event);
      if (!body) {
        logDebug("skip empty inbound", { mode, eventType: event.type });
        return;
      }

      if (senderId && this.selfId && senderId === this.selfId) {
        logDebug("skip self/multi-device sync message", { senderId, toId, targetId });
        return;
      }

      logDebug("inbound message", {
        mode,
        senderId,
        toId,
        targetId,
        bodyPreview: body.slice(0, 80),
        keys: Object.keys(meta),
      });

      const runtime = getLanyingRuntime();
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
        toId &&
        senderId !== toId &&
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
            toId,
          });
        } catch (err) {
          logWarn("failed to mark inbound direct message as read", {
            err,
            senderUid,
            mid: inboundMid ?? undefined,
            senderId,
            toId,
          });
        }
      }
      const timestampNum = Number(
        eventAny.timestamp ?? meta.timestamp ?? (eventAny as { ts?: unknown }).ts ?? Date.now(),
      );

      const result = await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: {
          Body: body,
          From: senderId || targetId,
          To: toId || account.username,
          SessionKey: targetId,
          AccountId: account.accountId,
          MessageSid: messageSid || undefined,
          Timestamp: Number.isFinite(timestampNum) ? timestampNum : Date.now(),
          OriginatingChannel: LANYING_CHANNEL_ID as any,
          OriginatingTo: targetId,
          ChatType: mode,
          Provider: LANYING_CHANNEL_ID,
          Surface: LANYING_CHANNEL_ID,
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
            await this.sendText(
              {
                kind: "user",
                id: targetId,
              },
              response,
              account,
            );
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

  async ensureReady(account: ResolvedLanyingAccount): Promise<void> {
    if (!account.configured) {
      throw new Error("Lanying account is not configured (enabled/appId/username/password).");
    }

    const nextKey = this.currentConfigKey(account);
    const needNewClient = !this.client || !this.accountKey || this.accountKey !== nextKey;

    if (needNewClient) {
      await this.shutdown();
      this.shuttingDown = false;
      this.client = await this.createClient(account);
      this.onlineMarkerSent = false;
      this.offlineMarkerSent = false;
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
        throw new Error("Lanying client not initialized");
      }
      logDebug("attempting login", { username: account.username });
      await this.client.login({
        name: account.username,
        password: account.password,
      });

      logDebug("login success", {
        username: account.username,
      });

      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const ready = Boolean(this.client?.isReady?.());
        const loggedIn = Boolean(this.client?.isLogin?.());
        if (loggedIn) {
          this.updateSelfIdFromClient("login fully ready");
          await this.sendLoginMarkerToSelf();
          logDebug("sdk ready", { ready, loggedIn });
          this.resetReconnectState("login_success");
          return;
        }
        await sleep(READY_POLL_MS);
      }
      throw new Error("Lanying SDK not logged in after login timeout");
    })();

    try {
      await this.loginPromise;
    } catch (err) {
      logError("login failed", err);
      this.loginPromise = null;
      this.scheduleReconnect("ensureReady_login_failed");
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
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        if (!this.client?.isLogin?.()) {
          return;
        }
        await this.client.sysManage.sendRosterMessage({
          type: "text",
          uid: this.selfId,
          content: "蓝莺插件已上线",
          ext: JSON.stringify({ openclaw: { type: "online" } }),
        });
        this.onlineMarkerSent = true;
        this.offlineMarkerSent = false;
        logDebug("sent login marker message to self", { selfId: this.selfId, attempt });
        return;
      } catch (err) {
        if (attempt >= maxAttempts) {
          logWarn("failed to send login marker message to self", {
            err,
            selfId: this.selfId,
            attempt,
          });
          return;
        }
        await sleep(250 * attempt);
      }
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
        content: "蓝莺插件已下线",
        ext: JSON.stringify({ openclaw: { type: "offline" } }),
      });
      this.offlineMarkerSent = true;
      logDebug("sent offline marker message to self", { selfId: this.selfId });
    } catch (err) {
      logWarn("failed to send offline marker message to self", { err, selfId: this.selfId });
    }
  }

  async sendText(
    target: LanyingMessageTarget,
    text: string,
    account?: ResolvedLanyingAccount,
  ): Promise<unknown> {
    const cfgToUse = account ?? this.lastConfig;
    if (!cfgToUse) {
      throw new Error("Lanying session has no account context");
    }
    await this.ensureReady(cfgToUse);
    if (!this.client) {
      throw new Error("Lanying client is not ready");
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
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectPromise = null;
    this.reconnectAttempts = 0;
    if (!this.client) {
      return;
    }
    logDebug("shutting down lanying session");
    await this.sendOfflineMarkerToSelf();
    try {
      this.client.disConnect?.();
    } catch (err) {
      logWarn("disConnect failed during shutdown", err);
    }
    try {
      this.client.logout?.();
    } catch (err) {
      logWarn("logout failed during shutdown", err);
    }
    this.client = null;
    this.accountKey = null;
    this.listenersBound = false;
    this.loginPromise = null;
    this.selfId = "";
    this.onlineMarkerSent = false;
  }
}

const session = new LanyingSession();

export const lanyingPlugin: ChannelPlugin<ResolvedLanyingAccount> = {
  id: LANYING_CHANNEL_ID,
  meta,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: false,
    reactions: false,
    threads: false,
    blockStreaming: false,
  },
  reload: { configPrefixes: ["channels.lanying"] },
  config: {
    listAccountIds: () => [LANYING_DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg) => resolveLanyingAccount(cfg),
    defaultAccountId: () => LANYING_DEFAULT_ACCOUNT_ID,
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      allowManage: account.allowManage,
      dmPolicy: account.dmPolicy,
    }),
    resolveAllowFrom: ({ cfg }) => resolveLanyingAccount(cfg).allowFrom,
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => String(entry).trim()).filter(Boolean),
    resolveDefaultTo: ({ cfg }) => resolveLanyingAccount(cfg).defaultTo,
  },
  pairing: {
    idLabel: "lanyingUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^lanying:/i, "").trim(),
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveLanyingAccount(cfg);
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
    resolveDmPolicy: ({ account }) => ({
      policy: account.dmPolicy ?? "pairing",
      allowFrom: account.allowFrom ?? [],
      policyPath: "channels.lanying.dmPolicy",
      allowFromPath: "channels.lanying.allowFrom",
      approveHint: formatPairingApproveHint("lanying"),
      normalizeEntry: (raw) => raw.replace(/^lanying:/i, "").trim(),
    }),
    collectWarnings: ({ account }) => {
      if (account.enabled && !account.configured) {
        return [
          '- Lanying is enabled but not configured. Set channels.lanying.appId, channels.lanying.username, channels.lanying.password.',
        ];
      }
      return [];
    },
  },
  messaging: {
    normalizeTarget: (raw) => normalizeTarget(raw)?.id,
    targetResolver: {
      looksLikeId: (raw) => {
        const normalized = normalizeTarget(raw);
        return Boolean(normalized?.id);
      },
      hint: "<userId|group:groupId>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 2000,
    sendText: async ({ cfg, to, text }) => {
      const account = resolveLanyingAccount(cfg);
      logDebug("outbound sendText requested", {
        to,
        account: sanitizeAccountForLog(account),
      });
      if (!account.enabled) {
        throw new Error("Lanying channel is disabled.");
      }
      const target = normalizeTarget(to);
      if (!target || !target.id) {
        throw new Error(`Invalid Lanying target: ${to}`);
      }
      const messageId = await session.sendText(target, text, account);
      return {
        channel: LANYING_CHANNEL_ID,
        messageId: String(messageId ?? ""),
        chatId: target.id,
      };
    },
  },
  auth: {
    login: async ({ cfg }) => {
      const account = resolveLanyingAccount(cfg);
      logDebug("auth.login called", { account: sanitizeAccountForLog(account) });
      if (!account.enabled) {
        throw new Error("Lanying channel is disabled.");
      }
      await session.ensureReady(account);
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = resolveLanyingAccount(ctx.cfg);
      if (!account.enabled) {
        ctx.log?.info?.("[lanying] account disabled, skip startup");
        return { stop: () => {} };
      }
      if (!account.configured) {
        const reason = "Lanying is not configured (appId/username/password)";
        ctx.log?.warn?.(`[lanying] ${reason}`);
        throw new Error(reason);
      }

      ctx.log?.info?.(`[lanying] starting account ${ctx.accountId}`);
      ctx.log?.debug?.(
        `[lanying] resolved account: ${JSON.stringify(sanitizeAccountForLog(account))}`,
      );
      ctx.setStatus({
        accountId: ctx.accountId,
        enabled: account.enabled,
        configured: account.configured,
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
    stopAccount: async (ctx) => {
      ctx.log?.info?.("[lanying] stopAccount called");
      await session.shutdown();
    },
  },
};
