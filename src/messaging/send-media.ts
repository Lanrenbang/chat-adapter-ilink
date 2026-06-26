import { sendMessage as sendMessageApi } from "../api/api.js";
import type { WeixinApiOptions } from "../api/api.js";
import { uploadFileToWeixin, uploadVideoToWeixin, uploadVoiceToWeixin, uploadFileAttachmentToWeixin } from "../cdn/upload.js";
import type { UploadedFileInfo } from "../cdn/upload.js";
import { generateId } from "../util/random.js";
import type { MessageItem, SendMessageReq, CDNMedia } from "../api/types.js";
import { MessageItemType, MessageState, MessageType } from "../api/types.js";

function generateClientId(): string {
  return generateId("ilink");
}

function hexKeyToBase64(hexKey: string): string {
  return Buffer.from(hexKey, "hex").toString("base64");
}

function buildCdnMedia(uploadInfo: UploadedFileInfo): CDNMedia {
  return {
    encrypt_query_param: uploadInfo.downloadEncryptedQueryParam,
    aes_key: hexKeyToBase64(uploadInfo.aeskey),
    encrypt_type: 0,
  };
}

function buildSendMessageReq(params: {
  to: string;
  item: MessageItem;
  contextToken?: string;
  clientId: string;
}): SendMessageReq {
  const { to, item, contextToken, clientId } = params;
  return {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: [item],
      context_token: contextToken ?? undefined,
    },
  };
}

async function sendMediaMessage(params: {
  to: string;
  item: MessageItem;
  opts: WeixinApiOptions & { contextToken?: string };
}): Promise<{ messageId: string }> {
  const { to, item, opts } = params;
  const clientId = generateClientId();
  const req = buildSendMessageReq({ to, item, contextToken: opts.contextToken, clientId });
  try {
    await sendMessageApi({ baseUrl: opts.baseUrl, token: opts.token, timeoutMs: opts.timeoutMs, body: req });
  } catch (err) {
    console.error(`sendMediaMessage: failed to=${to} clientId=${clientId} err=${String(err)}`);
    throw err;
  }
  return { messageId: clientId };
}

export async function sendImageMessage(params: {
  buf: Buffer;
  to: string;
  opts: WeixinApiOptions & { contextToken?: string };
  cdnBaseUrl: string;
}): Promise<{ messageId: string }> {
  const { buf, to, opts, cdnBaseUrl } = params;
  const uploadInfo = await uploadFileToWeixin({ buf, toUserId: to, opts, cdnBaseUrl });
  const item: MessageItem = {
    type: MessageItemType.IMAGE,
    image_item: { media: buildCdnMedia(uploadInfo) },
  };
  return sendMediaMessage({ to, item, opts });
}

export async function sendVideoMessage(params: {
  buf: Buffer;
  to: string;
  opts: WeixinApiOptions & { contextToken?: string };
  cdnBaseUrl: string;
  thumbBuf?: Buffer;
}): Promise<{ messageId: string }> {
  const { buf, to, opts, cdnBaseUrl, thumbBuf } = params;
  const uploadInfo = await uploadVideoToWeixin({ buf, toUserId: to, opts, cdnBaseUrl });

  let thumbMedia: CDNMedia | undefined;
  if (thumbBuf) {
    const thumbInfo = await uploadFileToWeixin({ buf: thumbBuf, toUserId: to, opts, cdnBaseUrl });
    thumbMedia = buildCdnMedia(thumbInfo);
  }

  const item: MessageItem = {
    type: MessageItemType.VIDEO,
    video_item: { media: buildCdnMedia(uploadInfo), thumb_media: thumbMedia },
  };
  return sendMediaMessage({ to, item, opts });
}

export async function sendVoiceMessage(params: {
  buf: Buffer;
  to: string;
  opts: WeixinApiOptions & { contextToken?: string };
  cdnBaseUrl: string;
}): Promise<{ messageId: string }> {
  const { buf, to, opts, cdnBaseUrl } = params;
  const uploadInfo = await uploadVoiceToWeixin({ buf, toUserId: to, opts, cdnBaseUrl });
  const item: MessageItem = {
    type: MessageItemType.VOICE,
    voice_item: { media: buildCdnMedia(uploadInfo) },
  };
  return sendMediaMessage({ to, item, opts });
}

export async function sendFileMessage(params: {
  buf: Buffer;
  fileName: string;
  to: string;
  opts: WeixinApiOptions & { contextToken?: string };
  cdnBaseUrl: string;
}): Promise<{ messageId: string }> {
  const { buf, fileName, to, opts, cdnBaseUrl } = params;
  const uploadInfo = await uploadFileAttachmentToWeixin({ buf, toUserId: to, opts, cdnBaseUrl });
  const item: MessageItem = {
    type: MessageItemType.FILE,
    file_item: { media: buildCdnMedia(uploadInfo), file_name: fileName },
  };
  return sendMediaMessage({ to, item, opts });
}

export async function uploadImageToItem(params: {
  buf: Buffer;
  toUserId: string;
  opts: WeixinApiOptions & { contextToken?: string };
  cdnBaseUrl: string;
}): Promise<MessageItem> {
  const uploadInfo = await uploadFileToWeixin({ buf: params.buf, toUserId: params.toUserId, opts: params.opts, cdnBaseUrl: params.cdnBaseUrl });
  return { type: MessageItemType.IMAGE, image_item: { media: buildCdnMedia(uploadInfo) } };
}

export async function uploadVideoToItem(params: {
  buf: Buffer;
  toUserId: string;
  opts: WeixinApiOptions & { contextToken?: string };
  cdnBaseUrl: string;
  thumbBuf?: Buffer;
}): Promise<MessageItem> {
  const uploadInfo = await uploadVideoToWeixin({ buf: params.buf, toUserId: params.toUserId, opts: params.opts, cdnBaseUrl: params.cdnBaseUrl });
  let thumbMedia: CDNMedia | undefined;
  if (params.thumbBuf) {
    const thumbInfo = await uploadFileToWeixin({ buf: params.thumbBuf, toUserId: params.toUserId, opts: params.opts, cdnBaseUrl: params.cdnBaseUrl });
    thumbMedia = buildCdnMedia(thumbInfo);
  }
  return { type: MessageItemType.VIDEO, video_item: { media: buildCdnMedia(uploadInfo), thumb_media: thumbMedia } };
}

export async function uploadVoiceToItem(params: {
  buf: Buffer;
  toUserId: string;
  opts: WeixinApiOptions & { contextToken?: string };
  cdnBaseUrl: string;
}): Promise<MessageItem> {
  const uploadInfo = await uploadVoiceToWeixin({ buf: params.buf, toUserId: params.toUserId, opts: params.opts, cdnBaseUrl: params.cdnBaseUrl });
  return { type: MessageItemType.VOICE, voice_item: { media: buildCdnMedia(uploadInfo) } };
}

export async function uploadFileToItem(params: {
  buf: Buffer;
  fileName: string;
  toUserId: string;
  opts: WeixinApiOptions & { contextToken?: string };
  cdnBaseUrl: string;
}): Promise<MessageItem> {
  const uploadInfo = await uploadFileAttachmentToWeixin({ buf: params.buf, toUserId: params.toUserId, opts: params.opts, cdnBaseUrl: params.cdnBaseUrl });
  return { type: MessageItemType.FILE, file_item: { media: buildCdnMedia(uploadInfo), file_name: params.fileName } };
}
