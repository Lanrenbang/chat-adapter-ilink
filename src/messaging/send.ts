/**
 * Message sending functions for iLink protocol.
 * Ported from openclaw-weixin src/messaging/send.ts.
 */
import { sendMessage as sendMessageApi } from "../api/api.js";
import type { WeixinApiOptions } from "../api/api.js";
import { generateId } from "../util/random.js";
import type { MessageItem, SendMessageReq } from "../api/types.js";
import { MessageItemType, MessageState, MessageType } from "../api/types.js";

function generateClientId(): string {
  return generateId("ilink");
}

/** Build a SendMessageReq containing a single text message. */
function buildTextMessageReq(params: {
  to: string;
  text: string;
  contextToken?: string;
  clientId: string;
}): SendMessageReq {
  const { to, text, contextToken, clientId } = params;
  const item_list: MessageItem[] = text
    ? [{ type: MessageItemType.TEXT, text_item: { text } }]
    : [];
  return {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: item_list.length ? item_list : undefined,
      context_token: contextToken ?? undefined,
    },
  };
}

/**
 * Send a plain text message downstream.
 */
export async function sendMessageWeixin(params: {
  to: string;
  text: string;
  opts: WeixinApiOptions & { contextToken?: string };
}): Promise<{ messageId: string }> {
  const { to, text, opts } = params;
  if (!opts.contextToken) {
    console.debug(`sendMessageWeixin: contextToken missing for to=${to}, sending without context`);
  }
  const clientId = generateClientId();
  const req = buildTextMessageReq({
    to,
    contextToken: opts.contextToken,
    text,
    clientId,
  });
  try {
    await sendMessageApi({
      baseUrl: opts.baseUrl,
      token: opts.token,
      timeoutMs: opts.timeoutMs,
      body: req,
    });
  } catch (err) {
    console.error(`sendMessageWeixin: failed to=${to} clientId=${clientId} err=${String(err)}`);
    throw err;
  }
  return { messageId: clientId };
}

export function buildRefMessageReq(params: {
  to: string;
  refItem: MessageItem;
  refTitle?: string;
  text?: string;
  mediaItems?: MessageItem[];
  contextToken?: string;
  clientId: string;
}): SendMessageReq {
  const { to, refItem, refTitle, text, mediaItems, contextToken, clientId } = params;

  const textItem: MessageItem = {
    type: MessageItemType.TEXT,
    ref_msg: {
      message_item: refItem,
      title: refTitle,
    },
  };
  if (text) {
    textItem.text_item = { text };
  }

  const item_list: MessageItem[] = [textItem];

  if (mediaItems?.length) {
    item_list.push(...mediaItems);
  }

  return {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list,
      context_token: contextToken ?? undefined,
    },
  };
}

export async function sendRefMessageWeixin(params: {
  to: string;
  refItem: MessageItem;
  refTitle?: string;
  text?: string;
  mediaItems?: MessageItem[];
  opts: WeixinApiOptions & { contextToken?: string };
}): Promise<{ messageId: string }> {
  const { to, refItem, refTitle, text, mediaItems, opts } = params;
  const clientId = generateClientId();
  const req = buildRefMessageReq({
    to,
    refItem,
    refTitle,
    text,
    mediaItems,
    contextToken: opts.contextToken,
    clientId,
  });
  try {
    await sendMessageApi({
      baseUrl: opts.baseUrl,
      token: opts.token,
      timeoutMs: opts.timeoutMs,
      body: req,
    });
  } catch (err) {
    console.error(`sendRefMessageWeixin: failed to=${to} clientId=${clientId} err=${String(err)}`);
    throw err;
  }
  return { messageId: clientId };
}
