import { describe, it, expect } from "vitest";
import { createILinkAdapter } from "./factory.js";

describe("createILinkAdapter", () => {
  it("creates adapter with default config", () => {
    const adapter = createILinkAdapter();
    expect(adapter.name).toBe("ilink");
    expect(adapter.userName).toBe("ilink-bot");
  });

  it("accepts custom userName", () => {
    const adapter = createILinkAdapter({ userName: "my-bot" });
    expect(adapter.userName).toBe("my-bot");
  });

  it("accepts custom baseUrl", () => {
    const adapter = createILinkAdapter({ baseUrl: "https://custom.example.com" });
    expect(adapter.name).toBe("ilink");
  });

  it("accepts custom adapterId", () => {
    const adapter = createILinkAdapter({ id: "custom-id" });
    expect(adapter.name).toBe("ilink");
  });

});
