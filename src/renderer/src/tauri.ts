import { invoke } from "@tauri-apps/api/core";
import type { DesktopApi } from "../../shared/api";
import { tauriPrint } from "./tauri-print";

/**
 * The `DesktopApi` in the Tauri app: every channel goes to the one `desktop` command, which
 * answers as the Electron main process does (#72). The screens can't tell the two apart.
 */
const channel =
  (name: string) =>
  (...args: unknown[]): Promise<never> =>
    invoke("desktop", { channel: name, args: args.map((a) => (a === undefined ? null : a)) });

export function inTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

/** Channels the screens' side answers itself: printing draws the receipt in WebView2. */
const HERE: Partial<DesktopApi> = { print: tauriPrint };

export const tauriApi = new Proxy({} as DesktopApi, {
  get: (_target, name) => (typeof name === "string" ? (HERE[name as keyof DesktopApi] ?? channel(name)) : undefined),
});
