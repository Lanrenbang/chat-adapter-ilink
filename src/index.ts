export {
  ILinkAdapter,
  ILinkAdapterConfig,
  ADAPTER_NAME,
} from "./adapter.js";
export { createILinkAdapter, CreateILinkAdapterConfig } from "./factory.js";
export { ILinkFormatConverter, markdownToPlainText } from "./format-converter.js";

export {
  sendMessageWeixin,
} from "./messaging/send.js";
// send*Message functions are internal — media upload is handled automatically
// by the adapter's postMessage when using thread.post({ attachments: [...] })
export {
  processInboundMessage,
  encodeThreadId,
  decodeThreadId,
  buildMessageId,
  getMessageUserId,
  isBotMessage,
  extractTextBody,
  getContextToken,
  setContextToken,
} from "./messaging/process-message.js";

export { transcribeSilkToWav } from "./messaging/transcribe.js";

export {
  type UploadedFileInfo,
  uploadFileToWeixin,
  uploadVideoToWeixin,
  uploadVoiceToWeixin,
  uploadFileAttachmentToWeixin,
  uploadBufferToWeixin,
} from "./cdn/upload.js";
export { uploadBufferToCdn } from "./cdn/cdn-upload.js";
export { downloadAndDecryptMedia } from "./cdn/pic-decrypt.js";
export { encryptAesEcb, decryptAesEcb, aesEcbPaddedSize } from "./cdn/aes-ecb.js";
export { buildCdnUploadUrl } from "./cdn/cdn-url.js";

export { silkToWav, wavToSilk } from "./media/silk.js";
export { getExtensionFromContentTypeOrUrl, mimeFromFilename } from "./media/mime.js";

export {
  configureApi,
  getUpdates,
  sendMessage as apiSendMessage,
  getUploadUrl,
  getConfig,
  sendTyping,
  notifyStart,
  notifyStop,
} from "./api/api.js";
export type { WeixinApiOptions } from "./api/api.js";
export {
  UploadMediaType,
  MessageType,
  MessageItemType,
  MessageState,
  TypingStatus,
} from "./api/types.js";
export type {
  WeixinMessage,
  MessageItem,
  TextItem,
  ImageItem,
  VoiceItem,
  FileItem,
  VideoItem,
  CDNMedia,
  GetUpdatesReq,
  GetUpdatesResp,
  SendMessageReq,
  GetConfigResp,
} from "./api/types.js";

export {
  listAccounts,
  loadAccount,
  clearAccount,
  registerAccount,
} from "./auth/accounts.js";
export type { AccountCredentials } from "./auth/accounts.js";
export { login } from "./auth/login.js";

export { monitorWeixinProvider } from "./monitor/monitor.js";

export { VERSION, APP_ID, CLIENT_VERSION } from "./version.js";
