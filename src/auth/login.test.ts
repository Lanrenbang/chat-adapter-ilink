import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { StateAdapter } from "chat";
import { login } from "./login.js";

vi.mock("../api/api.js", () => ({
  apiPostFetch: vi.fn(),
  apiGetFetch: vi.fn(),
}));

import { apiPostFetch, apiGetFetch } from "../api/api.js";

const qr1 = {
  qrcode: "qrcode_raw_abc123",
  qrcode_img_content: "https://qr.example.com/qrcode_abc123",
};

const qr2 = {
  qrcode: "qrcode_raw_def456",
  qrcode_img_content: "https://qr.example.com/qrcode_def456",
};

describe("login", () => {
  let state: StateAdapter;

  beforeEach(async () => {
    state = createMemoryState();
    await state.connect();
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.mocked(apiPostFetch).mockResolvedValue(JSON.stringify(qr1));
    vi.mocked(apiGetFetch).mockResolvedValue(JSON.stringify({ status: "wait" }));
  });

  describe("single-shot mode (no onStatusChange)", () => {
    it("generates QR and returns immediately", async () => {
      const result = await login(state);

      expect(apiPostFetch).toHaveBeenCalledTimes(1);
      expect(result.qrcodeUrl).toBe(qr1.qrcode_img_content);
      expect(result.sessionKey).toBeDefined();
      expect(result.status).toBe("wait");
      expect(result.connected).toBe(false);
    });

    it("resumes existing session when called with sessionKey", async () => {
      const first = await login(state);
      vi.mocked(apiGetFetch).mockResolvedValueOnce(
        JSON.stringify({ status: "scaned" }),
      );

      const resumed = await login(state, { sessionKey: first.sessionKey });
      expect(resumed.sessionKey).toBe(first.sessionKey);
      expect(resumed.qrcodeUrl).toBe(first.qrcodeUrl);
    });

    it("returns error when QR generation fails", async () => {
      vi.mocked(apiPostFetch).mockRejectedValueOnce(new Error("fail"));

      const result = await login(state);
      expect(result.status).toBe("error");
      expect(result.connected).toBe(false);
    });
  });

  describe("internal polling mode (with onStatusChange)", () => {
    it("calls onStatusChange on each status transition", async () => {
      const onStatusChange = vi.fn();

      vi.mocked(apiGetFetch)
        .mockResolvedValueOnce(JSON.stringify({ status: "wait" }))
        .mockResolvedValueOnce(
          JSON.stringify({
            status: "confirmed",
            ilink_bot_id: "bot_xyz@im.bot",
            bot_token: "tok_xyz",
            ilink_user_id: "user_xyz@im.wechat",
          }),
        );

      const result = await login(state, { onStatusChange, timeoutMs: 10000 });

      expect(onStatusChange).toHaveBeenNthCalledWith(
        1,
        "wait",
        qr1.qrcode_img_content,
        expect.any(String),
      );
      expect(onStatusChange).toHaveBeenCalledWith(
        "confirmed",
        qr1.qrcode_img_content,
        expect.any(String),
      );
      expect(result.connected).toBe(true);
      expect(result.status).toBe("success");
      expect(result.botToken).toBe("tok_xyz");
      expect(result.accountId).toBe("bot_xyz@im.bot");
    });

    it("returns need_verifycode and preserves session", async () => {
      const sessionKey = "test-session";
      vi.mocked(apiGetFetch).mockResolvedValueOnce(
        JSON.stringify({ status: "need_verifycode" }),
      );

      const result1 = await login(state, {
        sessionKey,
        onStatusChange: vi.fn(),
        timeoutMs: 10000,
      });
      expect(result1.status).toBe("need_verifycode");
      expect(result1.verifyCodePrompt).toBe("输入手机微信显示的数字：");

      vi.mocked(apiGetFetch).mockResolvedValueOnce(
        JSON.stringify({ status: "need_verifycode" }),
      );

      const result2 = await login(state, {
        sessionKey,
        verifyCode: "123456",
        onStatusChange: vi.fn(),
        timeoutMs: 10000,
      });
      expect(result2.status).toBe("need_verifycode");
      expect(result2.verifyCodePrompt).toContain("不匹配");
    });

    it("refreshes QR on expired and retries", async () => {
      vi.mocked(apiGetFetch)
        .mockResolvedValueOnce(JSON.stringify({ status: "expired" }))
        .mockResolvedValueOnce(
          JSON.stringify({
            status: "confirmed",
            ilink_bot_id: "bot_refresh@im.bot",
          }),
        );
      vi.mocked(apiPostFetch).mockResolvedValue(JSON.stringify(qr2));

      const result = await login(state, {
        onStatusChange: vi.fn(),
        timeoutMs: 10000,
      });

      expect(apiPostFetch).toHaveBeenCalledTimes(2);
      expect(result.connected).toBe(true);
      expect(result.accountId).toBe("bot_refresh@im.bot");
    });

    it("stops after MAX_QR_REFRESH_COUNT expired", async () => {
      vi.mocked(apiGetFetch).mockResolvedValue(
        JSON.stringify({ status: "expired" }),
      );
      vi.mocked(apiPostFetch).mockResolvedValue(JSON.stringify(qr2));

      const result = await login(state, {
        onStatusChange: vi.fn(),
        timeoutMs: 10000,
      });

      expect(apiPostFetch).toHaveBeenCalledTimes(3);
      expect(result.status).toBe("expired");
      expect(result.error).toContain("多次过期");
    });

    it("handles binded_redirect as already connected", async () => {
      vi.mocked(apiGetFetch).mockResolvedValueOnce(
        JSON.stringify({ status: "binded_redirect" }),
      );

      const result = await login(state, {
        onStatusChange: vi.fn(),
        timeoutMs: 10000,
      });

      expect(result.connected).toBe(true);
      expect(result.alreadyConnected).toBe(true);
      expect(result.status).toBe("success");
    });

    it("handles scaned_but_redirect and follows redirect host", async () => {
      vi.mocked(apiGetFetch)
        .mockResolvedValueOnce(
          JSON.stringify({
            status: "scaned_but_redirect",
            redirect_host: "redirect.weixin.qq.com",
          }),
        )
        .mockResolvedValueOnce(
          JSON.stringify({
            status: "confirmed",
            ilink_bot_id: "bot_redirect@im.bot",
          }),
        );

      const result = await login(state, {
        onStatusChange: vi.fn(),
        timeoutMs: 10000,
      });

      expect(result.connected).toBe(true);
      expect(result.accountId).toBe("bot_redirect@im.bot");
    });

    it("handles verify_code_blocked by refreshing QR", async () => {
      vi.mocked(apiGetFetch)
        .mockResolvedValueOnce(
          JSON.stringify({ status: "verify_code_blocked" }),
        )
        .mockResolvedValueOnce(
          JSON.stringify({
            status: "confirmed",
            ilink_bot_id: "bot_blocked@im.bot",
          }),
        );
      vi.mocked(apiPostFetch).mockResolvedValue(JSON.stringify(qr2));

      const result = await login(state, {
        onStatusChange: vi.fn(),
        timeoutMs: 10000,
      });

      expect(apiPostFetch).toHaveBeenCalledTimes(2);
      expect(result.connected).toBe(true);
      expect(result.accountId).toBe("bot_blocked@im.bot");
    });

    it("times out and returns expired", async () => {
      vi.mocked(apiGetFetch).mockResolvedValue(
        JSON.stringify({ status: "wait" }),
      );

      const result = await login(state, {
        onStatusChange: vi.fn(),
        timeoutMs: 100,
      });

      expect(result.status).toBe("expired");
      expect(result.error).toContain("超时");
    });
  });

  describe("session persistence", () => {
    it("reuses existing session when not forced", async () => {
      const first = await login(state);
      const second = await login(state, { sessionKey: first.sessionKey });

      expect(second.qrcodeUrl).toBe(first.qrcodeUrl);
      expect(apiPostFetch).toHaveBeenCalledTimes(1);
    });

    it("generates new QR when force=true", async () => {
      const first = await login(state);
      vi.mocked(apiPostFetch).mockResolvedValue(JSON.stringify(qr2));

      const second = await login(state, {
        sessionKey: first.sessionKey,
        force: true,
      });

      expect(second.qrcodeUrl).toBe(qr2.qrcode_img_content);
      expect(apiPostFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("storage TTL", () => {
    it("saves QR session with 5-minute TTL", async () => {
      const setSpy = vi.spyOn(state, "set");
      await login(state);

      expect(setSpy).toHaveBeenCalledWith(
        expect.stringContaining("ilink:login:"),
        expect.objectContaining({ qrcode: qr1.qrcode }),
        300_000,
      );
    });

    it("deletes session on terminal status", async () => {
      vi.mocked(apiGetFetch).mockResolvedValueOnce(
        JSON.stringify({
          status: "confirmed",
          ilink_bot_id: "bot_del@im.bot",
        }),
      );
      const deleteSpy = vi.spyOn(state, "delete");

      await login(state, { onStatusChange: vi.fn(), timeoutMs: 10000 });

      expect(deleteSpy).toHaveBeenCalledWith(
        expect.stringContaining("ilink:login:"),
      );
    });
  });

  describe("error handling", () => {
    it("returns error when QR generation API fails", async () => {
      vi.mocked(apiPostFetch).mockRejectedValue(new Error("Network fail"));

      const result = await login(state);
      expect(result.status).toBe("error");
    });
  });
});
