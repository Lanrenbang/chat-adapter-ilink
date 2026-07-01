/**
 * Build-time version constants.
 * Injected by tsup `define`; fall back to defaults when undefined (e.g. in test).
 */
declare const __ADAPTER_VERSION__: string;
declare const __ILINK_VERSION__: string;
declare const __ILINK_APP_ID__: string;

/** Adapter package version (from package.json `version`). */
export const ADAPTER_VERSION = (
  typeof __ADAPTER_VERSION__ !== "undefined" ? __ADAPTER_VERSION__ : "0.0.0"
) as string;

/**
 * Upstream iLink protocol version (from package.json `ilink_version`).
 * This is the openclaw-weixin version this adapter is based on.
 */
export const VERSION = (
  typeof __ILINK_VERSION__ !== "undefined" ? __ILINK_VERSION__ : "0.0.0"
) as string;

/** iLink-App-Id header value (from package.json ilink_appid). */
export const APP_ID = (
  typeof __ILINK_APP_ID__ !== "undefined" ? __ILINK_APP_ID__ : "bot"
) as string;

/**
 * iLink-App-ClientVersion: uint32 encoded as 0x00MMNNPP
 * High 8 bits fixed to 0; remaining bits: major<<16 | minor<<8 | patch.
 * e.g. "1.0.11" -> 0x0001000B = 65547
 */
export function buildClientVersion(version: string): number {
  const parts = version.split(".").map((p) => parseInt(p, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

/** Pre-computed client version integer (based on upstream iLink version). */
export const CLIENT_VERSION = buildClientVersion(VERSION);
