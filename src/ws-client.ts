import WebSocket from "ws";
import type { LanyingInboundEvent, LanyingLog, LanyingSend, LanyingWsConfig } from "./types.js";

type Handlers = {
  onEvent: (evt: LanyingInboundEvent) => void;
  log?: LanyingLog;
};

export class LanyingWsClient {
  private ws: WebSocket | null = null;
  private stopped = false;

  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;

  private attempt = 0;

  constructor(private cfg: LanyingWsConfig, private handlers: Handlers) {}

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
  }

  isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: LanyingSend) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const payload = safeJson(msg);
    this.handlers.log?.debug?.(`[lanying] tx: ${payload}`);
    ws.send(payload);
  }

  private connect() {
    if (this.stopped) return;

    const { url, headers } = this.cfg;
    this.handlers.log?.info?.(`[lanying] connecting ${url} (attempt=${this.attempt + 1})`);

    const ws = new WebSocket(url, {
      headers: headers ?? {},
      handshakeTimeout: 15_000,
    });

    this.ws = ws;

    ws.on("open", () => {
      this.attempt = 0;
      this.handlers.onEvent({ type: "connected" });
      this.startHeartbeat();
    });

    ws.on("message", (data) => {
      const text = typeof data === "string" ? data : data.toString("utf8");
      this.handlers.log?.debug?.(`[lanying] rx: ${text}`);

      let raw: unknown = data;

      // 尽量尝试 JSON
      try {
        raw = JSON.parse(text);
      } catch {
        // 非 JSON 就原样抛
      }

      this.handlers.onEvent({ type: "message", raw });
    });

    ws.on("pong", () => {
      if (this.pongTimer) {
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }
    });

    ws.on("close", (code, reasonBuf) => {
      this.clearTimers();
      const reason = reasonBuf?.toString?.() || "";
      this.handlers.onEvent({ type: "disconnected", reason: `${code} ${reason}`.trim() });

      if (!this.stopped && this.cfg.reconnect?.enabled !== false) {
        this.scheduleReconnect();
      }
    });

    ws.on("error", (err) => {
      this.handlers.onEvent({ type: "error", error: err });
      // close 通常会跟随发生；重连放在 close
    });
  }

  private startHeartbeat() {
    this.clearTimers();

    const heartbeatMs = this.cfg.heartbeatMs ?? 25_000;
    const pongTimeoutMs = this.cfg.pongTimeoutMs ?? 10_000;

    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      try {
        ws.ping();

        if (this.pongTimer) clearTimeout(this.pongTimer);
        this.pongTimer = setTimeout(() => {
          this.handlers.log?.warn?.("[lanying] pong timeout, terminating socket");
          try {
            ws.terminate();
          } catch {}
        }, pongTimeoutMs);
      } catch (e) {
        this.handlers.log?.warn?.(`[lanying] heartbeat failed: ${String(e)}`);
      }
    }, heartbeatMs);
  }

  private scheduleReconnect() {
    const base = this.cfg.reconnect?.baseDelayMs ?? 500;
    const max = this.cfg.reconnect?.maxDelayMs ?? 15_000;
    const jitter = this.cfg.reconnect?.jitterRatio ?? 0.2;

    this.attempt += 1;
    const exp = Math.min(max, base * Math.pow(2, this.attempt - 1));
    const rand = 1 + (Math.random() * 2 - 1) * jitter;
    const delay = Math.max(0, Math.floor(exp * rand));

    this.handlers.log?.warn?.(`[lanying] reconnect in ${delay}ms (attempt=${this.attempt})`);

    setTimeout(() => {
      if (this.stopped) return;
      this.connect();
    }, delay);
  }

  private clearTimers() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.heartbeatTimer = null;
    this.pongTimer = null;
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
