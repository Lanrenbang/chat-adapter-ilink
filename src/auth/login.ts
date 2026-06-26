/**
 * Unified QR login interface for iLink protocol.
 * Ported from openclaw-weixin src/auth/login-qr.ts.
 *
 * Adaptations:
 * - Merged startWeixinLoginWithQr + waitForWeixinLogin into single login()
 * - Uses StateAdapter for QR session persistence (TTL 5min)
 * - Uses Web Crypto for UUID generation (Workers compatible)
 * - Removed stdin/stdout — QR display via configurable callback
 * - All 8 QR statuses handled
 * - binded_redirect = success (alreadyConnected)
 */
import type { StateAdapter } from "chat";
import { apiGetFetch, apiPostFetch } from "../api/api.js";

const FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const QR_SESSION_TTL_MS = 5 * 60_000;
const MAX_QR_REFRESH_COUNT = 3;
const DEFAULT_LOGIN_TIMEOUT_MS = 480_000;

export const DEFAULT_ILINK_BOT_TYPE = "3";

const QR_SESSION_PREFIX = "ilink:login:";

type QRSessionData = {
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
  currentBaseUrl: string;
  pendingVerifyCode?: string;
};

type StatusResponse = {
  status: "wait" | "scaned" | "confirmed" | "expired" | "scaned_but_redirect" | "need_verifycode" | "verify_code_blocked" | "binded_redirect";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
};

export interface LoginOptions {
  /** Account ID hint; used as session key and account ID on success. */
  accountId?: string;
  /** When true, skip QR cache and force new QR generation. */
  force?: boolean;
  /** Verify code (from `need_verifycode` status response). */
  verifyCode?: string;
  /** Bot type parameter (default: "3"). */
  botType?: string;
  /** Login timeout in ms (default: 480000 = 8 min). */
  timeoutMs?: number;
  /** Callback for when a QR code URL is generated (for display). */
  onQRCode?: (url: string) => void;
}

export interface LoginResult {
  connected: boolean;
  alreadyConnected?: boolean;
  botToken?: string;
  accountId?: string;
  baseUrl?: string;
  userId?: string;
  status: "success" | "need_verifycode" | "expired" | "blocked" | "error";
  verifyCodePrompt?: string;
  error?: string;
}

/**
 * Unified QR login interface.
 *
 * 1. Checks for existing valid QR session (unless force=true).
 * 2. If none/expired, generates new QR via get_bot_qrcode.
 * 3. Auto-poll get_qrcode_status until resolution or timeout.
 * 4. Returns LoginResult.
 */
export async function login(state: StateAdapter, options: LoginOptions = {}): Promise<LoginResult> {
  const sessionKey = options.accountId ?? crypto.randomUUID();
  const botType = options.botType ?? DEFAULT_ILINK_BOT_TYPE;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  // 1. Check for existing valid QR session
  let session = await loadQRSession(state, sessionKey);
  if (session && !options.force) {
    const age = Date.now() - session.startedAt;
    if (age < QR_SESSION_TTL_MS) {
      console.debug(`login: reusing existing QR session key=${sessionKey}, age=${age}ms`);
    } else {
      await deleteQRSession(state, sessionKey);
      session = undefined;
    }
  }

  // 2. Generate new QR if needed
  if (!session || options.force) {
    console.debug(`login: fetching new QR code, botType=${botType}`);
    const localTokenList = await getLocalBotTokenList(state);
    const rawText = await apiPostFetch({
      baseUrl: FIXED_BASE_URL,
      endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
      body: JSON.stringify({ local_token_list: localTokenList }),
      label: "fetchQRCode",
    });
    const qrResponse = JSON.parse(rawText) as { qrcode: string; qrcode_img_content: string };

    session = {
      qrcode: qrResponse.qrcode,
      qrcodeUrl: qrResponse.qrcode_img_content,
      startedAt: Date.now(),
      currentBaseUrl: FIXED_BASE_URL,
    };
    await saveQRSession(state, sessionKey, session);
    options.onQRCode?.(qrResponse.qrcode_img_content);
  } else {
    options.onQRCode?.(session.qrcodeUrl);
  }

  // 3. Long-poll QR status
  let qrRefreshCount = 1;
  while (Date.now() < deadline) {
    const currentBaseUrl = session.currentBaseUrl;

    let statusResponse: StatusResponse;
    try {
      // Use the verifyCode from LoginOptions for the actual API call.
      // session.pendingVerifyCode is only used as a retry flag, NOT sent to the API.
      const apiVerifyCode = options.verifyCode;
      statusResponse = await pollQRStatus(currentBaseUrl, session.qrcode, apiVerifyCode);
    } catch (err) {
      // Network error during poll — treat as "wait" and retry
      console.debug(`login: poll error (will retry): ${String(err)}`);
      await sleep(1000);
      continue;
    }

    switch (statusResponse.status) {
      case "wait":
        // Normal long-poll timeout, continue polling
        break;

      case "scaned":
        session.pendingVerifyCode = undefined;
        break;

      case "need_verifycode": {
        // Preserve the QR session — the verify code shown on the user's phone
        // is tied to THIS QR scan. Deleting the session would force a new QR
        // on retry, making the user's verify code invalid.
        const isRetry = session.pendingVerifyCode !== undefined;
        const prompt = isRetry
          ? "❌ 配对码不匹配，请重新输入："
          : "输入手机微信显示的数字：";
        session.pendingVerifyCode = "pending";
        await saveQRSession(state, sessionKey, session);
        return {
          connected: false,
          status: "need_verifycode",
          verifyCodePrompt: prompt,
        };
      }

      case "expired": {
        qrRefreshCount++;
        if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
          await deleteQRSession(state, sessionKey);
          return {
            connected: false,
            status: "expired",
            error: "二维码多次过期，登录流程已停止",
          };
        }
        // Refresh QR
        const newQR = await refreshQR(state, sessionKey, botType, session);
        if (!newQR) {
          await deleteQRSession(state, sessionKey);
          return { connected: false, status: "expired", error: "刷新二维码失败" };
        }
        session = newQR;
        options.onQRCode?.(session.qrcodeUrl);
        break;
      }

      case "binded_redirect":
        console.debug(`login: binded_redirect — already connected`);
        await deleteQRSession(state, sessionKey);
        return {
          connected: true,
          alreadyConnected: true,
          status: "success",
        };

      case "scaned_but_redirect": {
        const redirectHost = statusResponse.redirect_host;
        if (redirectHost) {
          session.currentBaseUrl = `https://${redirectHost}`;
          await saveQRSession(state, sessionKey, session);
          console.debug(`login: IDC redirect to ${redirectHost}`);
        }
        break;
      }

      case "verify_code_blocked": {
        qrRefreshCount++;
        if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
          await deleteQRSession(state, sessionKey);
          return { connected: false, status: "blocked", error: "多次输入错误" };
        }
        session.pendingVerifyCode = undefined;
        const refreshAfterBlock = await refreshQR(state, sessionKey, botType, session);
        if (!refreshAfterBlock) {
          await deleteQRSession(state, sessionKey);
          return { connected: false, status: "blocked", error: "多次输入错误" };
        }
        session = refreshAfterBlock;
        options.onQRCode?.(session.qrcodeUrl);
        break;
      }

      case "confirmed": {
        if (!statusResponse.ilink_bot_id) {
          await deleteQRSession(state, sessionKey);
          return { connected: false, status: "error", error: "服务器未返回 ilink_bot_id" };
        }
        const result: LoginResult = {
          connected: true,
          status: "success",
          botToken: statusResponse.bot_token,
          accountId: statusResponse.ilink_bot_id,
          baseUrl: statusResponse.baseurl,
          userId: statusResponse.ilink_user_id,
        };
        await deleteQRSession(state, sessionKey);
        return result;
      }
    }

    await sleep(1000);
  }

  // Timeout
  await deleteQRSession(state, sessionKey);
  return { connected: false, status: "expired", error: "登录超时" };
}

// ---- Internal helpers ---- //

async function pollQRStatus(baseUrl: string, qrcode: string, verifyCode?: string): Promise<StatusResponse> {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) {
    endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
  }
  try {
    const rawText = await apiGetFetch({
      baseUrl,
      endpoint,
      timeoutMs: QR_LONG_POLL_TIMEOUT_MS,
      label: "pollQRStatus",
    });
    return JSON.parse(rawText) as StatusResponse;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "wait" };
    }
    console.debug(`pollQRStatus: network error, will retry: ${String(err)}`);
    return { status: "wait" };
  }
}

async function getLocalBotTokenList(state: StateAdapter): Promise<string[]> {
  const accounts = await state.get<string[]>("ilink:accounts:list");
  if (!accounts?.length) return [];
  const tokens: string[] = [];
  for (let i = accounts.length - 1; i >= 0 && tokens.length < 10; i--) {
    const creds = await state.get<{ token?: string }>(`ilink:accounts:${accounts[i]}:credentials`);
    if (creds?.token?.trim()) {
      tokens.push(creds.token.trim());
    }
  }
  return tokens;
}

async function loadQRSession(state: StateAdapter, sessionKey: string): Promise<QRSessionData | undefined> {
  const data = await state.get<QRSessionData>(`${QR_SESSION_PREFIX}${sessionKey}`);
  if (!data) return undefined;
  if (Date.now() - data.startedAt > QR_SESSION_TTL_MS) {
    await deleteQRSession(state, sessionKey);
    return undefined;
  }
  return data;
}

async function saveQRSession(state: StateAdapter, sessionKey: string, data: QRSessionData): Promise<void> {
  await state.set(`${QR_SESSION_PREFIX}${sessionKey}`, data);
}

async function deleteQRSession(state: StateAdapter, sessionKey: string): Promise<void> {
  await state.delete(`${QR_SESSION_PREFIX}${sessionKey}`);
}

async function refreshQR(
  state: StateAdapter,
  sessionKey: string,
  botType: string,
  oldSession: QRSessionData,
): Promise<QRSessionData | null> {
  try {
    const localTokenList = await getLocalBotTokenList(state);
    const rawText = await apiPostFetch({
      baseUrl: FIXED_BASE_URL,
      endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
      body: JSON.stringify({ local_token_list: localTokenList }),
      label: "refreshQR",
    });
    const qrResponse = JSON.parse(rawText) as { qrcode: string; qrcode_img_content: string };
    const newSession: QRSessionData = {
      qrcode: qrResponse.qrcode,
      qrcodeUrl: qrResponse.qrcode_img_content,
      startedAt: Date.now(),
      currentBaseUrl: FIXED_BASE_URL,
    };
    await saveQRSession(state, sessionKey, newSession);
    return newSession;
  } catch (err) {
    console.error(`login: failed to refresh QR: ${String(err)}`);
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
