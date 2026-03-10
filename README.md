# OpenClaw Channel Plugin: Lanying

Lanying IM Channel for OpenClaw.

## 功能说明

- 使用蓝莺 IM Web SDK 接入 OpenClaw
- 支持登录、收发文本消息
- 支持断线后的自动重连
- 当前版本仅处理单聊消息（群聊事件会忽略）

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
      "app_id": "xxxxx",
      "username": "xxxx",
      "password": "xxxx",
      "allowManage": false,
      "dmPolicy": "open",
      "allowFrom": ["*"]
    }
  }
}
```

### 参数说明

- `enabled`: 是否启用插件（默认 `true`）
- `app_id`: 蓝莺应用 App ID
- `username`: 登录名
- `password`: 登录密码
- `allowManage`: 是否允许通过自发消息触发配置变更（默认 `false`）
- `dmPolicy`: 私聊策略，常用 `open` 或 `pairing`
- `allowFrom`: 允许发起对话的来源列表

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

## 使用

配置生效并重启网关后：

1. 用蓝莺账号向机器人账号发送私聊消息
2. 插件收到消息后会转发给 OpenClaw
3. OpenClaw 生成回复后由插件回发到蓝莺

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

- 请确认 `app_id/username/password` 正确
- 观察是否出现 `loginFail event` 或 `flooError event`

2. 收到消息但 OpenClaw 不回复

- 当前只处理单聊；群聊不会触发回复
- 历史消息、回环消息（`from === to`）和自发同步消息会被跳过
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
