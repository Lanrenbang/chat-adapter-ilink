import type { StateAdapter } from "chat";
import { apiGetFetch, apiPostFetch } from "../api/api.js";

const FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const QR_SESSION_TTL_MS = 5 * 60_000;
const MAX_QR_REFRESH_COUNT = 3;
/** Default login timeout (8 minutes), minimum 1s. */
const DEFAULT_LOGIN_TIMEOUT_MS = 480_000;

export const DEFAULT_ILINK_BOT_TYPE = "3";

const QR_SESSION_PREFIX = "ilink:login:";

/**
 * Raw upstream QR status values returned by Weixin iLink API.
 * - `wait` — waiting for scan
 * - `scaned` — QR scanned by phone
 * - `confirmed` — user confirmed login on phone
 * - `expired` — QR code expired
 * - `scaned_but_redirect` — scanned but needs IDC redirect
 * - `need_verifycode` — pairing/verify code required
 * - `verify_code_blocked` — too many incorrect verify codes
 * - `binded_redirect` — already bound (valid token exists)
 */
export type QRSessionStatus =
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
  /** Set to "pending" when a verify code is needed; cleared on success. */
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
  /** Login timeout in ms (default: 480000 = 8 min, minimum 1s). Only used in internal polling mode. */
  timeoutMs?: number;
  /**
   * Status change callback for internal polling mode.
   * When provided, `login()` polls internally and calls this on each status transition.
   * When omitted, `login()` returns immediately with single-shot result.
   *
   * @param status    - Current QR session status (raw upstream value)
   * @param qrcodeUrl - QR code image URL (undefined if not yet generated)
   * @param sessionKey - Session identifier for resuming/resubmitting
   */
  onStatusChange?: (status: string, qrcodeUrl: string | undefined, sessionKey: string) => void;
}

/**
 * Public login result — only exposes what the caller needs to display
 * and interact with the login flow.
 *
 * - `status` — raw upstream QR status (the caller checks this to decide next action)
 * - `qrcodeUrl` — QR image URL for display
 * - `sessionKey` — opaque token to resume this session
 * - `message` — human-readable prompt or error description
 */
export interface LoginResult {
  status: QRSessionStatus;
  /** QR code image URL (set when QR is generated). */
  qrcodeUrl?: string;
  /** Session key for resuming polling. */
  sessionKey?: string;
  /** Human-readable message (prompt, error, or status description). */
  message?: string;
}

/**
 * Extended internal result — carries bot credentials so the adapter can
 * auto-register the account on success. Never exposed to end users.
 */
export type LoginResultInternal = LoginResult & {
  botToken?: string;
  accountId?: string;
  baseUrl?: string;
  userId?: string;
};

// ---------------------------------------------------------------------------
// Message helpers (aligned with upstream openclaw-weixin)
// ---------------------------------------------------------------------------

function statusMessage(status: QRSessionStatus, detail?: string): string {
  switch (status) {
    case "wait":
      return "用手机微信扫描以下二维码，以继续连接。";
    case "scaned":
      return "正在验证…";
    case "confirmed":
      return "已连接微信。";
    case "binded_redirect":
      return "已连接过此账号，无需重复连接。";
    case "need_verifycode":
      return detail ?? "请输入手机微信上显示的数字。";
    case "verify_code_blocked":
      return "多次输入错误，请稍后再试。";
    case "expired":
      return detail ?? "二维码已过期。";
    case "scaned_but_redirect":
      return "正在切换节点…";
  }
}

// ---------------------------------------------------------------------------
// Login implementation
// ---------------------------------------------------------------------------

export async function loginImpl(
  state: StateAdapter,
  options: LoginOptions = {},
): Promise<LoginResultInternal> {
  const sessionKey = options.sessionKey ?? crypto.randomUUID();
  const botType = options.botType ?? DEFAULT_ILINK_BOT_TYPE;
  const hasCallback = typeof options.onStatusChange === "function";

  // ---------- Phase 1: load or generate QR ----------
  let session: QRSessionData | undefined = await loadQRSession(state, sessionKey);
  if (!session || options.force) {
    const newSession = await generateNewQR(state, sessionKey, botType);
    if (!newSession) {
      return { status: "expired", message: "获取二维码失败。" };
    }
    session = newSession;
  }

  // ---------- Phase 2: decide mode ----------
  if (hasCallback) {
    // Internal polling mode — fire initial "wait" before the first long-poll
    options.onStatusChange!("wait", session.qrcodeUrl, sessionKey);
    return pollLoop(state, session, options as Required<Pick<LoginOptions, "onStatusChange">> & LoginOptions, botType);
  }

  // Single-shot mode
  if (!options.sessionKey) {
    // First call: return QR immediately, no poll
    return {
      status: "wait",
      qrcodeUrl: session.qrcodeUrl,
      sessionKey,
      message: statusMessage("wait"),
    };
  }

  // Subsequent call with sessionKey: poll once
  try {
    const pollResult = await pollQRStatus(
      session.currentBaseUrl,
      session.qrcode,
      options.verifyCode,
    );
    session.status = pollResult.status;
    await saveQRSession(state, sessionKey, session);
    return makeResult(pollResult, session.qrcodeUrl, sessionKey);
  } catch {
    return {
      status: "wait",
      qrcodeUrl: session.qrcodeUrl,
      sessionKey,
      message: statusMessage("wait"),
    };
  }
}

// ---------------------------------------------------------------------------
// Internal polling loop
// ---------------------------------------------------------------------------

async function pollLoop(
  state: StateAdapter,
  session: QRSessionData,
  options: Required<Pick<LoginOptions, "onStatusChange">> & LoginOptions,
  botType: string,
): Promise<LoginResultInternal> {
  const sessionKey = session.sessionKey;
  const timeoutMs = Math.max(options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS, 1000);
  const deadline = Date.now() + timeoutMs;
  let qrRefreshCount = 1;

  while (Date.now() < deadline) {
    const currentBaseUrl = session.currentBaseUrl;

    let statusResponse: StatusResponse;
    try {
      statusResponse = await pollQRStatus(currentBaseUrl, session.qrcode, options.verifyCode);
    } catch (err) {
      console.debug(`login: poll error (will retry): ${String(err)}`);
      await sleep(1000);
      continue;
    }

    session.status = statusResponse.status;
    await saveQRSession(state, sessionKey, session);
    options.onStatusChange(statusResponse.status, session.qrcodeUrl, sessionKey);

    switch (statusResponse.status) {
      case "wait":
        break;

      case "scaned":
        session.pendingVerifyCode = undefined;
        await saveQRSession(state, sessionKey, session);
        break;

      case "need_verifycode": {
        const isRetry = session.pendingVerifyCode !== undefined;
        session.pendingVerifyCode = "pending";
        await saveQRSession(state, sessionKey, session);
        const prompt = isRetry
          ? "❌ 配对码不匹配，请重新输入："
          : "输入手机微信显示的数字：";
        return {
          status: "need_verifycode",
          qrcodeUrl: session.qrcodeUrl,
          sessionKey,
          message: prompt,
        };
      }

      case "expired": {
        qrRefreshCount++;
        if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
          await deleteQRSession(state, sessionKey);
          return {
            status: "expired",
            message: "二维码多次过期，登录流程已停止。",
          };
        }
        const newQr = await refreshQR(state, sessionKey, botType);
        if (!newQr) {
          await deleteQRSession(state, sessionKey);
          return { status: "expired", message: "刷新二维码失败。" };
        }
        session = newQr;
        options.onStatusChange("wait", session.qrcodeUrl, sessionKey);
        break;
      }

      case "binded_redirect":
        await deleteQRSession(state, sessionKey);
        return {
          status: "binded_redirect",
          qrcodeUrl: session.qrcodeUrl,
          sessionKey,
          message: statusMessage("binded_redirect"),
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
          return { status: "verify_code_blocked", message: "多次输入错误，登录流程已停止。" };
        }
        session.pendingVerifyCode = undefined;
        const refreshed = await refreshQR(state, sessionKey, botType);
        if (!refreshed) {
          await deleteQRSession(state, sessionKey);
          return { status: "verify_code_blocked", message: "多次输入错误。" };
        }
        session = refreshed;
        options.onStatusChange("wait", session.qrcodeUrl, sessionKey);
        break;
      }

      case "confirmed": {
        if (!statusResponse.ilink_bot_id) {
          await deleteQRSession(state, sessionKey);
          return { status: "expired", message: "登录失败：服务器未返回 ilink_bot_id。" };
        }
        await deleteQRSession(state, sessionKey);
        return {
          status: "confirmed",
          qrcodeUrl: session.qrcodeUrl,
          sessionKey,
          message: statusMessage("confirmed"),
          // Internal fields — consumed by adapter.login() for auto-registration
          botToken: statusResponse.bot_token,
          accountId: statusResponse.ilink_bot_id,
          baseUrl: statusResponse.baseurl,
          userId: statusResponse.ilink_user_id,
        };
      }
    }

    await sleep(1000);
  }

  await deleteQRSession(state, sessionKey);
  return { status: "expired", message: "登录超时，请重试。" };
}

// ---------------------------------------------------------------------------
// Result builder for single-shot mode
// ---------------------------------------------------------------------------

function makeResult(
  statusResponse: StatusResponse,
  qrcodeUrl: string,
  sessionKey: string,
): LoginResultInternal {
  const result: LoginResultInternal = {
    status: statusResponse.status,
    qrcodeUrl,
    sessionKey,
    message: statusMessage(statusResponse.status),
  };

  if (statusResponse.ilink_bot_id) {
    result.accountId = statusResponse.ilink_bot_id;
    result.botToken = statusResponse.bot_token;
    result.baseUrl = statusResponse.baseurl;
    result.userId = statusResponse.ilink_user_id;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  const data = await state.get<QRSessionData>(`${QR_SESSION_PREFIX}${sessionKey}`);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
