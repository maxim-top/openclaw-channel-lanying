import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeAllowEntry,
  normalizeTarget,
  resolveClawchatAccount,
  sanitizeAccountForLog,
} from "./channel/config.js";
import {
  collectHashCandidates,
  type RouterReplyTargetSnapshot,
  type SessionMappingSignal,
} from "./channel/message.js";
import { createClawchatSessionMessageFlow } from "./channel/session-message-flow.js";
import {
  findBaseHash,
  isConfigChangedSinceLastLoadError,
  parseJsonFromMixedText,
  runGatewayCall,
} from "./openclaw/gateway.js";
import { getClawchatRuntime } from "./runtime.js";
import { asPlainObject, pickId, stripAnsi } from "./shared/utils.js";
import { logDebug, logError, logWarn } from "./shared/logging.js";
import {
  CLAWCHAT_CHANNEL_ID,
  CLAWCHAT_DEFAULT_ACCOUNT_ID,
  type ClawchatInboundEvent,
  type ClawchatMessageTarget,
  type OpenClawConfig,
  type ResolvedClawchatAccount,
} from "./types.js";

// SDK-facing local types stay here because they are only used by the
// main channel entry and session orchestration layer.
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

// Plugin surface metadata and runtime constants.
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
const channelPackageJson = require("../package.json") as { version?: string };
const CLAWCHAT_PLUGIN_VERSION =
  typeof channelPackageJson?.version === "string" ? channelPackageJson.version.trim() : "";
const CLAWCHAT_API_VERSION = 2;
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
const CLAWCHAT_MANAGED_DIR = "clawchat";
const CLAWCHAT_MANAGED_AGENTS_PATH = `${CLAWCHAT_MANAGED_DIR}/AGENTS.md`;
const DEFAULT_AGENT_ID = "main";

// Node/browser bridge helpers for the bundled IM SDK.
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeUtf8FileSync(filePath: string, content: string): void {
  const writer = (fs as Record<string, unknown>).writeFileSync;
  if (typeof writer !== "function") {
    throw new Error("node:fs.writeFileSync is unavailable in this runtime");
  }
  (
    writer as (path: string, data: string, encoding: string) => void
  )(filePath, content, "utf8");
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
  const code = fs.readFileSync(sdkModulePath, "utf8");
  const hash = createHash("sha1").update(code).digest("hex").slice(0, 12);
  const runtimeCjsDir = path.join(os.tmpdir(), "openclaw-clawchat-sdk");
  const runtimeCjsPath = path.join(runtimeCjsDir, `floo-3.0.0-${hash}.cjs`);

  if (!fs.existsSync(runtimeCjsDir)) {
    fs.mkdirSync(runtimeCjsDir, { recursive: true });
  }
  if (!fs.existsSync(runtimeCjsPath)) {
    fs.copyFileSync(sdkModulePath, runtimeCjsPath);
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

// Main plugin session orchestrator.
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
  private sessionMappingByGroupKey = new Map<string, { sessionKey: string; updatedAt: number }>();
  private sessionMappingBySessionKey = new Map<
    string,
    {
      groupKey?: string;
      updatedAt: number;
      parentSessionKey?: string;
      rootSessionKey?: string;
      effectiveTargetSessionKey?: string;
    }
  >();
  private missingSessionMappingSeedPromise: Promise<void> | null = null;
  private readonly messageFlow = createClawchatSessionMessageFlow({
    getSelfId: () => this.selfId,
    updateSelfIdFromClient: (reason) => this.updateSelfIdFromClient(reason),
    getReadOnlyClient: () => this.client,
    loadConfig: async () => (await getClawchatRuntime().config.loadConfig()) as OpenClawConfig,
    resolveAgentRoute: (params) => getClawchatRuntime().channel.routing.resolveAgentRoute(params),
    resolveStorePath: (store, opts) => getClawchatRuntime().channel.session.resolveStorePath(store, opts),
    readSessionUpdatedAt: (params) => getClawchatRuntime().channel.session.readSessionUpdatedAt(params),
    recordInboundSession: (params) => getClawchatRuntime().channel.session.recordInboundSession(params),
    resolveEnvelopeFormatOptions: (cfg) => getClawchatRuntime().channel.reply.resolveEnvelopeFormatOptions(cfg),
    formatAgentEnvelope: (params) => getClawchatRuntime().channel.reply.formatAgentEnvelope(params),
    finalizeInboundContext: (ctx) => getClawchatRuntime().channel.reply.finalizeInboundContext(ctx),
    dispatchReplyWithBufferedBlockDispatcher: (params) =>
      getClawchatRuntime().channel.reply.dispatchReplyWithBufferedBlockDispatcher(params),
    sendRouterReplyToSelf: (message) => this.sendRouterReplyToSelf(message),
    sendConfigPatchMarkerToSelf: (params) => this.sendConfigPatchMarkerToSelf(params),
    sendPresetPromptSyncMarkerToSelf: (params) => this.sendPresetPromptSyncMarkerToSelf(params),
    applyOpenClawConfigPatch: (rawPatch) => this.applyOpenClawConfigPatch(rawPatch),
    handlePresetPromptSync: (params) => this.handlePresetPromptSync(params),
    sendText: (target, text, account) => this.sendText(target, text, account),
    sendSessionMessageSyncToSelf: (update) => this.sendSessionMessageSyncToSelf(update),
    resolveSessionMapping: (params) => this.resolveSessionMapping(params),
    applySessionMappingSignal: (signal) => this.applySessionMappingSignal(signal),
    pendingGroupContext: this.pendingGroupContext,
    routerGroupQueueByGroupId: this.routerGroupQueueByGroupId,
  });

  private buildSessionMappingGroupKey(params: {
    openclawUserId: string;
    groupId: string;
  }): string {
    return [params.openclawUserId.trim(), params.groupId.trim()].join("|");
  }

  private normalizeSessionMappingSessionKey(sessionKey: string): string {
    return sessionKey.trim().toLowerCase();
  }

  private normalizeOptionalSessionKey(value: unknown): string | undefined {
    const normalized = this.normalizeSessionMappingSessionKey(String(value ?? ""));
    return normalized || undefined;
  }

  private buildLocalSessionStorePath(cfg: OpenClawConfig): string {
    return getClawchatRuntime().channel.session.resolveStorePath(cfg.session?.store, {
      agentId: DEFAULT_AGENT_ID,
    });
  }

  private async loadLocalSessionStore(): Promise<Record<string, unknown>> {
    const cfg = (await getClawchatRuntime().config.loadConfig()) as OpenClawConfig;
    const storePath = this.buildLocalSessionStorePath(cfg);
    try {
      const raw = fs.readFileSync(storePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      return parsed;
    } catch (err) {
      logWarn("failed to load local session store", {
        err,
        storePath,
      });
      return {};
    }
  }

  private findLocalSessionEntry(
    sessions: Record<string, unknown>,
    normalizedSessionKey: string,
  ): Record<string, unknown> | null {
    const matchedKey = Object.keys(sessions).find(
      (key) => this.normalizeSessionMappingSessionKey(key) === normalizedSessionKey,
    );
    return asPlainObject(matchedKey ? sessions[matchedKey] : null);
  }

  private resolveLocalParentSessionKey(entry: Record<string, unknown> | null): string | undefined {
    if (!entry) {
      return undefined;
    }
    return (
      this.normalizeOptionalSessionKey(entry.parentSessionKey) ??
      this.normalizeOptionalSessionKey(entry.spawnedBy)
    );
  }

  private resolveLocalRootSessionKey(
    sessionKey: string,
    sessions: Record<string, unknown>,
  ): string | undefined {
    const normalizedSessionKey = this.normalizeSessionMappingSessionKey(sessionKey);
    if (!normalizedSessionKey) {
      return undefined;
    }
    let current = normalizedSessionKey;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const entry = this.findLocalSessionEntry(sessions, current);
      const parent = this.resolveLocalParentSessionKey(entry);
      if (!parent) {
        return current;
      }
      current = parent;
    }
    return normalizedSessionKey;
  }

  private async resolveLocalSessionLineage(sessionKey: string): Promise<{
    parentSessionKey?: string;
    rootSessionKey?: string;
    spawnDepth?: number;
  }> {
    const normalizedSessionKey = this.normalizeSessionMappingSessionKey(sessionKey);
    if (!normalizedSessionKey) {
      return {};
    }
    const sessions = await this.loadLocalSessionStore();
    const entry = this.findLocalSessionEntry(sessions, normalizedSessionKey);
    const parentSessionKey = this.resolveLocalParentSessionKey(entry);
    const rootSessionKey = this.resolveLocalRootSessionKey(normalizedSessionKey, sessions);
    const spawnDepthRaw =
      typeof entry?.spawnDepth === "number" ? entry.spawnDepth : Number(entry?.spawnDepth ?? NaN);
    return {
      ...(parentSessionKey ? { parentSessionKey } : {}),
      ...(rootSessionKey ? { rootSessionKey } : {}),
      ...(Number.isFinite(spawnDepthRaw) && spawnDepthRaw >= 0 ? { spawnDepth: spawnDepthRaw } : {}),
    };
  }

  private resolveSessionMapping(params: {
    appId: string;
    openclawUserId: string;
    groupId: string;
  }): { sessionKey: string } | null {
    const key = this.buildSessionMappingGroupKey(params);
    const mapping = this.sessionMappingByGroupKey.get(key);
    if (!mapping?.sessionKey) {
      return null;
    }
    return { sessionKey: mapping.sessionKey };
  }

  private applySessionMappingSignal(signal: SessionMappingSignal): void {
    const now = Date.now();
    const scopedOpenclawUserId = signal.openclawUserId?.trim() || this.selfId.trim();
    for (const mapping of signal.mappings) {
      const openclawUserId = mapping.openclawUserId?.trim() || scopedOpenclawUserId;
      const sessionKey = mapping.session.trim();
      const groupId = mapping.groupId?.trim() || "";
      if (!openclawUserId || !sessionKey) {
        continue;
      }
      const updatedAt = mapping.updatedAt ?? now;
      const groupKey = groupId
        ? this.buildSessionMappingGroupKey({
            openclawUserId,
            groupId,
          })
        : undefined;
      const normalizedSessionKey = this.normalizeSessionMappingSessionKey(sessionKey);
      const previousBySession = this.sessionMappingBySessionKey.get(normalizedSessionKey);
      if (previousBySession?.groupKey && previousBySession.groupKey !== groupKey) {
        this.sessionMappingByGroupKey.delete(previousBySession.groupKey);
      }
      if (groupKey) {
        this.sessionMappingByGroupKey.set(groupKey, { sessionKey, updatedAt });
      }
      this.sessionMappingBySessionKey.set(normalizedSessionKey, {
        ...(groupKey ? { groupKey } : {}),
        updatedAt,
        parentSessionKey: this.normalizeOptionalSessionKey(mapping.parentSessionKey),
        rootSessionKey: this.normalizeOptionalSessionKey(mapping.rootSessionKey),
        effectiveTargetSessionKey: this.normalizeOptionalSessionKey(
          mapping.effectiveTargetSessionKey,
        ),
      });
    }
    if (signal.type === "session_mapping_snapshot") {
      void this.seedMissingSessionMappingsFromLocalStore();
    }
  }

  private isClawchatCreatedSessionKey(sessionKey: string): boolean {
    const normalized = this.normalizeSessionMappingSessionKey(sessionKey);
    return normalized.includes(":clawchat:") || normalized.includes(":clawchat-router:");
  }

  private async listLocalSessionsForMappingSeed(): Promise<
    Array<{
      sessionKey: string;
      parentSessionKey?: string;
      rootSessionKey?: string;
      spawnDepth?: number;
    }>
  > {
    const parsed = await this.loadLocalSessionStore();
    return Object.entries(parsed)
      .map(([sessionKey, entry]) => {
        const normalizedSessionKey = this.normalizeSessionMappingSessionKey(sessionKey);
        const sessionEntry = asPlainObject(entry);
        const endedAtRaw =
          typeof sessionEntry?.endedAt === "number"
            ? sessionEntry.endedAt
            : Number(sessionEntry?.endedAt ?? 0);
        const spawnDepthRaw =
          typeof sessionEntry?.spawnDepth === "number"
            ? sessionEntry.spawnDepth
            : Number(sessionEntry?.spawnDepth ?? NaN);
        if (!normalizedSessionKey) {
          return null;
        }
        if (this.isClawchatCreatedSessionKey(normalizedSessionKey)) {
          return null;
        }
        if (Number.isFinite(endedAtRaw) && endedAtRaw > 0) {
          return null;
        }
        const result: {
          sessionKey: string;
          parentSessionKey?: string;
          rootSessionKey?: string;
          spawnDepth?: number;
        } = {
          sessionKey: sessionKey.trim(),
        };
        const parentSessionKey = this.resolveLocalParentSessionKey(sessionEntry);
        const rootSessionKey = this.resolveLocalRootSessionKey(normalizedSessionKey, parsed);
        if (parentSessionKey) {
          result.parentSessionKey = parentSessionKey;
        }
        if (rootSessionKey) {
          result.rootSessionKey = rootSessionKey;
        }
        if (Number.isFinite(spawnDepthRaw) && spawnDepthRaw >= 0) {
          result.spawnDepth = spawnDepthRaw;
        }
        return result;
      })
      .filter((session): session is NonNullable<typeof session> => Boolean(session?.sessionKey));
  }

  private async seedMissingSessionMappingsFromLocalStore(): Promise<void> {
    if (this.missingSessionMappingSeedPromise) {
      await this.missingSessionMappingSeedPromise;
      return;
    }
    const run = (async () => {
      const cfg = (await getClawchatRuntime().config.loadConfig()) as OpenClawConfig;
      const account = resolveClawchatAccount(cfg);
      if (!account.allowManage) {
        return;
      }
      const sessions = await this.listLocalSessionsForMappingSeed();
      const missingSessions = sessions.filter((session) => {
        const normalized = this.normalizeSessionMappingSessionKey(session.sessionKey);
        return !this.sessionMappingBySessionKey.has(normalized);
      });
      if (missingSessions.length === 0) {
        logDebug("no missing local sessions to seed mapping", {
          sessionCount: sessions.length,
        });
        return;
      }
      logDebug("seeding missing local session mappings from snapshot", {
        totalLocalSessions: sessions.length,
        missingMappings: missingSessions.length,
        sessionKeys: missingSessions.map((session) => session.sessionKey),
      });
      for (const session of missingSessions) {
        await this.sendSessionMessageSyncToSelf({
          sessionFile: session.sessionKey,
          sessionKey: session.sessionKey,
          parentSessionKey: session.parentSessionKey,
          rootSessionKey: session.rootSessionKey,
          spawnDepth: session.spawnDepth,
          source: "control_ui_user",
          message: {
            role: "user",
            content: "",
          },
        });
      }
    })();
    this.missingSessionMappingSeedPromise = run;
    try {
      await run;
    } finally {
      if (this.missingSessionMappingSeedPromise === run) {
        this.missingSessionMappingSeedPromise = null;
      }
    }
  }

  private appendPendingGroupContext(params: {
    groupId: string;
    senderId: string;
    senderName?: string;
    body: string;
    timestamp: number;
  }): void {
    this.messageFlow.appendPendingGroupContext(params);
  }

  private consumePendingGroupContext(groupId: string): string {
    return this.messageFlow.consumePendingGroupContext(groupId);
  }

  private buildBodyWithPendingGroupContext(groupId: string, body: string, isSlashCommand: boolean): string {
    return this.messageFlow.buildBodyWithPendingGroupContext(groupId, body, isSlashCommand);
  }

  private async handleRouterContext(
    routerMessage: Record<string, unknown>,
    requestSid: string,
    groupId: string,
  ): Promise<void> {
    await this.messageFlow.handleRouterContext(routerMessage, requestSid, groupId);
  }

  private async runRouterSignalInGroupQueue(params: {
    groupId: string;
    requestSid: string;
    run: () => Promise<void>;
  }): Promise<void> {
    await this.messageFlow.runRouterSignalInGroupQueue(params);
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
    fs.mkdirSync(location.managedDir, { recursive: true });
    writeUtf8FileSync(location.managedFile, content);
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
      logDebug(`inbound event: ${name}`, event);
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
      onMessageStatusChanged: (event: unknown) =>
        logDebug("onMessageStatusChanged event", event),
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

  async sendSessionMessageSyncToSelf(update: {
    sessionFile: string;
    sessionKey?: string;
    message?: unknown;
    messageId?: string;
    source?: string;
    parentSessionKey?: string;
    rootSessionKey?: string;
    spawnDepth?: number;
    senderUserId?: string;
  }): Promise<void> {
    if (!this.client || !this.selfId || !this.client.isLogin?.()) {
      return;
    }
    const cfg = await getClawchatRuntime().config.loadConfig();
    const account = resolveClawchatAccount(cfg);
    if (!account.allowManage) {
      return;
    }
    const message = asPlainObject(update.message);
    const normalizedSessionKey =
      (typeof update.sessionKey === "string" && update.sessionKey.trim()) ||
      String(update.sessionFile ?? "");
    const shouldResolveLineage =
      normalizedSessionKey.includes(":subagent:") ||
      typeof update.parentSessionKey === "string" ||
      typeof update.rootSessionKey === "string" ||
      typeof update.spawnDepth === "number";
    const lineage =
      normalizedSessionKey &&
      shouldResolveLineage &&
      (!update.parentSessionKey || !update.rootSessionKey || typeof update.spawnDepth !== "number")
        ? await this.resolveLocalSessionLineage(normalizedSessionKey)
        : {};
    const role =
      typeof message?.role === "string" && message.role.trim() ? message.role.trim() : undefined;
    const content =
      message && Object.prototype.hasOwnProperty.call(message, "content")
        ? message.content
        : update.message;
    const normalizedPayload = {
      session: normalizedSessionKey,
      ...(typeof update.parentSessionKey === "string" && update.parentSessionKey.trim()
        ? { parent_session: update.parentSessionKey.trim() }
        : lineage.parentSessionKey
          ? { parent_session: lineage.parentSessionKey }
          : {}),
      ...(typeof update.rootSessionKey === "string" && update.rootSessionKey.trim()
        ? { root_session: update.rootSessionKey.trim() }
        : lineage.rootSessionKey
          ? { root_session: lineage.rootSessionKey }
          : {}),
      ...(typeof update.spawnDepth === "number" && Number.isFinite(update.spawnDepth)
        ? { spawn_depth: update.spawnDepth }
        : typeof lineage.spawnDepth === "number" && Number.isFinite(lineage.spawnDepth)
          ? { spawn_depth: lineage.spawnDepth }
          : {}),
      ...(typeof update.source === "string" && update.source.trim()
        ? { source: update.source.trim() }
        : {}),
      ...(typeof update.senderUserId === "string" && update.senderUserId.trim()
        ? { sender_user_id: update.senderUserId.trim() }
        : {}),
      message: message
        ? {
            role,
            content,
          }
        : {
            role: undefined,
          content,
        },
    };
    try {
      await this.client.sysManage.sendRosterMessage({
        type: "command",
        uid: this.selfId,
        content: "",
        ext: JSON.stringify({
          openclaw: {
            type: "session_message_sync",
            ...normalizedPayload,
          },
        }),
      });
    } catch (_err) {
      // Never let transcript sync forwarding affect the IM session runtime.
    }
  }

  private async handleRouterRequest(
    routerMessage: Record<string, unknown>,
    account: ResolvedClawchatAccount,
    knowledge = "",
    replyTargetSnapshot?: RouterReplyTargetSnapshot,
  ): Promise<void> {
    await this.messageFlow.handleRouterRequest(
      routerMessage,
      account,
      knowledge,
      replyTargetSnapshot,
    );
  }

  private async onInbound(
    event: ClawchatInboundEvent,
    mode: "direct" | "group",
    account: ResolvedClawchatAccount,
    eventName?: string,
  ): Promise<void> {
    await this.messageFlow.onInbound(event, mode, account, eventName);
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
            plugin_version: CLAWCHAT_PLUGIN_VERSION,
            api_version: CLAWCHAT_API_VERSION,
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

export async function emitSessionMessageSyncToSelf(update: {
  sessionFile: string;
  sessionKey?: string;
  message?: unknown;
  messageId?: string;
  source?: string;
  senderUserId?: string;
}): Promise<void> {
  await session.sendSessionMessageSyncToSelf(update);
}

// OpenClaw channel plugin export.
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
