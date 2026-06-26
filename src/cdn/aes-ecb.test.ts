import { describe, it, expect } from "vitest";
import { encryptAesEcb, decryptAesEcb, aesEcbPaddedSize } from "../cdn/aes-ecb.js";

describe("AES-128-ECB", () => {
  const key = Buffer.from("0123456789abcdef0123456789abcdef", "hex"); // 16 bytes

  it("encrypts and decrypts a buffer roundtrip", () => {
    const plaintext = Buffer.from("Hello, Weixin CDN!");
    const ciphertext = encryptAesEcb(plaintext, key);
    const decrypted = decryptAesEcb(ciphertext, key);
    expect(decrypted.toString()).toBe("Hello, Weixin CDN!");
  });

  it("produces different ciphertext for different keys", () => {
    const plaintext = Buffer.from("test data");
    const key2 = Buffer.from("ffffffffffffffffffffffffffffffff", "hex");
    const ct1 = encryptAesEcb(plaintext, key);
    const ct2 = encryptAesEcb(plaintext, key2);
    expect(ct1).not.toEqual(ct2);
  });

  it("produces deterministic output for same key and data", () => {
    const plaintext = Buffer.from("deterministic test");
    const ct1 = encryptAesEcb(plaintext, key);
    const ct2 = encryptAesEcb(plaintext, key);
    expect(ct1).toEqual(ct2);
  });

  it("handles empty buffer", () => {
    const plaintext = Buffer.alloc(0);
    const ciphertext = encryptAesEcb(plaintext, key);
    const decrypted = decryptAesEcb(ciphertext, key);
    expect(decrypted).toEqual(plaintext);
  });

  it("handles large buffer (1MB)", { timeout: 30000 }, () => {
    const plaintext = Buffer.alloc(1024 * 1024, 0x42);
    const ciphertext = encryptAesEcb(plaintext, key);
    const decrypted = decryptAesEcb(ciphertext, key);
    expect(decrypted).toEqual(plaintext);
  });

  it("produces PKCS7-padded ciphertext", () => {
    const plaintext = Buffer.from("exactly 16 bytes!"); // 16 bytes
    const ciphertext = encryptAesEcb(plaintext, key);
    // PKCS7 pads to next 16-byte boundary → 32 bytes
    expect(ciphertext.length).toBe(32);
    const decrypted = decryptAesEcb(ciphertext, key);
    expect(decrypted.toString()).toBe("exactly 16 bytes!");
  });

  it("handles single byte", () => {
    const plaintext = Buffer.from([0x01]);
    const ciphertext = encryptAesEcb(plaintext, key);
    const decrypted = decryptAesEcb(ciphertext, key);
    expect(decrypted).toEqual(plaintext);
  });
});

describe("aesEcbPaddedSize", () => {
  it("returns 16 for empty input", () => {
    expect(aesEcbPaddedSize(0)).toBe(16);
  });

  it("returns 16 for 15 bytes", () => {
    expect(aesEcbPaddedSize(15)).toBe(16);
  });

  it("returns 32 for 16 bytes (full block)", () => {
    expect(aesEcbPaddedSize(16)).toBe(32);
  });

  it("returns 32 for 17 bytes", () => {
    expect(aesEcbPaddedSize(17)).toBe(32);
  });

  it("returns 48 for 33 bytes", () => {
    expect(aesEcbPaddedSize(33)).toBe(48);
  });
});
