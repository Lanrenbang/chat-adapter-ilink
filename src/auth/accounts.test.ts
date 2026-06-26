import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { StateAdapter } from "chat";
import {
  registerAccount,
  loadAccount,
  listAccounts,
  clearAccount,
  clearStaleAccountsByUserId,
} from "../auth/accounts.js";

describe("account management", () => {
  let state: StateAdapter;

  beforeEach(async () => {
    state = createMemoryState();
    await state.connect();
  });

  it("registers and loads an account", async () => {
    await registerAccount(state, "bot_abc", {
      token: "tok_abc123",
      baseUrl: "https://ilinkai.weixin.qq.com",
      userId: "wx_user_alice",
    });

    const loaded = await loadAccount(state, "bot_abc");
    expect(loaded).toBeDefined();
    expect(loaded!.token).toBe("tok_abc123");
    expect(loaded!.baseUrl).toBe("https://ilinkai.weixin.qq.com");
    expect(loaded!.userId).toBe("wx_user_alice");
    expect(loaded!.savedAt).toBeDefined();
  });

  it("lists registered accounts", async () => {
    await registerAccount(state, "bot_a", { token: "tok_a" });
    await registerAccount(state, "bot_b", { token: "tok_b" });

    const accounts = await listAccounts(state);
    expect(accounts).toContain("bot_a");
    expect(accounts).toContain("bot_b");
  });

  it("clears an account", async () => {
    await registerAccount(state, "bot_abc", { token: "tok_abc" });
    await clearAccount(state, "bot_abc");

    const loaded = await loadAccount(state, "bot_abc");
    expect(loaded).toBeNull();
    const accounts = await listAccounts(state);
    expect(accounts).not.toContain("bot_abc");
  });

  it("updates existing account credentials", async () => {
    await registerAccount(state, "bot_abc", {
      token: "old_token",
      baseUrl: "https://old.example.com",
    });
    await registerAccount(state, "bot_abc", {
      token: "new_token",
      userId: "wx_new_user",
    });

    const loaded = await loadAccount(state, "bot_abc");
    expect(loaded!.token).toBe("new_token");
    expect(loaded!.baseUrl).toBe("https://old.example.com"); // preserved from old
    expect(loaded!.userId).toBe("wx_new_user");
  });

  it("loadAccount returns undefined for unknown account", async () => {
    const loaded = await loadAccount(state, "nonexistent");
    expect(loaded).toBeNull();
  });

  it("listAccounts returns empty array when no accounts", async () => {
    const accounts = await listAccounts(state);
    expect(accounts).toEqual([]);
  });

  it("clearStaleAccountsByUserId removes accounts with same userId", async () => {
    await registerAccount(state, "bot_a", { token: "tok_a", userId: "wx_user" });
    await registerAccount(state, "bot_b", { token: "tok_b", userId: "wx_user" });
    await registerAccount(state, "bot_c", { token: "tok_c", userId: "wx_other" });

    await clearStaleAccountsByUserId(state, "bot_b", "wx_user");

    const accounts = await listAccounts(state);
    expect(accounts).not.toContain("bot_a");
    expect(accounts).toContain("bot_b");
    expect(accounts).toContain("bot_c");
  });

  it("clearStaleAccountsByUserId does nothing with empty userId", async () => {
    await registerAccount(state, "bot_a", { token: "tok_a", userId: "wx_user" });
    await clearStaleAccountsByUserId(state, "bot_a", "");
    const accounts = await listAccounts(state);
    expect(accounts).toContain("bot_a");
  });
});
