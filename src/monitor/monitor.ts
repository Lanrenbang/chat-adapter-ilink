/**
 * Long-poll monitor loop for receiving iLink messages.
 * Ported from openclaw-weixin src/monitor/monitor.ts.
 *
 * Adaptations:
 * - Removed openclaw/plugin-sdk dependencies
 * - Replaced file-based cursor storage with StateAdapter
 * - Replaced `processOneMessage` (OpenClaw pipeline) with `onMessage` callback
 * - Replaced logger with console
 */
import { getUpdates } from "../api/api.js";
import { SESSION_EXPIRED_ERRCODE } from "../api/session-guard.js";
import { loadCursor, saveCursor } from "../storage/sync-buf.js";
import type { StateAdapter } from "chat";
import type { WeixinMessage } from "../api/types.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

export type MonitorWeixinOpts = {
  baseUrl: string;
  token?: string;
  accountId: string;
  state: StateAdapter;
  abortSignal?: AbortSignal;
  longPollTimeoutMs?: number;
  /** Callback for each received message. */
  onMessage: (msg: WeixinMessage, accountId: string) => Promise<void>;
  /** Called when errcode -14 (session expired) is received. */
  onSessionExpired?: (accountId: string) => void;
  setStatus?: (status: { accountId: string; lastEventAt: number; lastInboundAt?: number }) => void;
  log?: (msg: string) => void;
  errLog?: (msg: string) => void;
};

/**
 * Long-poll loop: getUpdates -> onMessage -> save cursor.
 * Runs until abortSignal is aborted.
 */
export async function monitorWeixinProvider(opts: MonitorWeixinOpts): Promise<void> {
  const {
    baseUrl,
    token,
    accountId,
    state,
    abortSignal,
    longPollTimeoutMs,
    onMessage,
    onSessionExpired,
    setStatus,
  } = opts;
  const log = opts.log ?? (() => {});
  const errLog = opts.errLog ?? ((m: string) => log(m));

  log(`monitor started (${baseUrl}, account=${accountId})`);

  const getUpdatesBuf = await loadCursor(state, accountId);
  let cursor = getUpdatesBuf ?? "";

  if (cursor) {
    log(`resuming from previous cursor (${cursor.length} bytes)`);
  } else {
    log(`no previous cursor found, starting fresh`);
  }

  let nextTimeoutMs = longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;

  while (!abortSignal?.aborted) {
    try {
      const resp = await getUpdates({
        baseUrl,
        token,
        get_updates_buf: cursor,
        timeoutMs: nextTimeoutMs,
        abortSignal,
      });

      if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isApiError) {
        const isSessionExpired =
          resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE;

        if (isSessionExpired) {
          errLog(`getUpdates: session expired (errcode ${SESSION_EXPIRED_ERRCODE})`);
          consecutiveFailures = 0;
          onSessionExpired?.(accountId);
          return; // exit loop — the adapter will handle cleanup
        }

        consecutiveFailures += 1;
        errLog(
          `getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          errLog(`getUpdates: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`);
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, abortSignal);
        } else {
          await sleep(RETRY_DELAY_MS, abortSignal);
        }
        continue;
      }

      consecutiveFailures = 0;
      setStatus?.({ accountId, lastEventAt: Date.now() });

      if (resp.get_updates_buf != null && resp.get_updates_buf !== "") {
        await saveCursor(state, accountId, resp.get_updates_buf);
        cursor = resp.get_updates_buf;
      }

      const list = resp.msgs ?? [];
      for (const msg of list) {
        setStatus?.({ accountId, lastEventAt: Date.now(), lastInboundAt: Date.now() });
        try {
          await onMessage(msg, accountId);
        } catch (err) {
          errLog(`onMessage error: ${String(err)}`);
        }
      }
    } catch (err) {
      if (abortSignal?.aborted) {
        log(`monitor stopped (aborted)`);
        return;
      }
      consecutiveFailures += 1;
      errLog(`getUpdates error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        errLog(`getUpdates: ${MAX_CONSECUTIVE_FAILURES} consecutive errors, backing off 30s`);
        consecutiveFailures = 0;
        await sleep(BACKOFF_DELAY_MS, abortSignal);
      } else {
        await sleep(RETRY_DELAY_MS, abortSignal);
      }
    }
  }
  log(`monitor ended`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
