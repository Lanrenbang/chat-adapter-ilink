/**
 * Factory function for creating ILinkAdapter instances.
 */
import { ILinkAdapter } from "./adapter.js";
import type { ILinkAdapterConfig } from "./adapter.js";

export type CreateILinkAdapterConfig = ILinkAdapterConfig & {
  /** Adapter identifier (defaults to "ilink"). */
  id?: string;
};

/**
 * Create a new ILinkAdapter instance.
 *
 * @example
 * ```ts
 * const adapter = createILinkAdapter({
 *   botAgent: "MyBot/1.0.0",
 *   logger: "debug",
 * });
 * ```
 */
export function createILinkAdapter(config: CreateILinkAdapterConfig = {}): ILinkAdapter {
  const { id, ...adapterConfig } = config;
  return new ILinkAdapter({
    adapterId: id ?? "ilink",
    ...adapterConfig,
  });
}
