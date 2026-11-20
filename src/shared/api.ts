import type { Business, BusinessSettings } from "../core/business";

export type { BusinessSettings };

/** What every call across the screen/core channel returns. Errors carry the core's stable code. */
export type Result<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

/** The `Business` commands and queries the screens may call on the open business. */
export const BUSINESS_METHODS = [
  "settings",
  "accounts",
  "addAccount",
  "updateAccount",
  "deactivateAccount",
  "reactivateAccount",
  "deleteAccount",
  "postJournalEntry",
  "postOpeningBalances",
  "trialBalance",
] as const satisfies readonly (keyof Business)[];

export type BusinessMethod = (typeof BUSINESS_METHODS)[number];

/** The open business as the screens see it: the same methods, called across the channel. */
export type RemoteBusiness = {
  [M in BusinessMethod]: Business[M] extends (...args: infer A) => infer R ? (...args: A) => Promise<Result<R>> : never;
};

export type ThemeId = "calm" | "sage" | "sand" | "night";
export const THEMES: readonly ThemeId[] = ["calm", "sage", "sand", "night"];

/** Preferences of this computer, kept outside the business file. */
export type Preferences = { theme: ThemeId };

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
  /** Calls a `Business` method on the open business. */
  call(method: BusinessMethod, args: unknown[]): Promise<Result<unknown>>;
  preferences(): Promise<Preferences>;
  setPreferences(preferences: Preferences): Promise<void>;
}

export const CHANNELS = {
  createBusiness: "business:create",
  openBusiness: "business:open",
  recentFiles: "business:recent",
  call: "business:call",
  preferences: "preferences:get",
  setPreferences: "preferences:set",
} as const;
