/**
 * Voice format conversion utilities.
 *
 * This module provides pure format conversion functions (SILK ↔ WAV).
 * It does NOT integrate with Chat SDK events or perform speech-to-text.
 *
 * Usage:
 *   import { silkToWav } from "chat-adapter-ilink/messaging/transcribe";
 *   const wav = await silkToWav(silkBuffer);
 *
 * Or via the adapter:
 *   const adapter = bot.getAdapter("ilink");
 *   const wav = await adapter.transcribeVoice(silkBuffer);
 *
 * Speech-to-text is left to external services (e.g. Workers AI).
 */
import { silkToWav } from "../media/silk.js";
export { silkToWav };

/**
 * Convert a SILK audio buffer to WAV format.
 * Returns null if silk-wasm is unavailable or decoding fails.
 */
export async function transcribeSilkToWav(silkBuffer: Buffer): Promise<Buffer | null> {
  try {
    const wav = await silkToWav(silkBuffer);
    return wav ?? null;
  } catch {
    return null;
  }
}
