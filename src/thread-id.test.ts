import { describe, it, expect } from "vitest";
import { encodeThreadId, decodeThreadId } from "./messaging/process-message.js";

describe("thread ID encoding", () => {
  it("roundtrips a basic thread ID", () => {
    const accountId = "bot_abc123";
    const userId = "wx_user_xyz";
    const encoded = encodeThreadId(accountId, userId);
    expect(encoded).toBe("ilink:bot_abc123/wx_user_xyz:wx_user_xyz");
    const decoded = decodeThreadId(encoded);
    expect(decoded.accountId).toBe(accountId);
    expect(decoded.userId).toBe(userId);
  });

  it("decodes a 2-segment channel ID", () => {
    const decoded = decodeThreadId("ilink:bot_abc/wx_user_xyz");
    expect(decoded.accountId).toBe("bot_abc");
    expect(decoded.userId).toBe("wx_user_xyz");
  });

  it("throws on invalid format (no prefix)", () => {
    expect(() => decodeThreadId("invalid")).toThrow("Invalid thread ID");
  });

  it("throws on invalid format (wrong prefix)", () => {
    expect(() => decodeThreadId("slack:C123:ts")).toThrow("Invalid thread ID");
  });

  it("throws on invalid format (no slash separator)", () => {
    expect(() => decodeThreadId("ilink:only")).toThrow("Invalid thread ID");
  });

  it("throws on empty string", () => {
    expect(() => decodeThreadId("")).toThrow("Invalid thread ID");
  });
});
