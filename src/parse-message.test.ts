import { describe, it, expect, vi } from "vitest";
import { ILinkAdapter } from "./adapter.js";
import { MessageItemType, MessageType, type CDNMedia, type ImageItem, type VoiceItem, type FileItem, type VideoItem, type WeixinMessage } from "./api/types.js";
import type { Attachment } from "chat";

function createAdapter(): ILinkAdapter {
  return new ILinkAdapter();
}

function textMsg(overrides: Partial<WeixinMessage> = {}): WeixinMessage {
  return {
    seq: 1001,
    message_id: 50001,
    from_user_id: "wx_user_alice",
    to_user_id: "bot_abc",
    create_time_ms: Date.now(),
    message_type: MessageType.USER,
    message_state: 2,
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: "Hello world" } }],
    ...overrides,
  };
}

function cdnMedia(overrides: Partial<CDNMedia> = {}): CDNMedia {
  return {
    encrypt_query_param: "enc_query_param_val",
    aes_key: "base64aeskey123",
    full_url: "https://cdn.example.com/file",
    ...overrides,
  };
}

describe("ILinkAdapter.parseMessage", () => {
  it("parses a plain text message", () => {
    const adapter = createAdapter();
    const raw = textMsg();
    const msg = adapter.parseMessage(raw);

    expect(msg.id).toBe("1001");
    expect(msg.text).toBe("Hello world");
    expect(msg.author.userId).toBe("wx_user_alice");
    expect(msg.author.isBot).toBe(false);
    expect(msg.author.isMe).toBe(false);
  });

  it("detects bot messages", () => {
    const adapter = createAdapter();
    const raw = textMsg({ message_type: MessageType.BOT });
    const msg = adapter.parseMessage(raw);

    expect(msg.author.isBot).toBe(true);
    expect(msg.author.isMe).toBe(true);
  });

  it("uses from_user_id as author for bot messages", () => {
    const adapter = createAdapter();
    const raw = textMsg({
      message_type: MessageType.BOT,
      from_user_id: "bot_abc",
      to_user_id: "wx_user_alice",
    });
    const msg = adapter.parseMessage(raw);
    expect(msg.author.userId).toBe("bot_abc");
    expect(msg.author.isMe).toBe(true);
  });

  it("extracts text from first text item", () => {
    const adapter = createAdapter();
    const raw = textMsg({
      item_list: [
        { type: MessageItemType.TEXT, text_item: { text: "First" } },
        { type: MessageItemType.TEXT, text_item: { text: "Second" } },
      ],
    });
    const msg = adapter.parseMessage(raw);
    expect(msg.text).toBe("First");
  });

  it("returns empty text when no text items", () => {
    const adapter = createAdapter();
    const raw = textMsg({ item_list: [] });
    const msg = adapter.parseMessage(raw);
    expect(msg.text).toBe("");
  });

  it("handles undefined item_list", () => {
    const adapter = createAdapter();
    const raw = textMsg();
    delete raw.item_list;
    const msg = adapter.parseMessage(raw);
    expect(msg.text).toBe("");
  });

  it("uses seq as message id", () => {
    const adapter = createAdapter();
    const raw = textMsg({ seq: 9999, message_id: 8888 });
    const msg = adapter.parseMessage(raw);
    expect(msg.id).toBe("9999");
  });

  it("falls back to message_id when seq is undefined", () => {
    const adapter = createAdapter();
    const raw = textMsg();
    raw.seq = undefined as never;
    const msg = adapter.parseMessage(raw);
    expect(msg.id).toBe("50001");
  });

  it("sets thread ID format ilink:accountId/userId:userId", () => {
    const adapter = createAdapter();
    const raw = textMsg();
    const msg = adapter.parseMessage(raw);
    expect(msg.threadId).toMatch(/^ilink:/);
    expect(msg.threadId).toContain("wx_user_alice");
  });

  it("formats text via format converter", () => {
    const adapter = createAdapter();
    const raw = textMsg({ item_list: [{ type: MessageItemType.TEXT, text_item: { text: "**bold**" } }] });
    const msg = adapter.parseMessage(raw);
    // format converter strips markdown to plain text
    expect(msg.text).toBe("**bold**");
  });

  it("sets dateSent from create_time_ms", () => {
    const adapter = createAdapter();
    const ts = 1700000000000;
    const raw = textMsg({ create_time_ms: ts });
    const msg = adapter.parseMessage(raw);
    expect(msg.metadata?.dateSent).toBeInstanceOf(Date);
    expect((msg.metadata!.dateSent as Date).getTime()).toBe(ts);
  });

  describe("attachment extraction", () => {
    it("extracts image attachments", () => {
      const adapter = createAdapter();
      const raw = textMsg({
        item_list: [
          {
            type: MessageItemType.IMAGE,
            image_item: {
              media: cdnMedia(),
              aeskey: "aa".repeat(16), // 16 hex bytes
            },
          },
        ],
      });
      const msg = adapter.parseMessage(raw);
      expect(msg.attachments).toHaveLength(1);
      const att = msg.attachments![0];
      expect(att.type).toBe("image");
      expect(att.mimeType).toBe("image/*");
      expect(att.fetchData).toBeInstanceOf(Function);
      expect(att.fetchMetadata).toBeDefined();
      expect(att.fetchMetadata?.encryptQueryParam).toBe("enc_query_param_val");
    });

    it("skips image items without CDN media", () => {
      const adapter = createAdapter();
      const raw = textMsg({
        item_list: [
          {
            type: MessageItemType.IMAGE,
            image_item: {} as ImageItem,
          },
        ],
      });
      const msg = adapter.parseMessage(raw);
      expect(msg.attachments).toHaveLength(0);
    });

    it("extracts voice attachments", () => {
      const adapter = createAdapter();
      const raw = textMsg({
        item_list: [
          {
            type: MessageItemType.VOICE,
            voice_item: { media: cdnMedia() } as VoiceItem,
          },
        ],
      });
      const msg = adapter.parseMessage(raw);
      expect(msg.attachments).toHaveLength(1);
      const att = msg.attachments![0];
      expect(att.type).toBe("audio");
      expect(att.mimeType).toBe("audio/silk");
      expect(att.fetchData).toBeInstanceOf(Function);
      expect(att.fetchMetadata?.mediaType).toBe("voice");
    });

    it("skips voice items without aes_key", () => {
      const adapter = createAdapter();
      const raw = textMsg({
        item_list: [
          {
            type: MessageItemType.VOICE,
            voice_item: { media: {} } as VoiceItem,
          },
        ],
      });
      const msg = adapter.parseMessage(raw);
      expect(msg.attachments).toHaveLength(0);
    });

    it("extracts file attachments", () => {
      const adapter = createAdapter();
      const raw = textMsg({
        item_list: [
          {
            type: MessageItemType.FILE,
            file_item: { media: cdnMedia(), file_name: "report.pdf" } as FileItem,
          },
        ],
      });
      const msg = adapter.parseMessage(raw);
      expect(msg.attachments).toHaveLength(1);
      const att = msg.attachments![0];
      expect(att.type).toBe("file");
      expect(att.name).toBe("report.pdf");
      expect(att.fetchMetadata?.fileName).toBe("report.pdf");
    });

    it("extracts video attachments", () => {
      const adapter = createAdapter();
      const raw = textMsg({
        item_list: [
          {
            type: MessageItemType.VIDEO,
            video_item: { media: cdnMedia() } as VideoItem,
          },
        ],
      });
      const msg = adapter.parseMessage(raw);
      expect(msg.attachments).toHaveLength(1);
      const att = msg.attachments![0];
      expect(att.type).toBe("video");
      expect(att.mimeType).toBe("video/mp4");
    });

    it("handles mixed text and media items", () => {
      const adapter = createAdapter();
      const raw = textMsg({
        item_list: [
          { type: MessageItemType.TEXT, text_item: { text: "Check this photo" } },
          {
            type: MessageItemType.IMAGE,
            image_item: { media: cdnMedia() },
          },
        ],
      });
      const msg = adapter.parseMessage(raw);
      expect(msg.text).toBe("Check this photo");
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments![0].type).toBe("image");
    });

    it("returns empty attachments array for text-only messages", () => {
      const adapter = createAdapter();
      const msg = adapter.parseMessage(textMsg());
      expect(msg.attachments).toEqual([]);
    });

    it("returns empty attachments when item_list is undefined", () => {
      const adapter = createAdapter();
      const raw = textMsg();
      delete raw.item_list;
      const msg = adapter.parseMessage(raw);
      expect(msg.attachments).toEqual([]);
    });
  });
});

describe("ILinkAdapter.rehydrateAttachment", () => {
  it("recreates fetchData from metadata", () => {
    const adapter = createAdapter();
    const attachment: Attachment = {
      type: "image",
      mimeType: "image/jpeg",
      fetchData: undefined as unknown as () => Promise<Buffer>,
      fetchMetadata: {
        encryptQueryParam: "enc123",
        aesKeyBase64: "a2V5MTIz",
        cdnBaseUrl: "https://cdn.example.com",
        fullUrl: "",
      },
    };
    const rehydrated = adapter.rehydrateAttachment(attachment);
    expect(rehydrated.fetchData).toBeInstanceOf(Function);
    // Original metadata should be preserved
    expect(rehydrated.fetchMetadata?.encryptQueryParam).toBe("enc123");
    expect(rehydrated.type).toBe("image");
  });

  it("returns attachment unchanged when metadata is missing", () => {
    const adapter = createAdapter();
    const attachment: Attachment = {
      type: "file",
      name: "doc.pdf",
      mimeType: "application/pdf",
      fetchData: async () => Buffer.from([]),
      fetchMetadata: undefined as never,
    };
    const rehydrated = adapter.rehydrateAttachment(attachment);
    expect(rehydrated.fetchData).toBe(attachment.fetchData);
  });
});

describe("ILinkAdapter.transcribeVoice", () => {
  it("returns null for non-SILK buffer (graceful fallback)", async () => {
    const adapter = createAdapter();
    const result = await adapter.transcribeVoice(Buffer.from([0, 0, 0]));
    // Should not throw, returns null when SILK decoding fails
    expect(result).toBeNull();
  });
});
