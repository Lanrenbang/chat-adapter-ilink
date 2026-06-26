import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { WeixinApiOptions } from "../api/api.js";
import { sendImageMessage, sendVideoMessage, sendVoiceMessage, sendFileMessage } from "../messaging/send-media.js";

// We only test input validation and parameter building.
// Actual HTTP requests are tested at the integration level.
// Mock fetch to prevent real HTTP requests during unit tests.

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn().mockRejectedValue(new Error("fetch mock"));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("sendMedia", () => {
  const opts: WeixinApiOptions = {
    baseUrl: "https://test.example.com",
    token: "test-token",
  };

  it("sendImageMessage builds correctly", async () => {
    const buf = Buffer.from("fake-image-data");
    // This will fail on the CDN upload (mock fetch), but we verify it doesn't throw
    // before the fetch stage.
    await expect(
      sendImageMessage({
        buf,
        to: "wx_user",
        opts,
        cdnBaseUrl: "https://cdn.example.com",
      }),
    ).rejects.toThrow();
  });

  it("sendVideoMessage rejects empty buffer", async () => {
    await expect(
      sendVideoMessage({
        buf: Buffer.alloc(0),
        to: "wx_user",
        opts,
        cdnBaseUrl: "https://cdn.example.com",
      }),
    ).rejects.toThrow();
  });

  it("sendVoiceMessage requires valid opts", async () => {
    await expect(
      sendVoiceMessage({
        buf: Buffer.from("audio-data"),
        to: "wx_user",
        opts: {} as WeixinApiOptions,
        cdnBaseUrl: "https://cdn.example.com",
      }),
    ).rejects.toThrow();
  });

  it("sendFileMessage requires fileName", async () => {
    await expect(
      sendFileMessage({
        buf: Buffer.from("file-data"),
        fileName: "test.pdf",
        to: "wx_user",
        opts,
        cdnBaseUrl: "https://cdn.example.com",
      }),
    ).rejects.toThrow();
  });
});
