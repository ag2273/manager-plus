import type { BusinessSettings } from "../core/business";

export type { BusinessSettings };

/** What every call across the screen/core channel returns. Errors carry the core's stable code. */
export type Result<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

/**
 * The typed channel between the screens (renderer) and the core (main process).
 * Screens never touch the database or business rules directly.
 */
export interface DesktopApi {
  /** Asks where to save, then creates the business file. `null` value = the user cancelled. */
  createBusiness(settings: BusinessSettings): Promise<Result<BusinessSettings | null>>;
  /** Opens `path`, or asks for a file when no path is given. `null` value = the user cancelled. */
  openBusiness(path?: string): Promise<Result<BusinessSettings | null>>;
  recentFiles(): Promise<string[]>;
}

export const CHANNELS = {
  createBusiness: "business:create",
  openBusiness: "business:open",
  recentFiles: "business:recent",
} as const;
