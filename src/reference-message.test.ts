import { describe, it, expect, vi } from "vitest";
import { ILinkAdapter } from "./adapter.js";
import { MessageItemType, MessageType, type CDNMedia, type WeixinMessage } from "./api/types.js";
import { buildRefMessageReq } from "./messaging/send.js";
import type { Attachment, Message } from "chat";

function createAdapter(): ILinkAdapter {
  return new ILinkAdapter();
}

function cdnMedia(overrides: Partial<CDNMedia> = {}): CDNMedia {
  return {
    encrypt_query_param: "enc_query_param_val",
    aes_key: "base64aeskey123",
    full_url: "https://cdn.example.com/file",
    ...overrides,
  };
}

function rawMsg(overrides: Partial<WeixinMessage> = {}): WeixinMessage {
  return {
    seq: 1001,
    message_id: 50001,
    from_user_id: "wx_user",
    to_user_id: "bot_abc",
    create_time_ms: Date.now(),
    message_type: MessageType.USER,
    message_state: 2,
    item_list: [],
    ...overrides,
  };
}

function parseMsg(adapter: ILinkAdapter, raw: WeixinMessage): Message<WeixinMessage> {
  return adapter.parseMessage(raw) as Message<WeixinMessage>;
}

// ─── extractQuotedContent ───────────────────────────────────────────────

describe("ILinkAdapter.extractQuotedContent", () => {
  it("returns null when message has no ref_msg (plain text)", () => {
    const adapter = createAdapter();
    const msg = parseMsg(adapter, rawMsg({
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: "Hello" } }],
    }));
    expect(adapter.extractQuotedContent(msg)).toBeNull();
  });

  it("returns null when message has no item_list", () => {
    const adapter = createAdapter();
    const raw = rawMsg();
    delete raw.item_list;
    const msg = parseMsg(adapter, raw);
    expect(adapter.extractQuotedContent(msg)).toBeNull();
  });

  it("extracts quoted text and title", () => {
    const adapter = createAdapter();
    const msg = parseMsg(adapter, rawMsg({
      item_list: [{
        type: MessageItemType.TEXT,
        text_item: { text: "This is my reply" },
        ref_msg: {
          title: "Original message title",
          message_item: {
            type: MessageItemType.TEXT,
            text_item: { text: "Original text" },
          },
        },
      }],
    }));
    const quoted = adapter.extractQuotedContent(msg);
    expect(quoted).not.toBeNull();
    expect(quoted!.text).toBe("Original text");
    expect(quoted!.title).toBe("Original message title");
    expect(quoted!.attachments).toEqual([]);
  });

  it("extracts quoted image with CDN media", () => {
    const adapter = createAdapter();
    const msg = parseMsg(adapter, rawMsg({
      item_list: [{
        type: MessageItemType.TEXT,
        text_item: { text: "Reply" },
        ref_msg: {
          title: "Photo",
          message_item: {
            type: MessageItemType.IMAGE,
            image_item: { media: cdnMedia(), aeskey: "aa".repeat(16) },
          },
        },
      }],
    }));
    const quoted = adapter.extractQuotedContent(msg);
    expect(quoted).not.toBeNull();
    expect(quoted!.attachments).toHaveLength(1);
    expect(quoted!.attachments[0].type).toBe("image");
    expect(quoted!.attachments[0].fetchData).toBeInstanceOf(Function);
    expect(quoted!.attachments[0].fetchMetadata?.encryptQueryParam).toBe("enc_query_param_val");
  });

  it("extracts quoted voice", () => {
    const adapter = createAdapter();
    const msg = parseMsg(adapter, rawMsg({
      item_list: [{
        type: MessageItemType.TEXT,
        text_item: { text: "Reply" },
        ref_msg: {
          message_item: {
            type: MessageItemType.VOICE,
            voice_item: { media: cdnMedia() },
          },
        },
      }],
    }));
    const quoted = adapter.extractQuotedContent(msg);
    expect(quoted).not.toBeNull();
    expect(quoted!.attachments).toHaveLength(1);
    expect(quoted!.attachments[0].type).toBe("audio");
    expect(quoted!.attachments[0].mimeType).toBe("audio/silk");
  });

  it("extracts quoted file with file_name", () => {
    const adapter = createAdapter();
    const msg = parseMsg(adapter, rawMsg({
      item_list: [{
        type: MessageItemType.TEXT,
        text_item: { text: "Reply" },
        ref_msg: {
          message_item: {
            type: MessageItemType.FILE,
            file_item: { media: cdnMedia(), file_name: "doc.pdf" },
          },
        },
      }],
    }));
    const quoted = adapter.extractQuotedContent(msg);
    expect(quoted).not.toBeNull();
    expect(quoted!.attachments).toHaveLength(1);
    expect(quoted!.attachments[0].type).toBe("file");
    expect(quoted!.attachments[0].name).toBe("doc.pdf");
  });

  it("extracts quoted video", () => {
    const adapter = createAdapter();
    const msg = parseMsg(adapter, rawMsg({
      item_list: [{
        type: MessageItemType.TEXT,
        text_item: { text: "Reply" },
        ref_msg: {
          message_item: {
            type: MessageItemType.VIDEO,
            video_item: { media: cdnMedia() },
          },
        },
      }],
    }));
    const quoted = adapter.extractQuotedContent(msg);
    expect(quoted).not.toBeNull();
    expect(quoted!.attachments).toHaveLength(1);
    expect(quoted!.attachments[0].type).toBe("video");
    expect(quoted!.attachments[0].mimeType).toBe("video/mp4");
  });

  it("returns the first ref_msg when multiple items have ref_msg", () => {
    const adapter = createAdapter();
    const msg = parseMsg(adapter, rawMsg({
      item_list: [
        {
          type: MessageItemType.TEXT,
          text_item: { text: "First quote" },
          ref_msg: {
            title: "First",
            message_item: { type: MessageItemType.TEXT, text_item: { text: "Alpha" } },
          },
        },
        {
          type: MessageItemType.TEXT,
          text_item: { text: "Second quote" },
          ref_msg: {
            title: "Second",
            message_item: { type: MessageItemType.TEXT, text_item: { text: "Beta" } },
          },
        },
      ],
    }));
    const quoted = adapter.extractQuotedContent(msg);
    expect(quoted).not.toBeNull();
    expect(quoted!.title).toBe("First");
    expect(quoted!.text).toBe("Alpha");
  });

  it("skips quoted items without message_item", () => {
    const adapter = createAdapter();
    const msg = parseMsg(adapter, rawMsg({
      item_list: [{
        type: MessageItemType.TEXT,
        text_item: { text: "Reply" },
        ref_msg: { title: "No item" },
      }],
    }));
    expect(adapter.extractQuotedContent(msg)).toBeNull();
  });

  it("returns null when quoted item type is not IMAGE/VOICE/FILE/VIDEO/TEXT", () => {
    const adapter = createAdapter();
    const msg = parseMsg(adapter, rawMsg({
      item_list: [{
        type: MessageItemType.TEXT,
        text_item: { text: "Reply" },
        ref_msg: {
          message_item: { type: 999 }, // unknown type
        },
      }],
    }));
    const quoted = adapter.extractQuotedContent(msg);
    expect(quoted).not.toBeNull();
    expect(quoted!.text).toBeUndefined();
    expect(quoted!.attachments).toEqual([]);
  });
});

// ─── replyToMessage ─────────────────────────────────────────────────────

describe("ILinkAdapter.replyToMessage", () => {
  it("throws when adapter is not initialized", async () => {
    const adapter = createAdapter();
    const raw = rawMsg({ item_list: [{ type: MessageItemType.TEXT, text_item: { text: "Hi" } }] });
    const msg = parseMsg(adapter, raw);
    await expect(adapter.replyToMessage("ilink:acct/target:target", "hello", { quotedMessage: msg }))
      .rejects.toThrow("ILinkAdapter not initialized");
  });
});

// ─── buildRefMessageReq (unit-level) ─────────────────────────────────────

describe("buildRefMessageReq", () => {
  const refItem = { type: MessageItemType.TEXT, text_item: { text: "Original" } };

  it("builds text-only ref request", () => {
    const req = buildRefMessageReq({
      to: "wx_user",
      refItem,
      text: "My reply",
      clientId: "client-1",
    });
    expect(req.msg?.to_user_id).toBe("wx_user");
    expect(req.msg?.item_list).toHaveLength(1);
    const item = req.msg!.item_list![0];
    expect(item.type).toBe(MessageItemType.TEXT);
    expect(item.text_item?.text).toBe("My reply");
    expect(item.ref_msg?.message_item).toEqual(refItem);
  });

  it("builds ref request with media items", () => {
    const mediaItem = { type: MessageItemType.IMAGE, image_item: { media: cdnMedia() } };
    const req = buildRefMessageReq({
      to: "wx_user",
      refItem,
      mediaItems: [mediaItem],
      clientId: "client-2",
    });
    expect(req.msg?.item_list).toHaveLength(2);
    expect(req.msg!.item_list![0].type).toBe(MessageItemType.TEXT);
    expect(req.msg!.item_list![0].ref_msg?.message_item).toEqual(refItem);
    expect(req.msg!.item_list![1].type).toBe(MessageItemType.IMAGE);
  });

  it("builds ref request with title", () => {
    const req = buildRefMessageReq({
      to: "wx_user",
      refItem,
      refTitle: "Quoted title",
      text: "Reply",
      clientId: "client-3",
    });
    expect(req.msg!.item_list![0].ref_msg?.title).toBe("Quoted title");
  });

  it("handles empty text for media-only ref replies", () => {
    const req = buildRefMessageReq({
      to: "wx_user",
      refItem,
      text: undefined,
      clientId: "client-4",
    });
    const item = req.msg!.item_list![0];
    expect(item.text_item).toBeUndefined();
    expect(item.ref_msg?.message_item).toEqual(refItem);
  });
});
