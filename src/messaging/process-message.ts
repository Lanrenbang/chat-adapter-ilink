/**
 * Inbound message processing for chat-adapter-ilink.
 *
 * Transforms raw WeixinMessage to Chat SDK Message and dispatches it
 * to the Chat SDK pipeline. Much simpler than the upstream OpenClaw
 * version (process-message.ts) — no plugin SDK, no auth pipeline,
 * no reply dispatcher — those are handled by Chat SDK.
 */
import type { StateAdapter, Adapter, ChatInstance } from "chat";
import { Message } from "chat";
import { MessageItemType, MessageType } from "../api/types.js";
import type { WeixinMessage } from "../api/types.js";

const CTX_KEY_PREFIX = "ilink:ctx:";

function contextTokenKey(accountId: string, userId: string): string {
  return `${CTX_KEY_PREFIX}${accountId}:${userId}`;
}

/** Get a context_token for a user. */
export async function getContextToken(
  state: StateAdapter,
  accountId: string,
  userId: string,
): Promise<string | undefined> {
  const token = await state.get<string>(contextTokenKey(accountId, userId));
  return token ?? undefined;
}

/** Store a context_token for a user. */
export async function setContextToken(
  state: StateAdapter,
  accountId: string,
  userId: string,
  token: string,
): Promise<void> {
  if (token) {
    await state.set(contextTokenKey(accountId, userId), token);
  }
}

/** Extract text body from item_list (for slash command detection). */
export function extractTextBody(itemList?: WeixinMessage["item_list"]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      return String(item.text_item.text);
    }
  }
  return "";
}

/** Build a unique message ID from a WeixinMessage. */
export function buildMessageId(raw: WeixinMessage): string {
  return `${raw.seq ?? raw.message_id ?? Date.now()}`;
}

/** Get the user-facing user ID from a message. */
export function getMessageUserId(raw: WeixinMessage): string {
  return raw.from_user_id ?? "";
}

/** Check if a message was sent by the bot itself. */
export function isBotMessage(raw: WeixinMessage): boolean {
  return raw.message_type === MessageType.BOT;
}

/** Create a unique client ID for deduplication. */
export function createClientId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Encode a thread ID from accountId and userId. */
export function encodeThreadId(accountId: string, userId: string): string {
  return `ilink:${accountId}:${userId}`;
}

/** Decode a thread ID into accountId and userId. */
export function decodeThreadId(threadId: string): { accountId: string; userId: string } {
  const firstColon = threadId.indexOf(":");
  if (firstColon === -1) throw new Error(`Invalid thread ID: ${threadId}`);
  const prefix = threadId.slice(0, firstColon);
  if (prefix !== "ilink") throw new Error(`Invalid thread ID: ${threadId}`);

  const secondColon = threadId.indexOf(":", firstColon + 1);
  if (secondColon === -1) throw new Error(`Invalid thread ID: ${threadId}`);

  const accountId = threadId.slice(firstColon + 1, secondColon);
  if (!accountId) throw new Error(`Invalid thread ID: ${threadId}`);

  const userId = threadId.slice(secondColon + 1);
  if (!userId) throw new Error(`Invalid thread ID: ${threadId}`);

  return { accountId, userId };
}

/**
 * Process an inbound WeixinMessage: store context_token,
 * then dispatch to Chat SDK.
 *
 * All messages (including slash commands) are routed through
 * chat.processMessage(). The Chat SDK's onSlashCommand handler
 * is the standard way to respond to /commands — see slash-commands.ts
 * for the detection helper (extractTextBody) if custom pre-routing
 * is needed.
 */
export async function processInboundMessage(
  raw: WeixinMessage,
  accountId: string,
  state: StateAdapter,
  chat: ChatInstance,
  adapter: Adapter,
): Promise<void> {
  const userId = getMessageUserId(raw);
  if (!userId) return;

  if (raw.context_token) {
    await setContextToken(state, accountId, userId, raw.context_token);
  }

  const threadId = encodeThreadId(accountId, userId);
  const message = adapter.parseMessage(raw);

  await chat.processMessage(adapter, threadId, () => Promise.resolve(message));
}
