/**
 * Account credential storage using StateAdapter.
 * Ported from openclaw-weixin src/auth/accounts.ts.
 *
 * Replaces node:fs with StateAdapter (KV/D1 compatible).
 */
import type { StateAdapter } from "chat";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

const ACCOUNTS_LIST_KEY = "ilink:accounts:list";
const accountCredsKey = (id: string) => `ilink:accounts:${id}:credentials`;

export interface AccountCredentials {
  token: string;
  baseUrl?: string;
  userId?: string;
  savedAt?: string;
}

/** List all registered account IDs. */
export async function listAccounts(state: StateAdapter): Promise<string[]> {
  return (await state.get<string[]>(ACCOUNTS_LIST_KEY)) ?? [];
}

/** Register a new account (or update existing). */
export async function registerAccount(
  state: StateAdapter,
  accountId: string,
  credentials: AccountCredentials,
): Promise<void> {
  const accounts = await listAccounts(state);
  if (!accounts.includes(accountId)) {
    await state.set(ACCOUNTS_LIST_KEY, [...accounts, accountId]);
  }
  const existing = await loadAccount(state, accountId);
  await state.set(accountCredsKey(accountId), {
    token: credentials.token,
    baseUrl: credentials.baseUrl || existing?.baseUrl,
    userId: credentials.userId !== undefined ? credentials.userId : existing?.userId,
    savedAt: new Date().toISOString(),
  });
}

/** Load account credentials by ID. */
export async function loadAccount(
  state: StateAdapter,
  accountId: string,
): Promise<AccountCredentials | null> {
  return state.get<AccountCredentials>(accountCredsKey(accountId));
}

/** Remove account and all associated state (cursor, context tokens). */
export async function clearAccount(state: StateAdapter, accountId: string): Promise<void> {
  const accounts = await listAccounts(state);
  await state.set(
    ACCOUNTS_LIST_KEY,
    accounts.filter((id) => id !== accountId),
  );
  await state.delete(accountCredsKey(accountId));
  await state.delete(`ilink:accounts:${accountId}:cursor`);
}

/**
 * Remove stale accounts that share the same userId as the newly-bound account.
 * Called after a successful QR login to ensure only the latest account remains
 * for a given WeChat user, preventing ambiguous contextToken matches.
 */
export async function clearStaleAccountsByUserId(
  state: StateAdapter,
  currentAccountId: string,
  userId: string,
  onClearContextTokens?: (accountId: string) => Promise<void>,
): Promise<void> {
  if (!userId) return;
  const allIds = await listAccounts(state);
  for (const id of allIds) {
    if (id === currentAccountId) continue;
    const data = await loadAccount(state, id);
    if (data?.userId?.trim() === userId) {
      console.debug(`clearStaleAccountsByUserId: removing stale account=${id} (same userId=${userId})`);
      await onClearContextTokens?.(id);
      await clearAccount(state, id);
    }
  }
}
