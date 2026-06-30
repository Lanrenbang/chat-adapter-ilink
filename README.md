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

iLink is an open protocol from WeChat individual-account bot system, originally open-sourced through the [OpenClaw](https://github.com/Tencent/openclaw-weixin) plugin. It uses QR-code authentication — there is no API key or token to paste. You **must provide a QR-code display mechanism** in your application (CLI, web UI, or any other frontend).

### LoginOptions

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `sessionKey` | `string` | auto-generated | Resume an existing login session |
| `force` | `boolean` | `false` | Skip QR cache and force new QR generation |
| `verifyCode` | `string` | — | Pairing/verify code (for `need_verifycode` flow) |
| `botType` | `string` | `"3"` | iLink bot type parameter |
| `timeoutMs` | `number` | `480000` (8 min) | Login timeout (minimum 1000ms). Only used in internal polling mode |
| `onStatusChange` | `(status, qrcodeUrl?, sessionKey) => void` | — | Callback for internal polling mode. When provided, `login()` polls internally and fires this on every status transition. When omitted, `login()` returns immediately |

### LoginResult

| Field | Type | Description |
|-------|------|-------------|
| `status` | `QRSessionStatus` | Raw upstream QR status (see below) |
| `qrcodeUrl` | `string \| undefined` | QR image URL for display |
| `sessionKey` | `string \| undefined` | Opaque token to resume this session |
| `message` | `string \| undefined` | Human-readable prompt or error description |

### QR status values

| Status | Meaning | Next action |
|--------|---------|-------------|
| `wait` | Waiting for user to scan QR | Display QR and wait |
| `scaned` | QR scanned by phone, awaiting confirmation | Wait |
| `confirmed` | User confirmed login on phone | ✅ **Login complete** — account auto-registered |
| `binded_redirect` | Already bound (valid token exists) | ✅ Treated as success — already connected |
| `expired` | QR code expired / login timed out | Generate new QR and retry |
| `need_verifycode` | Pairing/verify code required | Capture user input and call `login()` with `verifyCode` |
| `verify_code_blocked` | Too many incorrect verify codes | Wait and retry later |
| `scaned_but_redirect` | Scanned but IDC redirect needed | Transient — adapter handles automatically |

The adapter supports two login modes:

### Internal polling mode (with callback)

When you provide an `onStatusChange` callback, the adapter handles the entire login loop internally — QR generation, long-polling, expiry/redirect handling, and auto-registration on success. The callback fires on every status transition. The return value is informational only (status/message).

```typescript
import type { ILinkAdapter } from "@lanrenbang/chat-adapter-ilink";

const adapter = bot.getAdapter("ilink") as ILinkAdapter;

const result = await adapter.login({
  onStatusChange: (status, qrcodeUrl, sessionKey) => {
    switch (status) {
      case "wait":
        console.log("Scan this QR code in WeChat:", qrcodeUrl);
        break;
      case "scaned":
        console.log("QR scanned by phone, waiting for confirmation...");
        break;
      case "confirmed":
        console.log("Login confirmed!");
        break;
      case "need_verifycode":
        // See "Verify code flow" below
        break;
    }
  },
});
```

> **Note**: In this mode, the Promise resolves after login completes or reaches a terminal state. The `result.status` tells you the outcome, but the `onStatusChange` callback is the primary way to track progress.

### External polling mode (no callback)

Without `onStatusChange`, the first call generates a QR and returns immediately. The caller then polls by calling `login()` again with the `sessionKey`:

```typescript
import type { ILinkAdapter } from "@lanrenbang/chat-adapter-ilink";

const adapter = bot.getAdapter("ilink") as ILinkAdapter;

// Step 1: Initiate — get QR URL and sessionKey (returns immediately)
const first = await adapter.login();
// { qrcodeUrl: "...", sessionKey: "uuid-xxx", status: "wait", message: "..." }

// Step 2: Poll until terminal status
let result = first;
while (result.status === "wait" || result.status === "scaned" || result.status === "scaned_but_redirect") {
  result = await adapter.login({ sessionKey: result.sessionKey });
  await sleep(1000); // 1s interval — upstream long-poll already blocks 35s
}

if (result.status === "confirmed") {
  console.log("Login successful — account auto-registered");
}
```

This mode is ideal for HTTP API scenarios where the backend issues a session and the frontend handles the polling loop.

### Verify code flow (pairing code)

When WeChat detects risk, it may require a **pairing/verify code** (`status === "need_verifycode"`). The flow works the same in both modes:

1. `adapter.login()` returns with `{ status: "need_verifycode", message, sessionKey }`
2. Your application captures the code from the user's phone screen
3. Call `adapter.login()` again with **both** `sessionKey` and `verifyCode`

**External polling mode (no callback)** — natural: you're already in a loop:

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

**Internal polling mode (with callback)** — wrap login in a recursive function that preserves the callback:

```typescript
async function loginWithVerifyCode(sessionKey?: string, verifyCode?: string) {
  const result = await adapter.login({
    sessionKey,
    verifyCode,
    onStatusChange: (status, _url, sk) => {
      if (status === "need_verifycode") {
        // Prompt user asynchronously, then recurse
        promptUser(result.message!).then((code) =>
          loginWithVerifyCode(sk, code),
        );
      }
    },
  });
  return result;
}

// First call — no sessionKey yet
const result = await loginWithVerifyCode();
```

> **Must pass `sessionKey`** when retrying—otherwise a new QR is generated and a new session starts. The QR from the original scan is still valid and tied to that `sessionKey`.

### Session key persistence

Each login session is stored in the `StateAdapter` with a 5-minute TTL. Subsequent calls with the same `sessionKey` resume the existing session (across both modes).

### Multi-account

The adapter supports multiple accounts — each `login()` call creates an independent session. Accounts are automatically registered for message polling on `confirmed`.

### Cloudflare Agent integration

For guidance on using this adapter inside a Cloudflare Agent (Agents SDK) with the Sub-Agent pattern for per-session login state isolation, auto-created sessions via `onBeforeSubAgent`, and callback-based polling, see [docs/integration.md](./docs/integration.md).

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
bot.onSlashCommand("/echo", async ({ args, thread }) => {
  await thread.post({ text: `You said: ${args.join(" ")}` });
});
```

## Attachment download (incoming media)

The adapter automatically extracts non-text items from incoming messages as `Attachment[]`. Each attachment carries:
- `type`: `image`, `audio`, `voice`, `video`, or `file`
- `fetchData()`: downloads and decrypts the actual media bytes
- `fetchMetadata()`: returns `{ fileName, mimeType, fileSize, width, height, duration, description }`

```typescript
bot.onNewMessage(async (thread, message) => {
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
import type { ILinkAdapter } from "@lanrenbang/chat-adapter-ilink";

const adapter = bot.getAdapter("ilink") as ILinkAdapter;
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
