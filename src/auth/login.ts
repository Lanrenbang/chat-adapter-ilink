import type { StateAdapter } from "chat";
import { apiGetFetch, apiPostFetch } from "../api/api.js";

const FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const QR_SESSION_TTL_MS = 5 * 60_000;
const MAX_QR_REFRESH_COUNT = 3;
const DEFAULT_LOGIN_TIMEOUT_MS = 480_000;

export const DEFAULT_ILINK_BOT_TYPE = "3";

const QR_SESSION_PREFIX = "ilink:login:";

type QRSessionStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "scaned_but_redirect"
  | "need_verifycode"
  | "verify_code_blocked"
  | "binded_redirect";

type QRSessionData = {
  sessionKey: string;
  id: string;
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
  currentBaseUrl: string;
  status?: QRSessionStatus;
  /** Retry flag: set to "pending" on need_verifycode, cleared on success. */
  pendingVerifyCode?: string;
};

type StatusResponse = {
  status: QRSessionStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
};

export interface LoginOptions {
  /** Session key to resume an existing login session. Auto-generated if omitted. */
  sessionKey?: string;
  /** When true, skip QR cache and force new QR generation. */
  force?: boolean;
  /** Verify code (from `need_verifycode` status response). */
  verifyCode?: string;
  /** Bot type parameter (default: "3"). */
  botType?: string;
  /** Login timeout in ms (default: 480000 = 8 min). Only used in internal polling mode. */
  timeoutMs?: number;
  /**
   * Status change callback for internal polling mode.
   * When provided, login() polls internally and calls this on each status transition.
   * When omitted, login() returns immediately with single-shot result.
   *
   * @param status   - Current QR session status (always defined, default "wait")
   * @param qrcodeUrl - QR code image URL (undefined if not yet generated)
   * @param sessionKey - Session identifier for resuming/resubmitting
   */
  onStatusChange?: (status: string, qrcodeUrl: string | undefined, sessionKey: string) => void;
}

export interface LoginResult {
  connected: boolean;
  alreadyConnected?: boolean;
  botToken?: string;
  accountId?: string;
  baseUrl?: string;
  userId?: string;
  status: "success" | "need_verifycode" | "expired" | "blocked" | "error" | "wait";
  verifyCodePrompt?: string;
  error?: string;
  /** QR code image URL (set in single-shot mode or alongside result). */
  qrcodeUrl?: string;
  /** Session key for resuming polling (set in single-shot mode). */
  sessionKey?: string;
}

/**
 * Unified QR login interface.
 *
 * Two modes:
 *
 * **1. Internal polling** (provide `onStatusChange`):
 *    - Generates QR (or resumes existing session)
 *    - Calls `onStatusChange("wait", qrcodeUrl, sessionKey)` immediately
 *    - Long-polls `get_qrcode_status` until resolution
 *    - Calls `onStatusChange` on each status transition
 *    - Resolves with final `LoginResult`
 *    - On `need_verifycode`: returns early — caller must retry with `verifyCode`
 *
 * **2. Single-shot** (no `onStatusChange`):
 *    - First call (no `sessionKey`): generates QR, returns immediately
 *      with `{ qrcodeUrl, sessionKey, status: "wait" }`
 *    - Subsequent calls (with `sessionKey`): loads session, makes one
 *      poll call, returns current status
 *    - Caller decides external polling strategy
 *
 * @param state   - StateAdapter instance (from Chat SDK or standalone)
 * @param options - Login options
 */
export async function login(
  state: StateAdapter,
  options: LoginOptions = {},
): Promise<LoginResult> {
  const sessionKey = options.sessionKey ?? crypto.randomUUID();
  const botType = options.botType ?? DEFAULT_ILINK_BOT_TYPE;
  const isInternal = typeof options.onStatusChange === "function";

  let session: QRSessionData | undefined = await loadQRSession(state, sessionKey);
  if (!session || options.force) {
    const newSession = await generateNewQR(state, sessionKey, botType);
    if (!newSession) {
      return { connected: false, status: "error", error: "获取二维码失败" };
    }
    session = newSession;
    if (!session) {
      return { connected: false, status: "error", error: "获取二维码失败" };
    }
  }

  if (isInternal) {
    options.onStatusChange!("wait", session.qrcodeUrl, sessionKey);
  }

  if (!isInternal) {
    try {
      const pollResult = await pollQRStatus(
        session.currentBaseUrl,
        session.qrcode,
        options.verifyCode,
      );
      session.status = pollResult.status;
      await saveQRSession(state, sessionKey, session);
      return {
        connected: false,
        status: mapStatusToResult(pollResult.status),
        qrcodeUrl: session.qrcodeUrl,
        sessionKey,
      };
    } catch {
      return {
        connected: false,
        status: "wait",
        qrcodeUrl: session.qrcodeUrl,
        sessionKey,
      };
    }
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let qrRefreshCount = 1;

  while (Date.now() < deadline) {
    const currentBaseUrl = session.currentBaseUrl;

    let statusResponse: StatusResponse;
    try {
      const apiVerifyCode = options.verifyCode;
      statusResponse = await pollQRStatus(currentBaseUrl, session.qrcode, apiVerifyCode);
    } catch (err) {
      console.debug(`login: poll error (will retry): ${String(err)}`);
      await sleep(1000);
      continue;
    }

    session.status = statusResponse.status;
    await saveQRSession(state, sessionKey, session);
    options.onStatusChange!(statusResponse.status, session.qrcodeUrl, sessionKey);

    switch (statusResponse.status) {
      case "wait":
        break;

      case "scaned":
        session.pendingVerifyCode = undefined;
        await saveQRSession(state, sessionKey, session);
        break;

      case "need_verifycode": {
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
          qrcodeUrl: session.qrcodeUrl,
          sessionKey,
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
        const newQR = await refreshQR(state, sessionKey, botType);
        if (!newQR) {
          await deleteQRSession(state, sessionKey);
          return { connected: false, status: "expired", error: "刷新二维码失败" };
        }
        session = newQR;
        options.onStatusChange!("wait", session.qrcodeUrl, sessionKey);
        break;
      }

      case "binded_redirect":
        await deleteQRSession(state, sessionKey);
        return {
          connected: true,
          alreadyConnected: true,
          status: "success",
          qrcodeUrl: session.qrcodeUrl,
          sessionKey,
        };

      case "scaned_but_redirect": {
        const redirectHost = statusResponse.redirect_host;
        if (redirectHost) {
          session.currentBaseUrl = `https://${redirectHost}`;
          await saveQRSession(state, sessionKey, session);
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
        const refreshAfterBlock = await refreshQR(state, sessionKey, botType);
        if (!refreshAfterBlock) {
          await deleteQRSession(state, sessionKey);
          return { connected: false, status: "blocked", error: "多次输入错误" };
        }
        session = refreshAfterBlock;
        options.onStatusChange!("wait", session.qrcodeUrl, sessionKey);
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
          qrcodeUrl: session.qrcodeUrl,
          sessionKey,
        };
        await deleteQRSession(state, sessionKey);
        return result;
      }
    }

    await sleep(1000);
  }

  await deleteQRSession(state, sessionKey);
  return { connected: false, status: "expired", error: "登录超时" };
}

async function generateNewQR(
  state: StateAdapter,
  sessionKey: string,
  botType: string,
): Promise<QRSessionData | null> {
  try {
    const localTokenList = await getLocalBotTokenList(state);
    const rawText = await apiPostFetch({
      baseUrl: FIXED_BASE_URL,
      endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
      body: JSON.stringify({ local_token_list: localTokenList }),
      label: "fetchQRCode",
    });
    const qrResponse = JSON.parse(rawText) as {
      qrcode: string;
      qrcode_img_content: string;
    };

    const session: QRSessionData = {
      sessionKey,
      id: crypto.randomUUID(),
      qrcode: qrResponse.qrcode,
      qrcodeUrl: qrResponse.qrcode_img_content,
      startedAt: Date.now(),
      currentBaseUrl: FIXED_BASE_URL,
      status: "wait",
    };
    await saveQRSession(state, sessionKey, session);
    return session;
  } catch (err) {
    console.error(`login: failed to generate QR: ${String(err)}`);
    return null;
  }
}

async function pollQRStatus(
  baseUrl: string,
  qrcode: string,
  verifyCode?: string,
): Promise<StatusResponse> {
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
    const creds = await state.get<{ token?: string }>(
      `ilink:accounts:${accounts[i]}:credentials`,
    );
    if (creds?.token?.trim()) {
      tokens.push(creds.token.trim());
    }
  }
  return tokens;
}

async function loadQRSession(
  state: StateAdapter,
  sessionKey: string,
): Promise<QRSessionData | undefined> {
  const data = await state.get<QRSessionData>(
    `${QR_SESSION_PREFIX}${sessionKey}`,
  );
  if (!data) return undefined;
  if (Date.now() - data.startedAt > QR_SESSION_TTL_MS) {
    await deleteQRSession(state, sessionKey);
    return undefined;
  }
  return data;
}

async function saveQRSession(
  state: StateAdapter,
  sessionKey: string,
  data: QRSessionData,
): Promise<void> {
  await state.set(`${QR_SESSION_PREFIX}${sessionKey}`, data, QR_SESSION_TTL_MS);
}

async function deleteQRSession(
  state: StateAdapter,
  sessionKey: string,
): Promise<void> {
  await state.delete(`${QR_SESSION_PREFIX}${sessionKey}`);
}

async function refreshQR(
  state: StateAdapter,
  sessionKey: string,
  botType: string,
): Promise<QRSessionData | null> {
  try {
    const localTokenList = await getLocalBotTokenList(state);
    const rawText = await apiPostFetch({
      baseUrl: FIXED_BASE_URL,
      endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
      body: JSON.stringify({ local_token_list: localTokenList }),
      label: "refreshQR",
    });
    const qrResponse = JSON.parse(rawText) as {
      qrcode: string;
      qrcode_img_content: string;
    };

    const newSession: QRSessionData = {
      sessionKey,
      id: crypto.randomUUID(),
      qrcode: qrResponse.qrcode,
      qrcodeUrl: qrResponse.qrcode_img_content,
      startedAt: Date.now(),
      currentBaseUrl: FIXED_BASE_URL,
      status: "wait",
    };
    await saveQRSession(state, sessionKey, newSession);
    return newSession;
  } catch (err) {
    console.error(`login: failed to refresh QR: ${String(err)}`);
    return null;
  }
}

function mapStatusToResult(status: QRSessionStatus): LoginResult["status"] {
  switch (status) {
    case "confirmed":
    case "binded_redirect":
      return "success";
    case "need_verifycode":
      return "need_verifycode";
    case "expired":
      return "expired";
    case "verify_code_blocked":
      return "blocked";
    case "wait":
    case "scaned":
    case "scaned_but_redirect":
      return "wait";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
