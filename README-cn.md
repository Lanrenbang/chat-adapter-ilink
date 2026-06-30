# @lanrenbang/chat-adapter-ilink

[![npm version](https://img.shields.io/npm/v/@lanrenbang/chat-adapter-ilink)](https://www.npmjs.com/package/@lanrenbang/chat-adapter-ilink)
[![npm downloads](https://img.shields.io/npm/dm/@lanrenbang/chat-adapter-ilink)](https://www.npmjs.com/package/@lanrenbang/chat-adapter-ilink)

微信 iLink 机器人适配器，适用于 [Chat SDK](https://chat-sdk.dev)。基于微信官方 iLink 协议，支持扫码登录和长轮询消息接收。

**注意**：这是社区适配器。微信不提供 webhook 端点——适配器使用长轮询（`getUpdates`）进行消息推送。

## 安装

```bash
npm install chat @lanrenbang/chat-adapter-ilink
```

## 快速开始

适配器可管理一个或多个 iLink 机器人账号。每个账号通过微信扫码登录，并维护独立的长轮询循环。

```typescript
import { Chat } from "chat";
import { createILinkAdapter } from "@lanrenbang/chat-adapter-ilink";
import { createMemoryState } from "@chat-adapter/state-memory";

const bot = new Chat({
  userName: "ilink-bot",
  adapters: {
    ilink: createILinkAdapter(),
  },
  state: createMemoryState(), // 扫码会话和账号持久化必需
});

bot.onNewMention(async (thread, message) => {
  await thread.post(`收到消息: ${message.text}`);
});
```

配置后，适配器会自动从环境变量读取 `ILINK_BOT_TOKEN`、`ILINK_BASE_URL` 和 `ILINK_CDN_BASE_URL`。

## 认证

iLink 是微信个人版机器人体系中的开放协议，最初通过 [OpenClaw](https://github.com/Tencent/openclaw-weixin) 插件开源实现。它使用二维码认证——没有 API key 或 token 可以直接粘贴。你**必须在应用中提供二维码展示机制**（CLI、网页 UI 或任意前端）。

### LoginOptions

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `sessionKey` | `string` | 自动生成 | 恢复已有登录会话 |
| `force` | `boolean` | `false` | 跳过缓存，强制生成新二维码 |
| `verifyCode` | `string` | — | 配对/验证码（用于 `need_verifycode` 流程） |
| `botType` | `string` | `"3"` | iLink 机器人类型参数 |
| `timeoutMs` | `number` | `480000` (8 分钟) | 登录超时（最小 1000ms），仅内部轮询模式有效 |
| `onStatusChange` | `(result: LoginResult) => void` | — | 内部轮询回调。提供时自动轮询，省略时立即返回 |

### LoginResult

| 字段 | 类型 | 说明 |
|------|------|------|
| `status` | `QRSessionStatus` | 原始上游 QR 状态（见下方表格） |
| `qrcodeUrl` | `string \| undefined` | 二维码图片 URL，供展示 |
| `sessionKey` | `string \| undefined` | 不透明令牌，用于恢复会话 |
| `message` | `string \| undefined` | 人类可读的提示或错误描述 |

### QR 状态值

| 状态 | 含义 | 下一步 |
|------|------|--------|
| `wait` | 等待用户扫码 | 显示二维码，等待 |
| `scaned` | 手机已扫码，等待确认 | 等待 |
| `confirmed` | 用户在手机上确认了登录 | ✅ **登录成功** — 账号自动注册 |
| `binded_redirect` | 已绑定过（存在有效 token） | ✅ 视为成功——已连接 |
| `expired` | 二维码超时 / 登录超时 | 重新生成二维码重试 |
| `need_verifycode` | 需要配对/验证码 | 获取用户输入后调用 `login()` 附带 `verifyCode` |
| `verify_code_blocked` | 验证码输入错误次数过多 | 稍后重试 |
| `scaned_but_redirect` | 已扫码但需 IDC 重定向 | 临时状态——适配器自动处理 |

适配器支持两种登录模式：

### 提供回调参数 - 内部自动轮询

传入 `onStatusChange` 回调后，适配器自动处理完整的登录循环——生成二维码、长轮询、过期/重定向处理，成功时自动注册账号并开始消息轮询。回调在每次状态变化时触发。返回值仅为参考（status/message）。

```typescript
import type { ILinkAdapter } from "@lanrenbang/chat-adapter-ilink";

const adapter = bot.getAdapter("ilink") as ILinkAdapter;

const result = await adapter.login({
  onStatusChange: (result) => {
    switch (result.status) {
      case "wait":
        console.log("请在微信中扫描二维码：", result.qrcodeUrl);
        break;
      case "scaned":
        console.log("二维码已扫描，等待确认...");
        break;
      case "confirmed":
        console.log("登录已确认！");
        break;
      case "need_verifycode":
        // 见下方"验证码流程"
        break;
    }
  },
});
```

> **注**：此模式下 Promise 在登录完成或到达终态时 resolve，返回值中的 `status` 告诉你最终结果。`onStatusChange` 回调是跟踪进度的主要方式。

### 不提供回调参数 - 外部自行轮询

不传 `onStatusChange` 时，首次调用立即返回二维码 URL 和 session key（不阻塞）。调用方在循环中传入 `sessionKey` 再次调用 `login()` 来获取最新状态：

```typescript
import type { ILinkAdapter } from "@lanrenbang/chat-adapter-ilink";

const adapter = bot.getAdapter("ilink") as ILinkAdapter;

// 第 1 步：发起登录——立即返回
const first = await adapter.login();
// { qrcodeUrl: "...", sessionKey: "uuid-xxx", status: "wait", message: "..." }

// 第 2 步：轮询直到终态
let result = first;
while (result.status === "wait" || result.status === "scaned" || result.status === "scaned_but_redirect") {
  result = await adapter.login({ sessionKey: result.sessionKey });
  await sleep(1000); // 1 秒间隔——上游长轮询本身已阻塞 35s
}

if (result.status === "confirmed") {
  console.log("登录成功——账号已自动注册");
}
```

此模式适合 HTTP API 场景——后端发放 session，前端处理轮询。

### 配对码

当微信检测到风险时，可能要求输入**配对/验证码**（`status === "need_verifycode"`）。两种模式的处理方式相同：

1. `adapter.login()` 返回 `{ status: "need_verifycode", message, sessionKey }`
2. 你的应用获取用户从手机屏幕上读取的验证码
3. 再次调用 `login()`，**同时**传入 `sessionKey` 和 `verifyCode`

**外部轮询模式**（无回调）——你已经在循环中，直接处理：

```typescript
let result = await adapter.login();
while (result.status === "wait" || result.status === "scaned" || result.status === "scaned_but_redirect") {
  result = await adapter.login({ sessionKey: result.sessionKey });
  await sleep(1000);
}

if (result.status === "need_verifycode") {
  const code = await promptUser(result.message!); // e.g. "输入手机微信显示的数字："
  result = await adapter.login({ sessionKey: result.sessionKey, verifyCode: code });
}
```

**内部轮询模式**（有回调）——将 login 包装为递归函数，保留回调：

```typescript
async function loginWithVerifyCode(sessionKey?: string, verifyCode?: string) {
  const result = await adapter.login({
    sessionKey,
    verifyCode,
    onStatusChange: (result) => {
      if (result.status === "need_verifycode") {
        // 异步提示用户，然后递归
        promptUser(result.message!).then((code) =>
          loginWithVerifyCode(result.sessionKey, code),
        );
      }
    },
  });
  return result;
}

// 首次调用——不传 sessionKey
const result = await loginWithVerifyCode();
```

> **必须传递 `sessionKey`** 重试——否则会生成新二维码，进入全新会话。原始扫码的二维码仍然有效，与那个 `sessionKey` 绑定。

### Session key 持久化

每个登录会话存储在 `StateAdapter` 中（5 分钟 TTL）。后续调用带上同样的 `sessionKey` 会恢复已有会话，两种模式均适用。

### 多账号管理

本适配器支持多个账号——每次 `login()` 调用创建独立的登录会话。`confirmed` 后账号自动注册到消息轮询中，无需手动干预。

### Cloudflare Agent 集成

关于在 Cloudflare Agent（Agents SDK）中使用本适配器的 Sub-Agent 模式实现登录状态隔离、`onBeforeSubAgent` 自动创建会话、以及回调式轮询的完整指南，请参考 [docs/integration.md](./docs/integration.md)。

## 配置项

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `baseUrl` | `string` | `https://ilinkai.weixin.qq.com` | iLink API 基础地址 |
| `cdnBaseUrl` | `string` | `https://novac2c.cdn.weixin.qq.com/c2c` | CDN 媒体上传地址 |
| `longPollTimeoutMs` | `number` | `35000` | `getUpdates` 长轮询超时（毫秒） |
| `botAgent` | `string` | `"OpenClaw"` | 自定义 bot agent 标识（类 UA 格式） |
| `routeTag` | `string` | — | 多区域路由标签 |
| `userName` | `string` | `"ilink-bot"` | 机器人显示名称 |
| `logger` | `Logger` | `ConsoleLogger("info")` | 自定义日志记录器 |
| `state` | `StateAdapter` | — | 状态适配器（扫码会话及多账号管理必需） |

## 环境变量

| 变量 | 必需 | 说明 |
|------|------|------|
| `ILINK_BOT_TOKEN` | 否 | 默认 bot token（推荐运行时通过 `addAccount` 设置） |
| `ILINK_BASE_URL` | 否 | 覆盖 iLink API 基础地址 |
| `ILINK_CDN_BASE_URL` | 否 | 覆盖 CDN 基础地址 |

## 功能支持

| 功能 | 支持情况 |
|------|----------|
| 发送文本消息 | 是 |
| 文件上传（图片、音频、视频、文件） | 是（通过 CDN 上传，`thread.post({ attachments })`） |
| 附件下载（解析传入的非文本消息） | 是（`message.attachments[].fetchData()`） |
| 语音 → 文本转录 | 是（`adapter.transcribeVoice(buffer)`） |
| 输入状态指示器 | 是 |
| 私聊（仅限 1:1） | 是 |
| 自定义 API 端点 | 是（可配置 `baseUrl`） |
| 获取线程信息 | 是 |
| 引用消息（引用回复） | 是（`adapter.replyToMessage()` / `adapter.extractQuotedContent()`） |
| 编辑 / 删除消息 | 否（微信限制） |
| 流式 / AI 流式传输 | 否 |
| 定时消息 | 否 |
| 卡片、按钮、选择菜单、模态框 | 否（微信只渲染纯文本） |
| 消息表情回应 | 否（微信限制） |
| 斜杠命令 | 是（通过 Chat SDK `onSlashCommand`） |
| @提及（多用户） | 否（仅支持 1:1——所有消息均为私聊） |
| 群聊 / 频道 | 否（仅支持 1:1） |
| 阅后即焚消息 | 否 |
| 获取消息历史 | 否（API 不暴露历史记录） |
| 列出线程 | 否 |
| 消息格式化 | 否（所有 markdown 会被展平为纯文本） |

## 线程 ID 格式

```
ilink:{accountId}:{userId}
```

- `ilink:bot_abc123:wx_user_xyz` — 通过账号 `bot_abc123` 与用户 `wx_user_xyz` 的私聊线程

## 斜杠命令

以 `/` 开头的消息会自动路由到 Chat SDK 的 `onSlashCommand` 处理器。适配器端无需额外配置——只需在 bot 上设置处理器：

```typescript
bot.onSlashCommand("/echo", async ({ args, thread }) => {
  await thread.post({ text: `你说: ${args.join(" ")}` });
});
```

## 附件下载（传入媒体）

适配器会自动从传入消息中提取非文本项为 `Attachment[]`。每个附件包含：
- `type`：`image`、`audio`、`voice`、`video` 或 `file`
- `fetchData()`：下载并解密实际的媒体字节
- `fetchMetadata()`：返回 `{ fileName, mimeType, fileSize, width, height, duration, description }`

```typescript
bot.onNewMessage(async (thread, message) => {
  for (const attachment of message.attachments ?? []) {
    const buf = await attachment.fetchData();
    const meta = await attachment.fetchMetadata();
    // buf: 解密后的媒体字节 (Uint8Array)
    // meta: { fileName, mimeType, ... }
  }
});
```

语音消息可以通过适配器的公开方法转换为文本：

```typescript
const adapter = bot.getAdapter("ilink");
const wav = await adapter.transcribeVoice(silkBuffer);
// 返回 WAV Buffer，如果 silk-wasm 不可用则返回 null
```

## 媒体上传

媒体（图片、音频、视频、文件）在上传至微信 CDN 前会使用 AES-128-ECB 加密。使用 `thread.post({ attachments: [...] })`——适配器内部处理 CDN 上传和消息发送：

```typescript
await thread.post({
  markdown: "看看这个",
  attachments: [
    { type: "image", data: imageBuffer, mimeType: "image/jpeg" },
    { type: "file", data: pdfBuffer, fileName: "report.pdf" },
  ],
});
```

支持的附件类型：`image`、`audio`、`voice`、`video`、`file`。无需调用单独的 upload 函数——`thread.post()` 全权处理。

## 不带媒体类型的文件发送

使用 `files` 进行通用文件上传（不指定媒体类型）：

```typescript
await thread.post({
  markdown: "这是报告：",
  files: [{ data: pdfBuffer, filename: "report.pdf", mimeType: "application/pdf" }],
});
```

`files` 始终以文档形式上传，而 `attachments` 保留媒体类型（image/audio/video）。

## 引用消息（引用回复）

微信支持 **ref_msg（引用消息）**——回复时可以引用之前的消息。适配器同时支持接收侧和发送侧。

### 接收：提取引用内容

`adapter.extractQuotedContent(message)` 从收到的消息中提取被引用的消息数据：

```typescript
bot.onNewMessage(async (thread, message) => {
  const adapter = bot.getAdapter("ilink") as ILinkAdapter;
  const quoted = adapter.extractQuotedContent(message);

  if (quoted) {
    console.log("引用标题:", quoted.title);
    console.log("引用文本:", quoted.text);
    // quoted.attachments — 被引用消息中的媒体
    for (const att of quoted.attachments) {
      const data = await att.fetchData();
    }
  }
});
```

无引用时返回 `null`。引用内容对象包含：
- `text?` — 引用文本（如果被引用消息为文本类型）
- `attachments` — 被引用的媒体附件数组（image/audio/video/file）
- `title?` — 微信提供的引用摘要/标题

> 被引用的文本也会以 `[引用: ...]` 前缀拼入 `message.text`，便于 LLM 理解上下文。需要精确分离引用文本时使用 `extractQuotedContent`。

### 发送：带引用回复

`adapter.replyToMessage(threadId, content, options)` 发送一条引用原始消息的回复：

```typescript
bot.onNewMessage(async (thread, message) => {
  const adapter = bot.getAdapter("ilink") as ILinkAdapter;

  // 文本回复 + 引用
  await adapter.replyToMessage(
    message.threadId,
    "感谢你的信息！",
    { quotedMessage: message },
  );

  // 媒体回复 + 引用（发送 TEXT(ref_msg) + MEDIA 双 item）
  await adapter.replyToMessage(
    message.threadId,
    { attachments: [{ type: "image", data: imageBuf }] },
    { quotedMessage: message },
  );
});
```

内部使用微信 `ref_msg` 协议——回复以携带引用 `message_item` 的 `TEXT` item 发送，后接可选的媒体 item。

## 参考项目

- [**Tencent/openclaw-weixin**](https://github.com/Tencent/openclaw-weixin) — 微信团队官方的 iLink 协议开源实现。本适配器基于此上游项目。
- [**wong2/chat-adapter-weixin**](https://github.com/wong2/chat-adapter-weixin) — 原始的社区版 Chat SDK 微信适配器。本适配器以全新的架构替代了它，并向上游 openclaw-weixin 对齐。

## AI 编程助手

如果你使用 OpenAI Codex、Claude Code、Cursor 等 AI 编程助手，可安装 Chat SDK skill：

```bash
npx skills add vercel/chat
```

AI 可读的文档参考：[chat-sdk.dev/llms.txt](https://chat-sdk.dev/llms.txt)。

## 许可证

MIT
