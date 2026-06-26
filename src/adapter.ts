/**
 * ILinkAdapter — Weixin iLink adapter for Chat SDK.
 *
 * Manages multiple iLink accounts, each with its own long-poll monitor loop.
 * Thread encoding: `ilink:{accountId}:{userId}`
 */
import type {
  Adapter,
  AdapterPostableMessage,
  Attachment,
  ChatInstance,
  EmojiValue,
  FetchOptions,
  FetchResult,
  FormattedContent,
  Logger,
  RawMessage,
  StateAdapter,
  ThreadInfo,
  WebhookOptions,
} from "chat";
import { ConsoleLogger, Message, NotImplementedError } from "chat";

import { configureApi } from "./api/api.js";
import { DEFAULT_BASE_URL, CDN_BASE_URL } from "./auth/accounts.js";
import type { AccountCredentials } from "./auth/accounts.js";
import { listAccounts, loadAccount, clearAccount } from "./auth/accounts.js";
import { ILinkFormatConverter } from "./format-converter.js";
import { MessageItemType, MessageType } from "./api/types.js";
import type { WeixinMessage } from "./api/types.js";
import { monitorWeixinProvider } from "./monitor/monitor.js";
import {
  getContextToken,
  setContextToken,
  extractTextBody,
  buildMessageId,
  getMessageUserId,
  isBotMessage,
  encodeThreadId,
  decodeThreadId,
  processInboundMessage,
} from "./messaging/process-message.js";
import { sendMessageWeixin, sendRefMessageWeixin } from "./messaging/send.js";
import { sendImageMessage, sendVideoMessage, sendVoiceMessage, sendFileMessage, uploadImageToItem, uploadVideoToItem, uploadVoiceToItem, uploadFileToItem } from "./messaging/send-media.js";
import { decryptAesEcb } from "./cdn/aes-ecb.js";
import { buildCdnDownloadUrl } from "./cdn/cdn-url.js";
import { transcribeSilkToWav } from "./messaging/transcribe.js";
import { extractPostableAttachments, extractFiles } from "@chat-adapter/shared";

export const ADAPTER_NAME = "ilink";

export type ILinkAdapterConfig = {
  adapterId?: string;
  userName?: string;
  baseUrl?: string;
  cdnBaseUrl?: string;
  botAgent?: string;
  routeTag?: string;
  token?: string;
  accountId?: string;
  longPollTimeoutMs?: number;
  state?: StateAdapter;
  formatConverter?: ILinkFormatConverter;
  logger?: Logger;
  /** When true, starts polling on initialize (default: true). */
  pollingEnabled?: boolean;
};

type InternalPollLoop = {
  abortController: AbortController;
  promise: Promise<void>;
};

export class ILinkAdapter implements Adapter {
  readonly name = ADAPTER_NAME;
  readonly userName: string;
  readonly persistThreadHistory = true;

  readonly formatConverter: ILinkFormatConverter;

  private config: Required<Pick<ILinkAdapterConfig, "baseUrl" | "cdnBaseUrl" | "longPollTimeoutMs" | "pollingEnabled">>;
  private chat: ChatInstance | null = null;
  private state: StateAdapter | null = null;
  private logger: Logger;
  private globalAbortController = new AbortController();
  private pollLoops = new Map<string, InternalPollLoop>();

  constructor(config: ILinkAdapterConfig = {}) {
    this.userName = config.userName ?? "ilink-bot";
    this.config = {
      baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
      cdnBaseUrl: config.cdnBaseUrl ?? CDN_BASE_URL,
      longPollTimeoutMs: config.longPollTimeoutMs ?? 35_000,
      pollingEnabled: config.pollingEnabled ?? true,
    };
    this.formatConverter = config.formatConverter ?? new ILinkFormatConverter();
    this.logger = config.logger ?? new ConsoleLogger("info", ADAPTER_NAME);

    configureApi({
      botAgent: config.botAgent,
      routeTag: config.routeTag,
    });
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    this.logger = chat.getLogger(ADAPTER_NAME);
    this.state = chat.getState();

    if (!this.config.pollingEnabled) {
      this.logger.info("Polling disabled via config");
      return;
    }

    const accounts = await listAccounts(this.state);
    this.logger.info(`Found ${accounts.length} existing account(s)`);
    for (const accountId of accounts) {
      const creds = await loadAccount(this.state, accountId);
      if (creds?.token) {
        this.startPollLoop(accountId, creds);
      }
    }
  }

  async disconnect(): Promise<void> {
    this.globalAbortController.abort();
    for (const [id, loop] of this.pollLoops) {
      loop.abortController.abort();
      await loop.promise.catch(() => {});
    }
    this.pollLoops.clear();
  }

  parseMessage(raw: unknown): Message {
    const msg = raw as WeixinMessage;
    const userId = getMessageUserId(msg);
    const accountId = this.extractAccountId(msg) ?? "";
    const threadId = encodeThreadId(accountId, userId);
    const text = extractTextBody(msg.item_list);
    const isMe = isBotMessage(msg);

    return new Message({
      id: buildMessageId(msg),
      threadId,
      text,
      formatted: this.formatConverter.toAst(text),
      raw: msg,
      author: {
        userId: isMe ? msg.from_user_id ?? accountId : userId,
        userName: userId,
        fullName: userId,
        isBot: isMe,
        isMe,
      },
      metadata: {
        dateSent: new Date(msg.create_time_ms ?? Date.now()),
        edited: false,
      },
      attachments: this.extractAttachments(msg),
    });
  }

  /**
   * Extract Attachment[] from a WeixinMessage's item_list.
   * Non-text items (IMAGE, VOICE, FILE, VIDEO) become Attachments
   * with fetchData capturing CDN params in closure (Telegram-style).
   */
  private extractAttachments(msg: WeixinMessage): Attachment[] {
    const attachments: Attachment[] = [];
    if (!msg.item_list?.length) return attachments;

    for (const item of msg.item_list) {
      if (item.type === MessageItemType.IMAGE) {
        const img = item.image_item;
        if (!img?.media?.encrypt_query_param && !img?.media?.full_url) continue;
        const aesKeyBase64 = img.aeskey
          ? Buffer.from(img.aeskey, "hex").toString("base64")
          : (img.media.aes_key ?? "");
        const encryptQueryParam = img.media.encrypt_query_param ?? "";
        const fullUrl = img.media.full_url;
        attachments.push({
          type: "image",
          mimeType: "image/*",
          fetchMetadata: { mediaType: "image", encryptQueryParam, aesKeyBase64, cdnBaseUrl: this.config.cdnBaseUrl, fullUrl: fullUrl ?? "" },
          fetchData: () => this.downloadAndDecryptMedia(encryptQueryParam, aesKeyBase64, this.config.cdnBaseUrl, fullUrl),
        });
      } else if (item.type === MessageItemType.VOICE) {
        const voice = item.voice_item;
        if (!voice?.media?.aes_key) continue;
        const encryptQueryParam = voice.media.encrypt_query_param ?? "";
        const aesKeyBase64 = voice.media.aes_key;
        const fullUrl = voice.media.full_url;
        attachments.push({
          type: "audio",
          mimeType: "audio/silk",
          fetchMetadata: { mediaType: "voice", encryptQueryParam, aesKeyBase64, cdnBaseUrl: this.config.cdnBaseUrl, fullUrl: fullUrl ?? "" },
          fetchData: async () => {
            const decrypted = await this.downloadAndDecryptMedia(encryptQueryParam, aesKeyBase64, this.config.cdnBaseUrl, fullUrl);
            const wav = await transcribeSilkToWav(decrypted);
            return wav ?? decrypted;
          },
        });
      } else if (item.type === MessageItemType.FILE) {
        const file = item.file_item;
        if (!file?.media?.aes_key) continue;
        const encryptQueryParam = file.media.encrypt_query_param ?? "";
        const aesKeyBase64 = file.media.aes_key;
        const fullUrl = file.media.full_url;
        attachments.push({
          type: "file",
          name: file.file_name,
          mimeType: "application/octet-stream",
          fetchMetadata: { mediaType: "file", encryptQueryParam, aesKeyBase64, cdnBaseUrl: this.config.cdnBaseUrl, fullUrl: fullUrl ?? "", fileName: file.file_name ?? "" },
          fetchData: () => this.downloadAndDecryptMedia(encryptQueryParam, aesKeyBase64, this.config.cdnBaseUrl, fullUrl),
        });
      } else if (item.type === MessageItemType.VIDEO) {
        const video = item.video_item;
        if (!video?.media?.aes_key) continue;
        const encryptQueryParam = video.media.encrypt_query_param ?? "";
        const aesKeyBase64 = video.media.aes_key;
        const fullUrl = video.media.full_url;
        attachments.push({
          type: "video",
          mimeType: "video/mp4",
          fetchMetadata: { mediaType: "video", encryptQueryParam, aesKeyBase64, cdnBaseUrl: this.config.cdnBaseUrl, fullUrl: fullUrl ?? "" },
          fetchData: () => this.downloadAndDecryptMedia(encryptQueryParam, aesKeyBase64, this.config.cdnBaseUrl, fullUrl),
        });
      }
    }
    return attachments;
  }

  rehydrateAttachment(attachment: Attachment): Attachment {
    const meta = attachment.fetchMetadata;
    if (!meta?.encryptQueryParam || !meta?.aesKeyBase64) return attachment;
    const { encryptQueryParam, aesKeyBase64, cdnBaseUrl, fullUrl } = meta;
    return {
      ...attachment,
      fetchData: () => this.downloadAndDecryptMedia(
        encryptQueryParam, aesKeyBase64, cdnBaseUrl ?? this.config.cdnBaseUrl, fullUrl,
      ),
    };
  }

  /**
   * Transcribe a SILK audio buffer to WAV format.
   * Access via getAdapter():
   *   const adapter = bot.getAdapter("ilink");
   *   const wav = await adapter.transcribeVoice(silkBuffer);
   */
  async transcribeVoice(silkBuffer: Buffer): Promise<Buffer | null> {
    return transcribeSilkToWav(silkBuffer);
  }

  /**
   * Extract quoted (ref_msg) content from a received message.
   * Returns null if the message has no reference quote.
   */
  extractQuotedContent(message: Message<WeixinMessage>): {
    text?: string;
    attachments: Attachment[];
    title?: string;
  } | null {
    const raw = message.raw;
    if (!raw?.item_list) return null;

    for (const item of raw.item_list) {
      if (!item.ref_msg) continue;
      const quoted = item.ref_msg;
      const quotedItem = quoted.message_item;
      if (!quotedItem) continue;

      const result: { text?: string; attachments: Attachment[]; title?: string } = {
        attachments: [],
        title: quoted.title,
      };

      if (quotedItem.text_item?.text) {
        result.text = quotedItem.text_item.text;
      }

      if (quotedItem.type === MessageItemType.IMAGE) {
        const img = quotedItem.image_item;
        if (img?.media?.encrypt_query_param || img?.media?.full_url) {
          const aesKey = img.aeskey ? Buffer.from(img.aeskey, "hex").toString("base64") : img.media.aes_key;
          if (aesKey || img.media.full_url) {
            const encQueryParam = img.media.encrypt_query_param ?? "";
            const aesKeyBase64 = aesKey ?? "";
            const fullUrl = img.media.full_url;
            result.attachments.push({
              type: "image",
              mimeType: "image/*",
              fetchMetadata: { mediaType: "image", encryptQueryParam: encQueryParam, aesKeyBase64, cdnBaseUrl: this.config.cdnBaseUrl, fullUrl: fullUrl ?? "" },
              fetchData: () => this.downloadAndDecryptMedia(encQueryParam, aesKeyBase64, this.config.cdnBaseUrl, fullUrl),
            });
          } else {
            this.logger.debug("extractQuotedContent: skipped quoted image — missing aesKey and full_url");
          }
        }
      } else if (quotedItem.type === MessageItemType.VOICE) {
        const voice = quotedItem.voice_item;
        if (voice?.media?.aes_key) {
          const aesKeyBase64 = voice.media.aes_key;
          const encQueryParam = voice.media.encrypt_query_param ?? "";
          const fullUrl = voice.media.full_url;
          result.attachments.push({
            type: "audio",
            mimeType: "audio/silk",
            fetchMetadata: { mediaType: "voice", encryptQueryParam: encQueryParam, aesKeyBase64, cdnBaseUrl: this.config.cdnBaseUrl, fullUrl: fullUrl ?? "" },
            fetchData: async () => {
              const decrypted = await this.downloadAndDecryptMedia(encQueryParam, aesKeyBase64, this.config.cdnBaseUrl, fullUrl);
              return (await transcribeSilkToWav(decrypted)) ?? decrypted;
            },
          });
        }
      } else if (quotedItem.type === MessageItemType.FILE) {
        const file = quotedItem.file_item;
        if (file?.media?.aes_key) {
          const aesKeyBase64 = file.media.aes_key;
          const encQueryParam = file.media.encrypt_query_param ?? "";
          const fullUrl = file.media.full_url;
          const fileName = file.file_name;
          result.attachments.push({
            type: "file",
            name: fileName,
            mimeType: "application/octet-stream",
            fetchMetadata: { mediaType: "file", encryptQueryParam: encQueryParam, aesKeyBase64, cdnBaseUrl: this.config.cdnBaseUrl, fullUrl: fullUrl ?? "", fileName: fileName ?? "" },
            fetchData: () => this.downloadAndDecryptMedia(encQueryParam, aesKeyBase64, this.config.cdnBaseUrl, fullUrl),
          });
        }
      } else if (quotedItem.type === MessageItemType.VIDEO) {
        const video = quotedItem.video_item;
        if (video?.media?.aes_key) {
          const aesKeyBase64 = video.media.aes_key;
          const encQueryParam = video.media.encrypt_query_param ?? "";
          const fullUrl = video.media.full_url;
          result.attachments.push({
            type: "video",
            mimeType: "video/mp4",
            fetchMetadata: { mediaType: "video", encryptQueryParam: encQueryParam, aesKeyBase64, cdnBaseUrl: this.config.cdnBaseUrl, fullUrl: fullUrl ?? "" },
            fetchData: () => this.downloadAndDecryptMedia(encQueryParam, aesKeyBase64, this.config.cdnBaseUrl, fullUrl),
          });
        }
      }

      return result;
    }
    return null;
  }

  /**
   * Send a reply that quotes (references) a previous message.
   *
   * Text replies: the reply text is sent as a TEXT item with a ref_msg.
   * Media replies: a TEXT(ref_msg) item plus one or more media items are sent.
   *
   * @param threadId  - target thread ID (from message.threadId or thread.id)
   * @param content   - reply content (string, { markdown }, or { attachments })
   * @param options.quotedMessage - the original Message being replied to
   */
  async replyToMessage(
    threadId: string,
    content: string | { markdown: string } | { attachments: Attachment[] },
    options: { quotedMessage: Message<WeixinMessage> },
  ): Promise<{ messageId: string }> {
    this.assertInitialized();
    const { accountId, userId } = decodeThreadId(threadId);
    const state = this.state!;

    const quotedRaw = options.quotedMessage.raw;
    if (!quotedRaw) {
      throw new Error("Cannot reply: quotedMessage.raw is undefined — supply the original Message with raw data");
    }
    const quotedItem = this.findQuoteTarget(quotedRaw);
    if (!quotedItem) {
      throw new Error("Cannot reply: no quoted MessageItem found in the original message");
    }

    const contextToken = await getContextToken(state, accountId, userId);
    const opts = {
      baseUrl: this.config.baseUrl,
      token: await this.getAccountToken(accountId),
      contextToken,
    };
    const token = opts.token;

    if (typeof content === "string") {
      return sendRefMessageWeixin({ to: userId, refItem: quotedItem, text: content, opts });
    }

    if ("markdown" in content) {
      const text = this.formatConverter.renderPostable({ markdown: content.markdown });
      return sendRefMessageWeixin({ to: userId, refItem: quotedItem, text, opts });
    }

    if ("attachments" in content && content.attachments.length > 0) {
      const att = content.attachments[0];
      const data = att.data ?? (att.fetchData ? await att.fetchData() : undefined);
      if (!data) throw new Error("Attachment requires data or fetchData for replyToMessage");
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(await new Blob([data]).arrayBuffer());
      const mediaOpts = { ...opts, token: token ?? "" };

      let mediaItem: import("./api/types.js").MessageItem;
      switch (att.type) {
        case "image":
          mediaItem = await uploadImageToItem({ buf, toUserId: userId, opts: mediaOpts, cdnBaseUrl: this.config.cdnBaseUrl });
          break;
        case "audio":
          mediaItem = await uploadVoiceToItem({ buf, toUserId: userId, opts: mediaOpts, cdnBaseUrl: this.config.cdnBaseUrl });
          break;
        case "video":
          mediaItem = await uploadVideoToItem({ buf, toUserId: userId, opts: mediaOpts, cdnBaseUrl: this.config.cdnBaseUrl });
          break;
        case "file":
          mediaItem = await uploadFileToItem({ buf, fileName: att.name ?? "file", toUserId: userId, opts: mediaOpts, cdnBaseUrl: this.config.cdnBaseUrl });
          break;
        default:
          throw new Error(`Unsupported attachment type for replyToMessage: ${att.type}`);
      }

      return sendRefMessageWeixin({ to: userId, refItem: quotedItem, text: undefined, mediaItems: [mediaItem], opts });
    }

    throw new Error("Invalid content type for replyToMessage");
  }

  private findQuoteTarget(raw: WeixinMessage): import("./api/types.js").MessageItem | null {
    if (!raw.item_list?.length) return null;
    for (const item of raw.item_list) {
      if (item.type === MessageItemType.TEXT) return item;
    }
    return raw.item_list[0];
  }

  private async downloadAndDecryptMedia(
    encryptQueryParam: string,
    aesKeyBase64: string,
    cdnBaseUrl: string,
    fullUrl?: string,
  ): Promise<Buffer> {
    const url = fullUrl || buildCdnDownloadUrl(encryptQueryParam, cdnBaseUrl);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CDN download failed: ${res.status} ${res.statusText}`);
    const encrypted = Buffer.from(await res.arrayBuffer());
    if (aesKeyBase64) {
      const key = Buffer.from(aesKeyBase64, "base64");
      return decryptAesEcb(encrypted, key);
    }
    return encrypted;
  }

  renderFormatted(content: FormattedContent): string {
    return this.formatConverter.fromAst(content);
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage> {
    this.assertInitialized();
    const { accountId, userId } = decodeThreadId(threadId);
    const state = this.state!;
    const text = this.formatConverter.renderPostable(message);
    const contextToken = await getContextToken(state, accountId, userId);
    const opts = {
      baseUrl: this.config.baseUrl,
      token: await this.getAccountToken(accountId),
      contextToken,
    };
    const token = opts.token;

    // Check for typed attachments first (preserve media type)
    const attachments = extractPostableAttachments(message);
    if (attachments.length > 0) {
      const att = attachments[0];
      const data = att.data ?? (att.fetchData ? await att.fetchData() : undefined);
      if (!data) {
        throw new Error(`Attachment requires data or fetchData for type=${att.type}`);
      }
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(await new Blob([data]).arrayBuffer());
      const mediaOpts = { ...opts, token: token ?? "" };

      switch (att.type) {
        case "image": {
          await sendImageMessage({ buf, to: userId, opts: mediaOpts, cdnBaseUrl: this.config.cdnBaseUrl });
          break;
        }
        case "audio": {
          await sendVoiceMessage({ buf, to: userId, opts: mediaOpts, cdnBaseUrl: this.config.cdnBaseUrl });
          break;
        }
        case "video": {
          await sendVideoMessage({ buf, to: userId, opts: mediaOpts, cdnBaseUrl: this.config.cdnBaseUrl });
          break;
        }
        case "file": {
          await sendFileMessage({ buf, fileName: att.name ?? "file", to: userId, opts: mediaOpts, cdnBaseUrl: this.config.cdnBaseUrl });
          break;
        }
      }
      return { id: `${Date.now()}`, threadId, raw: { from_user_id: "", to_user_id: userId, item_list: [] } };
    }

    // Check for generic file uploads
    const files = extractFiles(message);
    if (files.length > 0) {
      const file = files[0];
      const buf = Buffer.isBuffer(file.data) ? file.data : Buffer.from(await new Blob([file.data]).arrayBuffer());
      const mediaOpts = { ...opts, token: token ?? "" };
      await sendFileMessage({ buf, fileName: file.filename, to: userId, opts: mediaOpts, cdnBaseUrl: this.config.cdnBaseUrl });
      return { id: `${Date.now()}`, threadId, raw: { from_user_id: "", to_user_id: userId, item_list: [] } };
    }

    // Plain text
    await sendMessageWeixin({ to: userId, text, opts });

    return {
      id: `${Date.now()}`,
      threadId,
      raw: { from_user_id: "", to_user_id: userId, item_list: [{ type: MessageItemType.TEXT, text_item: { text } }] },
    };
  }

  async editMessage(_threadId: string, _messageId: string, _message: AdapterPostableMessage): Promise<RawMessage> {
    throw new NotImplementedError("Weixin does not support editing messages", "editMessage");
  }

  async deleteMessage(_threadId: string, _messageId: string): Promise<void> {
    throw new NotImplementedError("Weixin does not support deleting messages", "deleteMessage");
  }

  async addReaction(_threadId: string, _messageId: string, _emoji: EmojiValue | string): Promise<void> {
    throw new NotImplementedError("Weixin reactions are not supported", "addReaction");
  }

  async removeReaction(_threadId: string, _messageId: string, _emoji: EmojiValue | string): Promise<void> {
    throw new NotImplementedError("Weixin reactions are not supported", "removeReaction");
  }

  async fetchMessages(_threadId: string, _options?: FetchOptions): Promise<FetchResult> {
    return { messages: [] };
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const { accountId, userId } = decodeThreadId(threadId);
    return {
      id: threadId,
      channelId: this.channelIdFromThreadId(threadId),
      channelName: userId,
      isDM: true,
      metadata: { accountId, userId },
    };
  }

  async openDM(userId: string): Promise<string> {
    const accountId = await this.resolvePrimaryAccountId();
    return encodeThreadId(accountId, userId);
  }

  isDM(_threadId: string): boolean {
    return true;
  }

  async handleWebhook(_request: Request, _options?: WebhookOptions): Promise<Response> {
    return Response.json(
      { error: "iLink adapter uses long-poll; webhook not supported" },
      { status: 501 },
    );
  }

  async startTyping(threadId: string, _status?: string): Promise<void> {
    const { userId } = decodeThreadId(threadId);
    const state = this.state!;
    const contextToken = await getContextToken(state, "", userId);
    if (!contextToken) return;
  }

  channelIdFromThreadId(threadId: string): string {
    const { accountId } = decodeThreadId(threadId);
    return `${ADAPTER_NAME}:${accountId}`;
  }

  encodeThreadId(platformData: string): string {
    return platformData;
  }

  decodeThreadId(threadId: string): string {
    return threadId;
  }

  // ---- Internal ----

  private startPollLoop(accountId: string, creds: AccountCredentials): void {
    if (this.pollLoops.has(accountId)) return;

    const abortController = new AbortController();
    const promise = monitorWeixinProvider({
      baseUrl: creds.baseUrl || this.config.baseUrl,
      token: creds.token,
      accountId,
      state: this.state!,
      abortSignal: this.combineSignals(abortController.signal),
      longPollTimeoutMs: this.config.longPollTimeoutMs,
      onMessage: (msg) => this.handleInbound(msg, accountId),
      onSessionExpired: (id) => this.handleSessionExpired(id),
      log: (msg) => this.logger.debug(`[${accountId}] ${msg}`),
      errLog: (msg) => this.logger.error(`[${accountId}] ${msg}`),
    });

    this.pollLoops.set(accountId, { abortController, promise });
    this.logger.info(`Poll loop started for account=${accountId}`);
  }

  /**
   * Route an inbound WeixinMessage through processInboundMessage,
   * which handles context_token storage and dispatches to Chat SDK.
   *
   * All messages (including slash commands) are routed through
   * chat.processMessage() — see slash-commands.ts for the design rationale.
   */
  private async handleInbound(raw: WeixinMessage, accountId: string): Promise<void> {
    if (!this.chat || !this.state) return;
    await processInboundMessage(raw, accountId, this.state, this.chat, this);
  }

  private async handleSessionExpired(accountId: string): Promise<void> {
    this.logger.warn(`Session expired for account=${accountId}, cleaning up`);
    await clearAccount(this.state!, accountId);
    this.pollLoops.get(accountId)?.abortController.abort();
    this.pollLoops.delete(accountId);
  }

  private async getAccountToken(accountId: string): Promise<string | undefined> {
    const creds = await loadAccount(this.state!, accountId);
    return creds?.token;
  }

  /** Login (add a new account) and start its poll loop. */
  async addAccount(accountId: string, credentials: AccountCredentials): Promise<void> {
    const { registerAccount } = await import("./auth/accounts.js");
    await registerAccount(this.state!, accountId, credentials);
    this.startPollLoop(accountId, credentials);
  }

  /** Remove an account and stop its poll loop. */
  async removeAccount(accountId: string): Promise<void> {
    await clearAccount(this.state!, accountId);
    this.pollLoops.get(accountId)?.abortController.abort();
    this.pollLoops.delete(accountId);
  }

  private async resolvePrimaryAccountId(): Promise<string> {
    const accounts = await listAccounts(this.state!);
    if (accounts.length > 0) return accounts[0];
    return "default";
  }

  private extractAccountId(msg: WeixinMessage): string | undefined {
    for (const [id] of this.pollLoops) {
      return id;
    }
    return undefined;
  }

  private combineSignals(...signals: AbortSignal[]): AbortSignal {
    const controller = new AbortController();
    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort();
        return controller.signal;
      }
      signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    return controller.signal;
  }

  private assertInitialized(): void {
    if (!this.chat || !this.state) {
      throw new Error("ILinkAdapter not initialized");
    }
  }
}
