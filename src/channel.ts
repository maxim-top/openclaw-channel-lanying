// src/channel.ts
import type { ChannelMeta, ChannelPlugin } from "openclaw/plugin-sdk";
import {
  DEFAULT_ACCOUNT_ID,
} from "openclaw/plugin-sdk";

import { getLanyingRuntime } from "./runtime.js";
import { LanyingWsClient } from "./ws-client.js";
import type {
  LanyingInboundAckPacket,
  LanyingInboundMessagePacket,
  LanyingLegacyInboundRaw,
  LanyingWsConfig,
} from "./types.js";

/** ✅ 写死 WebSocket 地址 */
const LANYING_WS_URL = "wss://connector.lanyingim.com/ws";
/** ✅ 写死鉴权 header 名 */
const AUTH_HEADER_NAME = "Authorization";

type ResolvedLanyingAccount = {
  accountId: string;
  name?: string;
  enabled: boolean; // OpenClaw 结构需要，实际启停由外层 channels.lanying.enabled 控制
  configured: boolean;
  baseUrl?: string;
  config: {
    token?: string;
  };
};

const meta: ChannelMeta = {
  id: "lanying",
  label: "Lanying",
  selectionLabel: "Lanying (蓝莺)",
  docsPath: "/channels/lanying",
  docsLabel: "lanying",
  blurb: "Lanying IM messaging channel.",
};

export const lanyingPlugin: ChannelPlugin<ResolvedLanyingAccount> = {
  id: "lanying",
  meta: { ...meta },

  capabilities: {
    chatTypes: ["direct", "group"],
    media: false,
    reactions: false,
  },

  reload: { configPrefixes: ["channels.lanying"] },
  configSchema: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        name: { type: "string" },
        token: { type: "string" },
      },
    },
  },

  config: {
    listAccountIds: (cfg) => {
      const section = (cfg.channels as any)?.lanying ?? {};
      if (section.enabled === false) return [];
      return [DEFAULT_ACCOUNT_ID];
    },

    resolveAccount: (cfg, accountId) => {
      const section = (cfg.channels as any)?.lanying ?? {};
      const id = (accountId ?? DEFAULT_ACCOUNT_ID).toString().trim() || DEFAULT_ACCOUNT_ID;
      const token = typeof section.token === "string" ? section.token.trim() : undefined;
      const name = typeof section.name === "string" ? section.name.trim() : undefined;

      return {
        accountId: id,
        name: name || id,
        enabled: true, // 结构字段固定；整体启停用外层 enabled
        configured: Boolean(token),
        baseUrl: LANYING_WS_URL,
        config: { token: token || undefined },
      };
    },

    defaultAccountId: (cfg) => {
      const section = (cfg.channels as any)?.lanying ?? {};
      if (section.enabled === false) return DEFAULT_ACCOUNT_ID;
      return DEFAULT_ACCOUNT_ID;
    },

    setAccountEnabled: ({ cfg, enabled }) => {
      const next: any = { ...cfg, channels: { ...(cfg.channels as any) } };
      next.channels.lanying = { ...(next.channels.lanying ?? {}) };
      next.channels.lanying.enabled = enabled;
      return next;
    },

    deleteAccount: ({ cfg, accountId }) => {
      const id = String(accountId ?? "").trim();
      if (id && id !== DEFAULT_ACCOUNT_ID) return cfg;

      const next: any = { ...cfg, channels: { ...(cfg.channels as any) } };
      const section = { ...(next.channels.lanying ?? {}) };
      delete section.token;
      delete section.name;
      next.channels.lanying = section;
      return next;
    },

    isConfigured: (account) => account.configured,

    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.baseUrl,
    }),

    resolveAllowFrom: () => ["*"],
    formatAllowFrom: ({ allowFrom }) => allowFrom.map((v) => String(v)),
  },

  messaging: {
    normalizeTarget: (raw) => String(raw).trim(),
    targetResolver: {
      looksLikeId: (raw) => Boolean(String(raw).trim()),
      hint: "<lanyingTargetId>",
    },
  },

  outbound: {
    deliveryMode: "direct",
    chunkerMode: "text",
    textChunkLimit: 4000,

    chunker: (text, limit) => {
      if (text.length <= limit) return [text];
      const out: string[] = [];
      for (let i = 0; i < text.length; i += limit) out.push(text.slice(i, i + limit));
      return out;
    },

    sendText: async ({ to, text, accountId, cfg }) => {
      const section = (cfg.channels as any)?.lanying ?? {};
      if (section.enabled === false) {
        throw new Error("Lanying channel disabled (channels.lanying.enabled=false)");
      }

      const id =
        (accountId ?? DEFAULT_ACCOUNT_ID).toString().trim() || DEFAULT_ACCOUNT_ID;

      const runtime = getLanyingRuntime() as any;
      const client: LanyingWsClient | undefined = runtime.__lanyingClients?.[clientKey(id)];

      if (!client || !client.isOpen()) {
        throw new Error(`Lanying websocket not connected (accountId=${id})`);
      }

      // TODO: 按蓝莺协议封装发送包
      client.send({
        v: 1,
        event: "message.send",
        ts: Date.now(),
        requestId: createRequestId("send"),
        data: {
          to: String(to).trim(),
          chatType: "direct",
          contentType: "text",
          content: text,
        },
      });

      return { channel: "lanying", ok: true, id: `${Date.now()}` } as any;
    },
  },

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      reconnectAttempts: 0,
      lastStartAt: null,
      lastStopAt: null,
      lastConnectedAt: null,
      lastDisconnect: null,
      lastMessageAt: null,
      lastEventAt: null,
      lastError: null,
    },
    collectStatusIssues: () => [],
    buildChannelSummary: ({ snapshot }) => snapshot as any,
    probeAccount: async () => ({ ok: true } as any),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastDisconnect: runtime?.lastDisconnect ?? null,
      baseUrl: account.baseUrl ?? undefined,
      lastError: runtime?.lastError ?? null,
    }),
  },

  gateway: {
    startAccount: async (ctx) => {
      const section = (ctx.cfg.channels as any)?.lanying ?? {};
      if (section.enabled === false) {
        ctx.log?.info?.(`[${ctx.account.accountId}] lanying disabled; skip gateway`);
        return;
      }

      // 单账号模式：只要 token 存在就拉起 websocket
      const token = ctx.account.config.token?.trim();
      if (!token) {
        ctx.log?.warn?.(`[${ctx.account.accountId}] lanying token missing; skip websocket`);
        return;
      }

      const headers: Record<string, string> = {
        [AUTH_HEADER_NAME]: `Bearer ${token}`,
      };

      const wsCfg: LanyingWsConfig = {
        url: LANYING_WS_URL,
        headers,
        heartbeatMs: 25_000,
        pongTimeoutMs: 10_000,
        reconnect: { enabled: true, baseDelayMs: 500, maxDelayMs: 15_000, jitterRatio: 0.2 },
      };

      const client = new LanyingWsClient(wsCfg, {
        onEvent: (evt) => {
          if (evt.type === "connected") {
            ctx.log?.info?.(`[${ctx.account.accountId}] lanying ws connected`);
            ctx.setStatus({
              accountId: ctx.account.accountId,
              running: true,
              connected: true,
              baseUrl: LANYING_WS_URL,
              lastConnectedAt: Date.now(),
              lastDisconnect: null,
              lastError: null,
            });
            return;
          }
          if (evt.type === "disconnected") {
            ctx.log?.warn?.(
              `[${ctx.account.accountId}] lanying ws disconnected: ${evt.reason ?? ""}`.trim(),
            );
            ctx.setStatus({
              accountId: ctx.account.accountId,
              connected: false,
              lastDisconnect: evt.reason ?? "disconnected",
              lastEventAt: Date.now(),
            });
            return;
          }
          if (evt.type === "error") {
            ctx.log?.error?.(
              `[${ctx.account.accountId}] lanying ws error: ${String(evt.error)}`,
            );
            ctx.setStatus({
              accountId: ctx.account.accountId,
              lastError: String(evt.error),
              lastEventAt: Date.now(),
            });
            return;
          }
          if (evt.type === "message") {
            const eventName = getPacketEventName(evt.raw);
            if (eventName === "message.ack") {
              handleOutboundAckEvent({ ctx, raw: evt.raw });
              return;
            }
            if (eventName && eventName !== "message.inbound") {
              ctx.log?.debug?.(
                `[${ctx.account.accountId}] lanying ignored event=${eventName}; raw=${safeJson(evt.raw)}`,
              );
              return;
            }

            const parsed = parseInboundMessage(evt.raw);
            if (!parsed.ok) {
              ctx.log?.warn?.(
                `[${ctx.account.accountId}] lanying inbound parse failed: ${parsed.reason}; raw=${safeJson(evt.raw)}`,
              );
              if (parsed.requestId && parsed.msgId) {
                client.send(buildInboundAck({
                  requestId: parsed.requestId,
                  msgId: parsed.msgId,
                  ok: false,
                  errorCode: "BAD_PAYLOAD",
                  errorMessage: parsed.reason,
                }));
              }
              ctx.setStatus({
                accountId: ctx.account.accountId,
                lastError: `inbound parse failed: ${parsed.reason}`,
                lastEventAt: Date.now(),
              });
              return;
            }

            client.send(buildInboundAck({
              requestId: parsed.packet.requestId,
              msgId: parsed.packet.data.msgId,
              ok: true,
            }));

            void dispatchInboundToRuntime({
              ctx,
              client,
              packet: parsed.packet,
            }).catch((error) => {
              ctx.log?.error?.(
                `[${ctx.account.accountId}] lanying inbound dispatch failed: ${String(error)}`,
              );
              ctx.setStatus({
                accountId: ctx.account.accountId,
                lastError: `inbound dispatch failed: ${String(error)}`,
                lastEventAt: Date.now(),
              });
            });

            // TODO: 把蓝莺入站事件转换为 OpenClaw inbound message
            ctx.log?.debug?.(
              `[${ctx.account.accountId}] lanying inbound: ${safeJson(parsed.packet)}`,
            );
            ctx.setStatus({
              accountId: ctx.account.accountId,
              lastMessageAt: Date.now(),
              lastEventAt: Date.now(),
            });
            return;
          }
        },
        log: {
          info: (m) => ctx.log?.info?.(m) ?? void 0,
          warn: (m) => ctx.log?.warn?.(m) ?? void 0,
          error: (m) => ctx.log?.error?.(m) ?? void 0,
          debug: (m) => ctx.log?.debug?.(m) ?? void 0,
        },
      });

      const runtime = getLanyingRuntime() as any;
      runtime.__lanyingClients ??= {};
      runtime.__lanyingClients[clientKey(ctx.account.accountId)] = client;

      ctx.setStatus({
        accountId: ctx.account.accountId,
        running: true,
        connected: false,
        baseUrl: LANYING_WS_URL,
        lastStartAt: Date.now(),
      });
      client.start();

      try {
        await waitForAbort(ctx.abortSignal);
      } finally {
        ctx.log?.info?.(`[${ctx.account.accountId}] stopping lanying gateway`);
        client.stop();
        delete runtime.__lanyingClients[clientKey(ctx.account.accountId)];
        ctx.setStatus({
          accountId: ctx.account.accountId,
          running: false,
          connected: false,
          lastStopAt: Date.now(),
        });
      }
    },
  },
};

function clientKey(accountId: string) {
  return `lanying.ws.${accountId}`;
}

function safeJson(v: unknown) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function createRequestId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildInboundAck(params: {
  requestId: string;
  msgId: string;
  ok: boolean;
  errorCode?: string;
  errorMessage?: string;
}): LanyingInboundAckPacket {
  return {
    v: 1,
    event: "message.inbound.ack",
    ts: Date.now(),
    requestId: params.requestId,
    data: {
      msgId: params.msgId,
      ok: params.ok,
      ...(params.ok
        ? {}
        : {
            error: {
              code: params.errorCode ?? "UNKNOWN",
              message: params.errorMessage ?? "unknown error",
            },
          }),
    },
  };
}

function parseInboundMessage(raw: unknown):
  | { ok: true; packet: LanyingInboundMessagePacket }
  | { ok: false; reason: string; requestId?: string; msgId?: string } {
  const wrapped = parseWrappedInbound(raw);
  if (wrapped.ok) return wrapped;
  return parseLegacyInbound(raw);
}

function parseWrappedInbound(raw: unknown):
  | { ok: true; packet: LanyingInboundMessagePacket }
  | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: "raw is not object" };
  if (raw.event !== "message.inbound") return { ok: false, reason: "not message.inbound" };

  const data = raw.data;
  if (!isRecord(data)) return { ok: false, reason: "data is not object" };

  const from = asNonEmptyString(data.from);
  const to = asNonEmptyString(data.to);
  const msgId = asNonEmptyString(data.msgId);
  const content = asString(data.content);
  const requestId = asNonEmptyString(raw.requestId);
  const chatType = normalizeChatType(data.chatType);
  const contentType = data.contentType === "text" ? "text" : null;

  if (!from || !to || !msgId || !requestId || !chatType || !contentType || content == null) {
    return { ok: false, reason: "missing required wrapped fields" };
  }

  return {
    ok: true,
    packet: {
      v: 1,
      event: "message.inbound",
      ts: typeof raw.ts === "number" ? raw.ts : Date.now(),
      requestId,
      data: { from, to, chatType, msgId, contentType, content },
    },
  };
}

function parseLegacyInbound(raw: unknown):
  | { ok: true; packet: LanyingInboundMessagePacket }
  | { ok: false; reason: string; requestId?: string; msgId?: string } {
  if (!isRecord(raw)) return { ok: false, reason: "raw is not object" };

  const legacy = raw as LanyingLegacyInboundRaw;
  const from = asNonEmptyString(legacy.from);
  const to = asNonEmptyString(legacy.to);
  const msgId = asNonEmptyString(legacy.msgId);
  const content = asString(legacy.content);
  const chatType = normalizeLegacyType(legacy.type);

  if (!from || !to || !msgId || !chatType || content == null) {
    return { ok: false, reason: "missing required legacy fields", msgId: msgId ?? undefined };
  }

  return {
    ok: true,
    packet: {
      v: 1,
      event: "message.inbound",
      ts: Date.now(),
      requestId: `in_${msgId}`,
      data: { from, to, chatType, msgId, contentType: "text", content },
    },
  };
}

function normalizeLegacyType(v: unknown): "direct" | "group" | null {
  if (typeof v !== "string") return null;
  if (v === "CHAT") return "direct";
  if (v === "GROUPCHAT") return "group";
  return null;
}

function normalizeChatType(v: unknown): "direct" | "group" | null {
  if (v === "direct" || v === "group") return v;
  return normalizeLegacyType(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed ? trimmed : null;
}

function asString(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function getPacketEventName(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  return typeof raw.event === "string" ? raw.event : null;
}

function handleOutboundAckEvent(params: { ctx: any; raw: unknown }): void {
  if (!isRecord(params.raw)) return;
  const requestId = asNonEmptyString(params.raw.requestId);
  const data = isRecord(params.raw.data) ? params.raw.data : null;
  const msgId = data ? asNonEmptyString(data.msgId) : null;
  const ok = data ? data.ok === true : false;

  if (ok) {
    params.ctx.log?.debug?.(
      `[${params.ctx.account.accountId}] lanying outbound ack ok requestId=${requestId ?? "-"} msgId=${msgId ?? "-"}`,
    );
  } else {
    params.ctx.log?.warn?.(
      `[${params.ctx.account.accountId}] lanying outbound ack failed requestId=${requestId ?? "-"} msgId=${msgId ?? "-"} raw=${safeJson(params.raw)}`,
    );
  }

  params.ctx.setStatus({
    accountId: params.ctx.account.accountId,
    lastEventAt: Date.now(),
  });
}

async function dispatchInboundToRuntime(params: {
  ctx: any;
  client: LanyingWsClient;
  packet: LanyingInboundMessagePacket;
}): Promise<void> {
  const runtime = getLanyingRuntime() as any;
  const core = runtime?.channel;

  if (!core?.routing?.resolveAgentRoute || !core?.reply?.dispatchReplyWithBufferedBlockDispatcher) {
    params.ctx.log?.warn?.(
      `[${params.ctx.account.accountId}] lanying runtime reply pipeline unavailable; inbound not dispatched`,
    );
    return;
  }

  const inbound = params.packet.data;
  const peerId = inbound.chatType === "group" ? inbound.to : inbound.from;

  const route = core.routing.resolveAgentRoute({
    cfg: params.ctx.cfg,
    channel: "lanying",
    accountId: params.ctx.account.accountId,
    peer: { kind: inbound.chatType, id: peerId },
  });

  const body = inbound.content;
  const ctxPayload = core.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: body,
    RawBody: body,
    CommandBody: body,
    From: `lanying:${inbound.from}`,
    To: `lanying:${peerId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: inbound.chatType,
    ConversationLabel: inbound.chatType === "group" ? `group:${inbound.to}` : inbound.from,
    SenderId: inbound.from,
    Provider: "lanying",
    Surface: "lanying",
    MessageSid: inbound.msgId,
    MessageSidFull: inbound.msgId,
    Timestamp: params.packet.ts,
    OriginatingChannel: "lanying",
    OriginatingTo: `lanying:${peerId}`,
    CommandAuthorized: true,
  });

  if (core.session?.recordInboundSession && core.session?.resolveStorePath) {
    const storePath = core.session.resolveStorePath(undefined, { agentId: route.agentId });
    await core.session.recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      onRecordError: (err: unknown) => {
        params.ctx.log?.warn?.(
          `[${params.ctx.account.accountId}] lanying recordInboundSession failed: ${String(err)}`,
        );
      },
    });
  }

  await core.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: params.ctx.cfg,
    dispatcherOptions: {
      deliver: async (payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string }) => {
        const text = payload.text?.trim();
        if (!text) return;

        params.client.send({
          v: 1,
          event: "message.send",
          ts: Date.now(),
          requestId: createRequestId("reply"),
          data: {
            to: peerId,
            chatType: inbound.chatType,
            contentType: "text",
            content: text,
          },
        });
        params.ctx.setStatus({
          accountId: params.ctx.account.accountId,
          lastOutboundAt: Date.now(),
        });
      },
      onError: (err: unknown, info: { kind: string }) => {
        params.ctx.log?.error?.(
          `[${params.ctx.account.accountId}] lanying ${info.kind} reply failed: ${String(err)}`,
        );
      },
    },
  });
}
