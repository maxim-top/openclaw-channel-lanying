# OpenClaw Lanying Channel Plugin

`@openclaw/lanying` 是一个基于 WebSocket 的 OpenClaw 渠道插件，用于将 OpenClaw Agent 与蓝莺 IM 连接起来，实现入站消息接收、自动回复生成与出站消息发送。

## Overview

本工程提供以下能力：

- 蓝莺单账号接入（`channels.lanying`）
- WebSocket 长连接管理（鉴权、心跳、断线重连）
- 入站消息协议解析（兼容新协议与蓝莺 legacy 结构）
- 入站 ACK 回执（`message.inbound.ack`）
- 出站发送与 ACK 处理（`message.send` / `message.ack`）
- 对接 OpenClaw 自动回复链路（route/session/dispatch）

## Project Structure

```text
.
├── index.ts            # 插件入口，注册 channel 并注入 runtime
├── src/
│   ├── channel.ts      # 渠道实现：配置、网关生命周期、收发/派发逻辑
│   ├── ws-client.ts    # WebSocket 客户端：连接、心跳、重连、收发日志
│   ├── types.ts        # 协议与客户端类型定义
│   └── runtime.ts      # OpenClaw runtime 注入与访问
├── openclaw.plugin.json
├── tsconfig.json
└── README.md
```

## Configuration

当前为单账号模式：

```yaml
channels:
  lanying:
    enabled: true
    name: lanying
    token: "<YOUR_LANYING_TOKEN>"
```

字段说明：

- `channels.lanying.enabled`：是否启用渠道
- `channels.lanying.token`：蓝莺 WebSocket 鉴权 token
- `channels.lanying.name`：可选，账号显示名

## WebSocket Message Protocol

### Envelope

```json
{
  "v": 1,
  "event": "message.inbound",
  "ts": 1772010839642,
  "requestId": "req_xxx",
  "data": {}
}
```

- `v`：协议版本
- `event`：事件类型
- `ts`：时间戳（毫秒）
- `requestId`：请求追踪 ID
- `data`：业务数据

### Inbound (Server -> Plugin)

```json
{
  "v": 1,
  "event": "message.inbound",
  "ts": 1772010839642,
  "requestId": "req_in_xxx",
  "data": {
    "from": "6597200000001",
    "to": "65973000000002",
    "chatType": "direct",
    "msgId": "711785029071536147",
    "contentType": "text",
    "content": "hello!"
  }
}
```

### Inbound ACK (Plugin -> Server)

```json
{
  "v": 1,
  "event": "message.inbound.ack",
  "ts": 1772010839647,
  "requestId": "req_in_xxx",
  "data": {
    "msgId": "711785029071536147",
    "ok": true
  }
}
```

### Outbound (Plugin -> Server)

```json
{
  "v": 1,
  "event": "message.send",
  "ts": 1772011651216,
  "requestId": "reply_xxx",
  "data": {
    "to": "6597200000001",
    "chatType": "direct",
    "contentType": "text",
    "content": "Hello from OpenClaw"
  }
}
```

### Outbound ACK (Server -> Plugin)

```json
{
  "v": 1,
  "event": "message.ack",
  "ts": 1772011651222,
  "requestId": "reply_xxx",
  "data": {
    "msgId": "6",
    "ok": true
  }
}
```

`message.ack` 会被当作回执事件处理，不会再误走 inbound 解析。

## Runtime Flow

1. 插件启动后建立蓝莺 WebSocket 长连接
2. 收到 `message.inbound` 后立即回 `message.inbound.ack`
3. 将消息派发到 OpenClaw 回复链路：
   - `resolveAgentRoute`
   - `finalizeInboundContext`
   - `recordInboundSession`
   - `dispatchReplyWithBufferedBlockDispatcher`
4. 生成回复后发送 `message.send`
5. 接收服务端 `message.ack` 更新状态与日志

## Logging

默认包含协议收发调试日志：

- `[lanying] rx: ...`：收到原始 JSON
- `[lanying] tx: ...`：发送 JSON
