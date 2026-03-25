# OpenClaw Channel Plugin: Lanying

Lanying IM Channel for OpenClaw.

## 功能说明

- 使用蓝莺 IM Web SDK 接入 OpenClaw
- 支持登录、收发文本消息
- 支持私聊与群聊消息（可配置群策略、群白名单、群内触发规则）
- 支持断线后的自动重连

## 安装

推荐使用 OpenClaw CLI 安装扩展。

从 npm 安装（推荐）：

```bash
openclaw plugins install @lanyingim/lanying
```

从 GitHub 安装：

```bash
git clone https://github.com/maxim-top/openclaw-channel-lanying
openclaw plugins install ./openclaw-channel-lanying
```

## 配置

在 OpenClaw 配置中添加 `channels.lanying`：

```json
{
  "channels": {
    "lanying": {
      "enabled": true,
      "appId": "xxxxx",
      "username": "xxxx",
      "password": "xxxx",
      "allowManage": false,
      "dmPolicy": "open",
      "allowFrom": ["*"],
      "groupPolicy": "open",
      "groupAllowFrom": ["*"],
      "groups": {
        "*": {
          "requireMention": true
        },
        "123456": {
          "enabled": true,
          "requireMention": false,
          "allowFrom": ["10001", "10002"]
        }
      }
    }
  }
}
```

### 参数说明

- `enabled`: 是否启用插件（可选，默认 `false`）。不设置时不会启用。
- `appId`: 蓝莺应用 App ID
- `username`: 登录名
- `password`: 登录密码
- `allowManage`: 是否允许通过自发消息触发配置变更（默认 `false`）
- `dmPolicy`: 私聊策略，常用 `open` 或 `pairing`
- `allowFrom`: 允许发起对话的来源列表。`dmPolicy=open` 且未设置时会自动补为 `["*"]`。
- `groupPolicy`: 群消息策略，`allowlist | open | disabled`（默认 `disabled`）。
- `groupAllowFrom`: 群内允许触发机器人的发送者列表。未配置或 `[]` 表示不允许任何发送者；`["*"]` 表示允许所有发送者。
- `groups`: 允许的群配置，键为群 ID（支持 `"*"` 通配），每个群可配置：
  - `enabled`: 是否启用该群（默认启用）
  - `requireMention`: 是否要求 @ 触发（默认 `true`）
  - `allowFrom`: 该群发送者白名单（优先级高于 `groupAllowFrom`）

当 `allowManage=true` 时，若收到 `from` 和 `to` 都等于当前 `selfId` 的消息，且 `ext` 为：

```json
{
  "openclaw": {
    "type": "config_patch",
    "raw": "PATCH STRING"
  }
}
```

插件会执行：

```bash
openclaw gateway call config.get --params '{}'
openclaw gateway call config.patch --params '{"raw":"PATCH STRING","baseHash":"xxxxxxx"}'
```

同样在 `allowManage=true` 下，支持中转请求消息：

```json
{
  "openclaw": {
    "type": "router_request",
    "message": {
      "id": "req-1",
      "from": "10001",
      "to": "10002",
      "content": "你好",
      "type": "text",
      "timestamp": "1710000000000",
      "toType": "roster"
    }
  }
}
```

插件只会用 `selfId -> selfId` 的消息返回 `router_reply`，不会走普通外发回复链路：

```json
{
  "openclaw": {
    "type": "router_reply",
    "message": {
      "id": "router_reply_1710000000001",
      "from": "10002",
      "to": "10001",
      "content": "你好！",
      "type": "text",
      "ext": "",
      "config": "",
      "attach": "",
      "status": 1,
      "timestamp": "1710000000001",
      "toType": "roster"
    }
  },
  "ai": {
    "role": "ai"
  }
}
```

## 使用

配置生效并重启网关后：

1. 私聊：用蓝莺账号向机器人账号发送私聊消息
2. 群聊：按 `groupPolicy/groupAllowFrom/groups` 规则过滤后触发
3. 插件收到消息后会转发给 OpenClaw
4. OpenClaw 生成回复后由插件回发到蓝莺（群消息默认回原群）

当群配置 `requireMention=true` 且消息未命中 @ 时，插件不会立即回复，但会把该消息缓存为群上下文；下一条命中 @ 的消息会连同这些上下文一起发送给 OpenClaw。

## 日志与排查

插件日志前缀为 `[lanying]`，常见关键日志：

- `attempting login`
- `login success`
- `sdk ready`
- `inbound event: onRosterMessage`
- `inbound message`
- `reply dispatcher result`
- `schedule reconnect`
- `reconnect attempt start`
- `reconnect attempt success`

### 常见问题

1. 登录成功但很快退出

- 请确认 `appId/username/password` 正确
- 观察是否出现 `loginFail event` 或 `flooError event`

2. 收到消息但 OpenClaw 不回复

- 历史消息、回环消息（`from === to`）和自发同步消息会被跳过
- 自环 `router_reply` 会被显式忽略，避免回环递归
- 群消息还需满足：
  - `groupPolicy` 未禁用
  - `groupPolicy=allowlist` 时命中 `groups`（可用 `"*"`）
  - 发送者命中 `groups.<gid>.allowFrom` 或 `groupAllowFrom`（未配置/`[]` 拒绝所有，`["*"]` 允许所有）
  - `requireMention=true` 时命中 @ 触发
- 未命中 @ 的群消息会被记录为上下文，不会立即回复
- 检查是否出现 `reply dispatcher skipped payload` 或 `reply dispatcher send failed`

3. 断线后未恢复

- 检查是否有 `disconnected` / `schedule reconnect` / `reconnect attempt` 日志
- 插件已内置指数退避重连（2s 起步，最大 30s）

## 目标格式（主动发送时）

插件支持以下目标写法：

- `user:<uid>`
- `group:<gid>`
- 直接写 `<uid>`（按单聊处理）
- 可带前缀 `lanying:`，例如 `lanying:user:123456`
