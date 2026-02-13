export type LanyingWsConfig = {
  url: string; // wss://...
  headers?: Record<string, string>; // 鉴权 header
  heartbeatMs?: number; // ping 间隔
  pongTimeoutMs?: number; // 等待 pong 的超时
  reconnect?: {
    enabled?: boolean;
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitterRatio?: number; // 0~1
  };
};

export type LanyingChatType = "direct" | "group";
export type LanyingContentType = "text";

export type LanyingMessageInboundData = {
  from: string;
  to: string;
  chatType: LanyingChatType;
  msgId: string;
  contentType: LanyingContentType;
  content: string;
};

export type LanyingMessageSendData = {
  to: string;
  chatType: LanyingChatType;
  contentType: LanyingContentType;
  content: string;
};

export type LanyingInboundAckData = {
  msgId: string;
  ok: boolean;
  error?: {
    code: string;
    message: string;
  };
};

export type LanyingInboundMessagePacket = {
  v: 1;
  event: "message.inbound";
  ts: number;
  requestId: string;
  data: LanyingMessageInboundData;
};

export type LanyingOutboundSendPacket = {
  v: 1;
  event: "message.send";
  ts: number;
  requestId: string;
  data: LanyingMessageSendData;
};

export type LanyingInboundAckPacket = {
  v: 1;
  event: "message.inbound.ack";
  ts: number;
  requestId: string;
  data: LanyingInboundAckData;
};

/**
 * 蓝莺当前回调示例：
 * { from, to, type: "CHAT"|"GROUPCHAT", msgId, content }
 */
export type LanyingLegacyInboundRaw = {
  from?: unknown;
  to?: unknown;
  type?: unknown;
  msgId?: unknown;
  content?: unknown;
};

export type LanyingInboundEvent =
  | { type: "connected" }
  | { type: "disconnected"; reason?: string }
  | { type: "message"; raw: unknown }
  | { type: "error"; error: unknown };

export type LanyingSend = LanyingOutboundSendPacket | LanyingInboundAckPacket;

export type LanyingLog = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
};
