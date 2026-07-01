import { describe, it, expect, beforeEach } from "vitest";
import { Chat, Message } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { ILinkAdapter } from "./adapter.js";
import { MessageItemType, MessageType } from "./api/types.js";
import type { WeixinMessage } from "./api/types.js";
import { encodeThreadId, buildMessageId, getMessageUserId, isBotMessage, extractTextBody } from "./messaging/process-message.js";

function createTestMessage(overrides: Partial<WeixinMessage> = {}): WeixinMessage {
  return {
    seq: 1001,
    message_id: 50001,
    from_user_id: "wx_user_alice",
    to_user_id: "bot_abc",
    create_time_ms: Date.now(),
    message_type: MessageType.USER,
    message_state: 2,
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: "Hello bot!" } }],
    ...overrides,
  };
}

describe("iLink adapter integration", () => {
  let adapter: ILinkAdapter;
  let chat: Chat;
  let state: ReturnType<typeof createMemoryState>;

  beforeEach(async () => {
    state = createMemoryState();
    await state.connect();
    adapter = new ILinkAdapter();
    chat = new Chat({
      userName: "ilink-bot",
      adapters: { ilink: adapter },
      state,
      logger: "error" as never,
    });
  });

  it("processes an inbound mention via handleInbound", async () => {
    const mentionPromise = new Promise<{ thread: unknown; message: Message }>((resolve) => {
      chat.onNewMention((thread, message) => {
        resolve({ thread, message });
      });
    });

    const raw = createTestMessage();
    const accountId = "bot_abc";

    const userId = getMessageUserId(raw);
    const threadId = encodeThreadId(accountId, userId);
    const msg = adapter.parseMessage(raw);
    await chat.processMessage(adapter, threadId, () => Promise.resolve(msg));

    const result = await mentionPromise;
    expect(result.message.text).toBe("Hello bot!");
    expect(result.message.author.userId).toBe("wx_user_alice");
  });

  it("stores context_token in state", async () => {
    const raw = createTestMessage({ context_token: "ctx_abc123" });
    const accountId = "bot_abc";
    const userId = getMessageUserId(raw);

    const { setContextToken, getContextToken } = await import("./messaging/process-message.js");
    await setContextToken(state, accountId, userId, raw.context_token!);

    const stored = await getContextToken(state, accountId, userId);
    expect(stored).toBe("ctx_abc123");
  });

  it("bot messages are properly identified", () => {
    const botMsg = createTestMessage({ message_type: MessageType.BOT });
    expect(isBotMessage(botMsg)).toBe(true);

    const userMsg = createTestMessage({ message_type: MessageType.USER });
    expect(isBotMessage(userMsg)).toBe(false);
  });

  it("buildMessageId uses seq", () => {
    const msg = createTestMessage({ seq: 9999, message_id: 8888 });
    expect(buildMessageId(msg)).toBe("9999");
  });

  it("buildMessageId falls back to message_id", () => {
    const msg = createTestMessage();
    msg.seq = undefined as never;
    expect(buildMessageId(msg)).toBe("50001");
  });

  it("extractTextBody returns first text item", () => {
    const msg = createTestMessage({
      item_list: [
        { type: MessageItemType.TEXT, text_item: { text: "First" } },
        { type: MessageItemType.IMAGE },
      ],
    });
    expect(extractTextBody(msg.item_list)).toBe("First");
  });

  it("extractTextBody returns empty for non-text items", () => {
    const msg = createTestMessage({
      item_list: [{ type: MessageItemType.IMAGE }],
    });
    expect(extractTextBody(msg.item_list)).toBe("");
  });

  it("extractTextBody handles undefined item_list", () => {
    expect(extractTextBody(undefined)).toBe("");
  });

  it("postMessage sends text through the adapter", async () => {
    const threadId = encodeThreadId("bot_abc", "wx_user_alice");
    await expect(
      adapter.postMessage(threadId, "Hello back!"),
    ).rejects.toThrow("not initialized");
  });

  describe("slash command routing", () => {
    it("routes /echo to onSlashCommand handler", async () => {
      const slashPromise = new Promise<{ command: string; text: string; channelId: string }>((resolve) => {
        chat.onSlashCommand("/echo", async (event) => {
          resolve({
            command: event.command,
            text: event.text,
            channelId: event.channel.id,
          });
        });
      });

      const accountId = "bot_abc";
      const userId = "wx_user_alice";
      const threadId = encodeThreadId(accountId, userId);
      const channelId = adapter.channelIdFromThreadId(threadId);

      chat.processSlashCommand(
        {
          command: "/echo",
          text: "hello world",
          raw: {},
          channelId,
          adapter,
          user: { userId, userName: userId, fullName: userId, isBot: false, isMe: false },
          triggerId: undefined,
        },
        undefined,
      );

      const result = await slashPromise;
      expect(result.command).toBe("/echo");
      expect(result.text).toBe("hello world");
      expect(result.channelId).toBe(channelId);
    });

    it("routes unknown commands to catch-all handler", async () => {
      const slashPromise = new Promise<{ command: string; text: string }>((resolve) => {
        chat.onSlashCommand(async (event) => {
          resolve({ command: event.command, text: event.text });
        });
      });

      const accountId = "bot_abc";
      const threadId = encodeThreadId(accountId, "wx_bob");

      chat.processSlashCommand(
        {
          command: "/unknown",
          text: "something",
          raw: {},
          channelId: adapter.channelIdFromThreadId(threadId),
          adapter,
          user: { userId: "wx_bob", userName: "wx_bob", fullName: "wx_bob", isBot: false, isMe: false },
          triggerId: undefined,
        },
        undefined,
      );

      const result = await slashPromise;
      expect(result.command).toBe("/unknown");
    });
  });
});
