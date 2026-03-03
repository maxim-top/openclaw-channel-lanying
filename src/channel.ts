import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
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
      attachment?: unknown;
    }) => Promise<unknown>;
    sendGroupMessage: (params: {
      type: string;
      gid: string;
      content: string;
      attachment?: unknown;
    }) => Promise<unknown>;
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
const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 250;
const RECONNECT_BASE_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

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

function logDebug(message: string, data?: unknown): void {
  if (data === undefined) {
    console.log(`[lanying] ${message}`);
    return;
  }
  console.log(`[lanying] ${message}`, data);
}

function logWarn(message: string, data?: unknown): void {
  if (data === undefined) {
    console.warn(`[lanying] ${message}`);
    return;
  }
  console.warn(`[lanying] ${message}`, data);
}

function logError(message: string, err?: unknown): void {
  if (err === undefined) {
    console.error(`[lanying] ${message}`);
    return;
  }
  console.error(`[lanying] ${message}`, err);
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
  const appIdRaw = channelCfg.app_id ?? "";
  const usernameRaw = channelCfg.username ?? "";
  const passwordRaw = channelCfg.password ?? "";

  const appId = String(appIdRaw).trim();
  const username = String(usernameRaw).trim();
  const password = String(passwordRaw).trim();
  const enabled = channelCfg.enabled !== false;

  return {
    accountId: LANYING_DEFAULT_ACCOUNT_ID,
    enabled,
    configured: Boolean(enabled && appId && username && password),
    appId,
    username,
    password,
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
      logDebug(`inbound event: ${name}`, event);
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
        const evt = event as Record<string, unknown>;
        const msg = (evt.message ?? {}) as Record<string, unknown>;
        const sender = pickId(msg.from) || pickId(evt.from);
        if (sender && sender !== this.selfId) {
          this.selfId = sender;
          logDebug("learned selfId from sending status event", { selfId: this.selfId });
        }
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
      const isHistoryRaw = (eventAny.isHistory ?? meta.isHistory) as unknown;
      const isHistory =
        isHistoryRaw === true || isHistoryRaw === "true" || isHistoryRaw === 1 || isHistoryRaw === "1";
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

      const body = extractText(event);
      if (!body) {
        logDebug("skip empty inbound", { mode, eventType: event.type });
        return;
      }

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

      // Learn selfId from inbound direct message destination when unknown.
      if (mode === "direct" && !this.selfId && toId) {
        this.selfId = toId;
        logDebug("learned selfId from inbound to field", { selfId: this.selfId });
      }

      if (senderId && toId && senderId === toId) {
        logDebug("skip loopback message (from === to)", { senderId, toId, targetId });
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
      throw new Error("Lanying account is not configured (enabled/app_id/username/password).");
    }

    const nextKey = this.currentConfigKey(account);
    const needNewClient = !this.client || !this.accountKey || this.accountKey !== nextKey;

    if (needNewClient) {
      await this.shutdown();
      this.shuttingDown = false;
      this.client = await this.createClient(account);
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
      const result = await this.client.login({
        name: account.username,
        password: account.password,
      });

      const resultRecord =
        result && typeof result === "object" ? (result as Record<string, unknown>) : undefined;
      this.selfId = pickId(resultRecord?.uid ?? resultRecord?.user_id ?? resultRecord?.username);
      logDebug("login success", {
        username: account.username,
        selfId: this.selfId || undefined,
      });

      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const ready = Boolean(this.client?.isReady?.());
        const loggedIn = Boolean(this.client?.isLogin?.());
        if (loggedIn) {
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
          '- Lanying is enabled but not configured. Set channels.lanying.app_id, channels.lanying.username, channels.lanying.password.',
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
        const reason = "Lanying is not configured (app_id/username/password)";
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
