/**
 * get_updates_buf cursor persistence using StateAdapter.
 * Ported from openclaw-weixin src/storage/sync-buf.ts.
 *
 * Replaces node:fs with StateAdapter (KV/D1 compatible).
 * Key format: `ilink:accounts:{accountId}:cursor`
 */
import type { StateAdapter } from "chat";

export function getSyncBufKey(accountId: string): string {
  return `ilink:accounts:${accountId}:cursor`;
}

/**
 * Load persisted get_updates_buf for an account.
 * Returns empty string when none found (first request or after reset).
 */
export async function loadCursor(state: StateAdapter, accountId: string): Promise<string> {
  const value = await state.get<string>(getSyncBufKey(accountId));
  return value ?? "";
}

/**
 * Persist get_updates_buf for an account.
 */
export async function saveCursor(state: StateAdapter, accountId: string, cursor: string): Promise<void> {
  await state.set(getSyncBufKey(accountId), cursor);
}
