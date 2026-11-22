import { invoke } from "@tauri-apps/api/core";
import type { DesktopApi } from "../../shared/api";

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

export const tauriApi = new Proxy({} as DesktopApi, {
  get: (_target, name) => (typeof name === "string" ? channel(name) : undefined),
});
