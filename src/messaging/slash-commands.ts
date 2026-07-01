/**
 * Slash command detection and text extraction utilities.
 *
 * The slash command detection logic lives in adapter.ts handleInbound() —
 * it checks if the message text starts with "/" and routes to
 * chat.processSlashCommand() if so. This module provides the text
 * extraction utility used by that detection path.
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
