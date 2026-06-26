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

iLink 是微信个人版机器人体系中的开放协议，最初通过 [OpenClaw](https://github.com/Tencent/openclaw-weixin) 插件开源实现。它使用二维码认证——没有 API key 或 token 可以直接粘贴。你**必须在应用中提供二维码展示机制**（CLI、网页 UI 或任意前端）。适配器的 `login()` 函数通过 `onQRCode` 回调处理这一流程：

```typescript
import { login } from "@lanrenbang/chat-adapter-ilink";

const result = await login(state, {
  onQRCode: (qrCodeUrl: string) => {
    // 在 UI 中渲染二维码图片：
    // - CLI：打印 URL 供手动展示
    // - Web：渲染 <img src={qrCodeUrl} />
    // - Agent：在消息中返回 URL
    console.log("Scan this QR code in WeChat:", qrCodeUrl);
  },
});
```

### 配对码（验证码）流程

当微信检测到风险或异常活动时，可能要求在登录前输入**配对码**。流程如下：

1. 用户在手机上扫描二维码
2. 服务端返回 `need_verifycode`——手机屏幕上会显示一个数字验证码
3. `login()` 返回 `{ status: "need_verifycode", verifyCodePrompt }`——**你的前端必须获取用户输入**
4. 用户从手机上读取验证码并在 UI 中输入
5. 再次调用 `login()` 传入验证码：

```typescript
const result = await login(state, { verifyCode: userInput });

if (result.status === "success") {
  console.log("已连接！账号：", result.accountId);
} else if (result.status === "need_verifycode") {
  // 验证码错误——重新提示用户
  const retry = await promptUser(result.verifyCodePrompt!);
  // 使用新验证码重试
}
```

> 在 `need_verifycode` 返回后，二维码会话会被**保留**。无需生成新的二维码——用户已经扫过了。验证码与已经完成的扫码绑定。

### 多账号管理

一个 `ILinkAdapter` 实例可以管理多个机器人账号。每个账号拥有独立的长轮询循环：

```typescript
import { createILinkAdapter } from "@lanrenbang/chat-adapter-ilink";
import { login } from "@lanrenbang/chat-adapter-ilink";

const adapter = createILinkAdapter();

// 在 `bot.initialize()` 之后：
// 1. 登录（从 CLI/Web/Agent）
const result = await login(state, { onQRCode: console.log });

// 2. 向适配器注册账号
if (result.connected && result.botToken && result.accountId) {
  await adapter.addAccount(result.accountId, {
    token: result.botToken,
    baseUrl: result.baseUrl,
    userId: result.userId,
  });
  // 适配器会立即为此账号启动轮询循环
}
```

账号信息持久化在 StateAdapter 中，下次调用 `initialize()` 时会自动恢复。

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
| `pollingEnabled` | `boolean` | `true` | 设为 `false` 禁用自动轮询 |
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
chat.onSlashCommand("/echo", async ({ args, thread }) => {
  await thread.post({ text: `你说: ${args.join(" ")}` });
});
```

## 附件下载（传入媒体）

适配器会自动从传入消息中提取非文本项为 `Attachment[]`。每个附件包含：
- `type`：`image`、`audio`、`voice`、`video` 或 `file`
- `fetchData()`：下载并解密实际的媒体字节
- `fetchMetadata()`：返回 `{ fileName, mimeType, fileSize, width, height, duration, description }`

```typescript
adapter.on("message", async ({ thread, message }) => {
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
