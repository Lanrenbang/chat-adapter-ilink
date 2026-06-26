import { decryptAesEcb } from "./aes-ecb.js";

export async function downloadAndDecryptMedia(
  url: string,
  aesKeyHex?: string,
): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`CDN download failed: ${res.status} ${res.statusText}`);
  }
  const encrypted = Buffer.from(await res.arrayBuffer());
  if (aesKeyHex && aesKeyHex.length >= 32) {
    const key = Buffer.from(aesKeyHex.slice(0, 32), "hex");
    return decryptAesEcb(encrypted, key);
  }
  return encrypted;
}
