# @lanrenbang/chat-adapter-ilink

[![npm version](https://img.shields.io/npm/v/@lanrenbang/chat-adapter-ilink)](https://www.npmjs.com/package/@lanrenbang/chat-adapter-ilink)
[![npm downloads](https://img.shields.io/npm/dm/@lanrenbang/chat-adapter-ilink)](https://www.npmjs.com/package/@lanrenbang/chat-adapter-ilink)

Weixin (WeChat) iLink bot adapter for [Chat SDK](https://chat-sdk.dev). Uses the official iLink protocol for QR-code based bot login and long-poll message delivery.

**Note**: This is a community adapter. Weixin does not expose webhook endpoints — the adapter uses long-polling (`getUpdates`) for message delivery.

## Installation

```bash
npm install chat @lanrenbang/chat-adapter-ilink
```

## Quick start

The adapter manages one or more iLink bot accounts. Each account logs in via QR scan on WeChat and maintains its own long-poll loop.

```typescript
import { Chat } from "chat";
import { createILinkAdapter } from "@lanrenbang/chat-adapter-ilink";
import { createMemoryState } from "@chat-adapter/state-memory";

const bot = new Chat({
  userName: "ilink-bot",
  adapters: {
    ilink: createILinkAdapter(),
  },
  state: createMemoryState(), // required for QR session + account persistence
});

bot.onNewMention(async (thread, message) => {
  await thread.post(`收到消息: ${message.text}`);
});
```

The adapter auto-detects `ILINK_BOT_TOKEN`, `ILINK_BASE_URL`, and `ILINK_CDN_BASE_URL` from environment variables when configured.

## Authentication

iLink is an open protocol from WeChat individual-account bot system, originally open-sourced through the [OpenClaw](https://github.com/Tencent/openclaw-weixin) plugin. It uses QR-code authentication — there is no API key or token to paste. You **must provide a QR-code display mechanism** in your application (CLI, web UI, or any other frontend). The adapter's `login()` function accepts an `onQRCode` callback for this purpose:

```typescript
import { login } from "@lanrenbang/chat-adapter-ilink";

const result = await login(state, {
  onQRCode: (qrCodeUrl: string) => {
    // Render the QR code image in your UI:
    // - CLI: Print the URL for manual display
    // - Web: Render <img src={qrCodeUrl} />
    // - Agent: Return the URL in a message
    console.log("Scan this QR code in WeChat:", qrCodeUrl);
  },
});
```

### Pairing code (verify code) flow

When WeChat detects risk or unusual activity, it may require a **pairing code** before completing login. The flow is:

1. User scans QR on their phone
2. Server returns `need_verifycode` — a numeric code appears on the user's phone screen
3. `login()` returns `{ status: "need_verifycode", verifyCodePrompt }` — **your frontend must capture user input**
4. User reads the code from their phone and types it into your UI
5. Call `login()` again with the code:

```typescript
const result = await login(state, { verifyCode: userInput });

if (result.status === "success") {
  console.log("Connected! Account:", result.accountId);
} else if (result.status === "need_verifycode") {
  // Wrong code — show prompt again
  const retry = await promptUser(result.verifyCodePrompt!);
  // retry with new code
}
```

> The QR session is **preserved** across `need_verifycode` returns. Do not generate a new QR code — the user has already scanned it. The verify code is tied to the existing scan.

### Multi-account management

An `ILinkAdapter` instance can manage multiple bot accounts. Each account has its own long-poll loop:

```typescript
import { createILinkAdapter } from "@lanrenbang/chat-adapter-ilink";
import { login } from "@lanrenbang/chat-adapter-ilink";

const adapter = createILinkAdapter();

// After `bot.initialize()`:
// 1. Login (from CLI/web/agent)
const result = await login(state, { onQRCode: console.log });

// 2. Register the account with the adapter
if (result.connected && result.botToken && result.accountId) {
  await adapter.addAccount(result.accountId, {
    token: result.botToken,
    baseUrl: result.baseUrl,
    userId: result.userId,
  });
  // The adapter immediately starts a poll loop for this account
}
```

Accounts persist in the StateAdapter and are restored automatically on next `initialize()`.

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseUrl` | `string` | `https://ilinkai.weixin.qq.com` | iLink API base URL |
| `cdnBaseUrl` | `string` | `https://novac2c.cdn.weixin.qq.com/c2c` | CDN base URL for media upload |
| `longPollTimeoutMs` | `number` | `35000` | Long-poll timeout for `getUpdates` |
| `botAgent` | `string` | `"OpenClaw"` | Self-declared bot agent string (UA-style) |
| `routeTag` | `string` | — | Route tag for multi-region routing |
| `userName` | `string` | `"ilink-bot"` | Bot display name |
| `logger` | `Logger` | `ConsoleLogger("info")` | Custom logger |
| `pollingEnabled` | `boolean` | `true` | Set to `false` to skip auto-polling |
| `state` | `StateAdapter` | — | State adapter (required for QR sessions + multi-account) |

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ILINK_BOT_TOKEN` | No | Default bot token (set via `addAccount` at runtime instead) |
| `ILINK_BASE_URL` | No | Override the iLink API base URL |
| `ILINK_CDN_BASE_URL` | No | Override the CDN base URL |

## Feature support

| Feature | Supported |
|---------|-----------|
| Post text messages | Yes |
| File uploads (images, audio, video, files) | Yes (via CDN, `thread.post({ attachments })`) |
| Attachment download (parse incoming non-text) | Yes (`message.attachments[].fetchData()`) |
| Voice → text transcription | Yes (`adapter.transcribeVoice(buffer)`) |
| Typing indicators | Yes |
| Direct messages (1:1 only) | Yes |
| Custom API endpoint | Yes (configurable `baseUrl`) |
| Fetch thread info | Yes |
| Reference messages (quoted replies) | Yes (`adapter.replyToMessage()` / `adapter.extractQuotedContent()`) |
| Edit / delete messages | No (Weixin limitation) |
| Streaming / AI streaming | No |
| Scheduled messages | No |
| Cards, buttons, select menus, modals | No (Weixin renders all content as plain text) |
| Reactions | No (Weixin limitation) |
| Slash commands | Yes (via Chat SDK `onSlashCommand`) |
| Mentions (multi-user) | No (1:1 only — all messages are DMs) |
| Group chats / channels | No (1:1 only) |
| Ephemeral messages | No |
| Fetch messages history | No (API does not expose history) |
| List threads | No |
| Message formatting | No (all markdown is flattened to plain text) |

## Thread ID format

```
ilink:{accountId}:{userId}
```

- `ilink:bot_abc123:wx_user_xyz` — DM thread with user `wx_user_xyz` via account `bot_abc123`

## Media upload

Media (images, audio, video, files) is uploaded to the Weixin CDN with AES-128-ECB encryption before sending. Use `thread.post({ attachments: [...] })` — the adapter handles CDN upload and message sending internally:

```typescript
await thread.post({
  markdown: "Check this out",
  attachments: [
    { type: "image", data: imageBuffer, mimeType: "image/jpeg" },
    { type: "file", data: pdfBuffer, fileName: "report.pdf" },
  ],
});
```

Supported attachment types: `image`, `audio`, `voice`, `video`, `file`. You do not need to call separate upload functions — `thread.post()` handles everything.

## Slash commands

Messages starting with `/` are routed to the Chat SDK's `onSlashCommand` handler automatically. No extra configuration is needed in the adapter — just set up your bot:

```typescript
chat.onSlashCommand("/echo", async ({ args, thread }) => {
  await thread.post({ text: `You said: ${args.join(" ")}` });
});
```

## Attachment download (incoming media)

The adapter automatically extracts non-text items from incoming messages as `Attachment[]`. Each attachment carries:
- `type`: `image`, `audio`, `voice`, `video`, or `file`
- `fetchData()`: downloads and decrypts the actual media bytes
- `fetchMetadata()`: returns `{ fileName, mimeType, fileSize, width, height, duration, description }`

```typescript
adapter.on("message", async ({ thread, message }) => {
  for (const attachment of message.attachments ?? []) {
    const buf = await attachment.fetchData();
    const meta = await attachment.fetchMetadata();
    // buf: Uint8Array with decrypted media bytes
    // meta: { fileName, mimeType, ... }
  }
});
```

Voice messages can be converted to text via the adapter's public method:

```typescript
const adapter = bot.getAdapter("ilink");
const wav = await adapter.transcribeVoice(silkBuffer);
// Returns WAV Buffer, or null if silk-wasm is unavailable
```

## Send files without media type

For generic file uploads without specifying a media type, use `files`:

```typescript
await thread.post({
  markdown: "Here's the report:",
  files: [{ data: pdfBuffer, filename: "report.pdf", mimeType: "application/pdf" }],
});
```

`files` always uploads as documents, while `attachments` preserve the media type (image/audio/video).

## Reference messages (quoted replies)

Weixin supports **引用消息** (reference messages) — replies that quote a previous message. The adapter exposes both receiving and sending sides.

### Receiving: Extract quoted content

`adapter.extractQuotedContent(message)` extracts the quoted message data from an incoming message:

```typescript
bot.onNewMessage(async (thread, message) => {
  const adapter = bot.getAdapter("ilink") as ILinkAdapter;
  const quoted = adapter.extractQuotedContent(message);

  if (quoted) {
    console.log("Quoted title:", quoted.title);
    console.log("Quoted text:", quoted.text);
    // quoted.attachments — media from the quoted message
    for (const att of quoted.attachments) {
      const data = await att.fetchData();
    }
  }
});
```

Returns `null` when there is no quote. The quoted content object contains:
- `text?` — quoted text (if the referenced message was text)
- `attachments` — array of `Attachment` objects for quoted media (image/audio/video/file)
- `title?` — quote summary/title from Weixin

> The quoted text is also embedded in the main `message.text` with a `[引用: ...]` prefix for LLM context. Use `extractQuotedContent` when you need precise separation.

### Sending: Reply with a quote

`adapter.replyToMessage(threadId, content, options)` sends a reply that quotes the original message:

```typescript
bot.onNewMessage(async (thread, message) => {
  const adapter = bot.getAdapter("ilink") as ILinkAdapter;

  // Text reply with quote
  await adapter.replyToMessage(
    message.threadId,
    "Thanks for the info!",
    { quotedMessage: message },
  );

  // Media reply with quote (sends TEXT(ref_msg) + MEDIA items)
  await adapter.replyToMessage(
    message.threadId,
    { attachments: [{ type: "image", data: imageBuf }] },
    { quotedMessage: message },
  );
});
```

This uses the Weixin `ref_msg` protocol internally — the reply is sent as a `TEXT` item carrying the quoted `message_item`, followed by optional media items.

## Reference projects

- [**Tencent/openclaw-weixin**](https://github.com/Tencent/openclaw-weixin) — The official open-source iLink protocol implementation by Weixin/WeChat team. The upstream project this adapter is based on.
- [**wong2/chat-adapter-weixin**](https://github.com/wong2/chat-adapter-weixin) — The original community Chat SDK adapter for Weixin. This adapter replaces it with an updated architecture aligned to the openclaw-weixin upstream.

## AI Coding Agents

If you use an AI coding agent such as OpenAI Codex, Claude Code, or Cursor, install the Chat SDK skill:

```bash
npx skills add vercel/chat
```

For agent-readable documentation, see [chat-sdk.dev/llms.txt](https://chat-sdk.dev/llms.txt).

## License

MIT
