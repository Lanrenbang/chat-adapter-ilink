import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { StateAdapter, ChatInstance, Logger } from "chat";
import { createILinkAdapter } from "../factory.js";
import type { ILinkAdapter } from "../adapter.js";

const mockLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
};

vi.mock("../api/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/api.js")>();
  return {
    ...actual,
    apiPostFetch: vi.fn(),
    apiGetFetch: vi.fn(),
  };
});

import { apiPostFetch, apiGetFetch } from "../api/api.js";

const QR1 = {
  qrcode: "qrcode_raw_abc123",
  qrcode_img_content: "https://qr.example.com/qrcode_abc123",
};

const QR2 = {
  qrcode: "qrcode_raw_def456",
  qrcode_img_content: "https://qr.example.com/qrcode_def456",
};

function createMockChat(state: StateAdapter): ChatInstance {
  return {
    getLogger: () => mockLogger as unknown as Logger,
    getState: () => state,
  } as unknown as ChatInstance;
}

describe("ILinkAdapter.login", () => {
  let state: StateAdapter;
  let adapter: ILinkAdapter;

  beforeEach(async () => {
    state = createMemoryState();
    await state.connect();
    vi.clearAllMocks();
    vi.mocked(apiPostFetch).mockResolvedValue(JSON.stringify(QR1));
    vi.mocked(apiGetFetch).mockResolvedValue(JSON.stringify({ status: "wait" }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});

    adapter = createILinkAdapter();
    await adapter.initialize(createMockChat(state));
  });

  afterEach(() => {
    // Clean up any poll loops started by login tests
    (adapter as any).pollLoops.forEach((loop: any) => {
      loop.abortController?.abort();
    });
    (adapter as any).pollLoops.clear();
  });

  describe("single-shot mode (no onStatusChange)", () => {
    it("generates QR and returns immediately without polling", async () => {
      const result = await adapter.login();

      expect(apiPostFetch).toHaveBeenCalledTimes(1);
      expect(apiGetFetch).not.toHaveBeenCalled(); // no poll on first call
      expect(result.qrcodeUrl).toBe(QR1.qrcode_img_content);
      expect(result.sessionKey).toBeDefined();
      expect(result.status).toBe("wait");
      expect(result.message).toContain("扫描");
    });

    it("polls once when called with sessionKey", async () => {
      const first = await adapter.login();

      vi.mocked(apiGetFetch).mockResolvedValueOnce(
        JSON.stringify({ status: "scaned" }),
      );

      const second = await adapter.login({ sessionKey: first.sessionKey });
      expect(apiGetFetch).toHaveBeenCalledTimes(1);
      expect(second.status).toBe("scaned");
      expect(second.qrcodeUrl).toBe(first.qrcodeUrl);
    });

    it("returns expired on QR generation failure", async () => {
      vi.mocked(apiPostFetch).mockRejectedValueOnce(new Error("fail"));

      const result = await adapter.login();
      expect(result.status).toBe("expired");
      expect(result.message).toContain("获取二维码失败");
    });
  });

  describe("internal polling mode (with onStatusChange)", () => {
    it("calls onStatusChange with wait before first poll", async () => {
      const onStatusChange = vi.fn();
      vi.mocked(apiGetFetch).mockResolvedValue(JSON.stringify({ status: "wait" }));

      await adapter.login({ onStatusChange, timeoutMs: 100 });

      expect(onStatusChange).toHaveBeenNthCalledWith(1, {
        status: "wait",
        qrcodeUrl: QR1.qrcode_img_content,
        sessionKey: expect.any(String),
      });
    }, 10000);

    it("returns confirmed and auto-registers", async () => {
      vi.mocked(apiGetFetch).mockResolvedValueOnce(
        JSON.stringify({
          status: "confirmed",
          ilink_bot_id: "bot_xyz@im.bot",
          bot_token: "tok_xyz",
          baseurl: "https://ilinkai.weixin.qq.com",
          ilink_user_id: "user_xyz@im.wechat",
        }),
      );

      const result = await adapter.login({
        onStatusChange: vi.fn(),
        timeoutMs: 10000,
      });

      expect(result.status).toBe("confirmed");
      // Public result must NOT expose internal fields
      expect((result as any).botToken).toBeUndefined();
      expect((result as any).accountId).toBeUndefined();
      // Verify account was registered in state by checking accounts list
      const accounts = await state.get<string[]>("ilink:accounts:list");
      expect(accounts).toContain("bot_xyz@im.bot");
    }, 10000);

    it("returns need_verifycode with prompt in message", async () => {
      vi.mocked(apiGetFetch).mockResolvedValueOnce(
        JSON.stringify({ status: "need_verifycode" }),
      );

      const result = await adapter.login({
        onStatusChange: vi.fn(),
        timeoutMs: 10000,
      });

      expect(result.status).toBe("need_verifycode");
      expect(result.message).toContain("输入手机微信显示的数字");
      expect(result.sessionKey).toBeDefined();
    });

    it("retries need_verifycode with verifyCode", async () => {
      const sessionKey = "test-session";
      // First call returns need_verifycode, second with verifyCode returns scaned
      vi.mocked(apiGetFetch)
        .mockResolvedValueOnce(JSON.stringify({ status: "need_verifycode" }))
        .mockResolvedValueOnce(JSON.stringify({ status: "confirmed", ilink_bot_id: "bot_cv@im.bot", bot_token: "tok" }));

      // First call: triggers need_verifycode
      const r1 = await adapter.login({
        sessionKey,
        onStatusChange: vi.fn(),
        timeoutMs: 10000,
      });
      expect(r1.status).toBe("need_verifycode");

      // Second call: resume with verifyCode
      const r2 = await adapter.login({
        sessionKey,
        verifyCode: "123456",
        onStatusChange: vi.fn(),
        timeoutMs: 10000,
      });
      expect(r2.status).toBe("confirmed");
      // verifyCode was passed to pollQRStatus via options
      // (logged by apiGetFetch mock — we check it was the second call)
      expect(apiGetFetch).toHaveBeenCalledTimes(2);
    }, 10000);

    it("refreshes QR on expired and retries", async () => {
      vi.mocked(apiGetFetch)
        .mockResolvedValueOnce(JSON.stringify({ status: "expired" }))
        .mockResolvedValueOnce(JSON.stringify({ status: "confirmed", ilink_bot_id: "bot_xyz@im.bot", bot_token: "tok" }));
      vi.mocked(apiPostFetch).mockResolvedValue(JSON.stringify(QR2));

      const result = await adapter.login({
        onStatusChange: vi.fn(),
        timeoutMs: 10000,
      });

      expect(apiPostFetch).toHaveBeenCalledTimes(2);
      expect(result.status).toBe("confirmed");
    }, 10000);

    it("stops after MAX_QR_REFRESH_COUNT expired", async () => {
      vi.mocked(apiGetFetch).mockResolvedValue(JSON.stringify({ status: "expired" }));
      vi.mocked(apiPostFetch).mockResolvedValue(JSON.stringify(QR2));

      const result = await adapter.login({
        onStatusChange: vi.fn(),
        timeoutMs: 10000,
      });

      expect(apiPostFetch).toHaveBeenCalledTimes(3);
      expect(result.status).toBe("expired");
      expect(result.message).toContain("多次过期");
    }, 10000);

    it("handles binded_redirect", async () => {
      vi.mocked(apiGetFetch).mockResolvedValueOnce(
        JSON.stringify({ status: "binded_redirect" }),
      );

      const result = await adapter.login({
        onStatusChange: vi.fn(),
        timeoutMs: 10000,
      });

      expect(result.status).toBe("binded_redirect");
      expect(result.message).toContain("已连接过");
    }, 10000);

    it("handles scaned_but_redirect and follows redirect host", async () => {
      vi.mocked(apiGetFetch)
        .mockResolvedValueOnce(
          JSON.stringify({
            status: "scaned_but_redirect",
            redirect_host: "redirect.weixin.qq.com",
          }),
        )
        .mockResolvedValueOnce(
          JSON.stringify({ status: "confirmed", ilink_bot_id: "bot_xyz@im.bot", bot_token: "tok" }),
        );

      const result = await adapter.login({
        onStatusChange: vi.fn(),
        timeoutMs: 10000,
      });

      expect(result.status).toBe("confirmed");
    }, 10000);

    it("handles verify_code_blocked by refreshing QR", async () => {
      vi.mocked(apiGetFetch)
        .mockResolvedValueOnce(JSON.stringify({ status: "verify_code_blocked" }))
        .mockResolvedValueOnce(JSON.stringify({ status: "confirmed", ilink_bot_id: "bot_xyz@im.bot", bot_token: "tok" }));
      vi.mocked(apiPostFetch).mockResolvedValue(JSON.stringify(QR2));

      const result = await adapter.login({
        onStatusChange: vi.fn(),
        timeoutMs: 10000,
      });

      expect(apiPostFetch).toHaveBeenCalledTimes(2);
      expect(result.status).toBe("confirmed");
    }, 10000);

    it("times out and returns expired", async () => {
      vi.mocked(apiGetFetch).mockResolvedValue(JSON.stringify({ status: "wait" }));

      const result = await adapter.login({
        onStatusChange: vi.fn(),
        timeoutMs: 100,
      });

      expect(result.status).toBe("expired");
      expect(result.message).toContain("超时");
    }, 10000);
  });

  describe("session persistence", () => {
    it("reuses existing session when not forced", async () => {
      const first = await adapter.login();
      const second = await adapter.login({ sessionKey: first.sessionKey });

      expect(second.qrcodeUrl).toBe(first.qrcodeUrl);
      expect(apiPostFetch).toHaveBeenCalledTimes(1);
    });

    it("generates new QR when force=true", async () => {
      const first = await adapter.login();
      vi.mocked(apiPostFetch).mockResolvedValue(JSON.stringify(QR2));

      const second = await adapter.login({
        sessionKey: first.sessionKey,
        force: true,
      });

      expect(second.qrcodeUrl).toBe(QR2.qrcode_img_content);
      expect(apiPostFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("internal fields not exposed", () => {
    it("does not expose botToken, accountId, baseUrl, userId in public result", async () => {
      vi.mocked(apiGetFetch).mockResolvedValueOnce(
        JSON.stringify({ status: "confirmed", ilink_bot_id: "bot_xyz@im.bot", bot_token: "tok_secret" }),
      );

      const result = await adapter.login({
        onStatusChange: vi.fn(),
        timeoutMs: 10000,
      });

      expect(result.status).toBe("confirmed");
      // Public result must NOT expose internal fields
      expect((result as any).botToken).toBeUndefined();
      expect((result as any).accountId).toBeUndefined();
      expect((result as any).baseUrl).toBeUndefined();
      expect((result as any).userId).toBeUndefined();
      expect((result as any).connected).toBeUndefined();
      expect((result as any).alreadyConnected).toBeUndefined();
    }, 10000);
  });
});
