/**
 * Slash command detection helpers.
 *
 * This module provides ONLY detection utilities — it does NOT handle
 * slash commands. All messages (including those starting with "/")
 * MUST be routed through chat.processMessage() so that the Chat SDK's
 * onSlashCommand handler can process them.
 *
 * Why:
 *   The upstream openclaw-weixin handles /echo and /toggle-debug
 *   internally and returns early, bypassing AI processing. In this
 *   adapter, message routing is the Chat SDK's responsibility.
 *   Users implement slash command logic via:
 *     bot.onSlashCommand("/echo", async (event) => { ... });
 *
 * Reusable from upstream: extractTextBody()
 *   Use this to extract plain text from a WeixinMessage for
 *   slash command detection or any text-based routing.
 */
import { MessageItemType } from "../api/types.js";
import type { WeixinMessage } from "../api/types.js";

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
