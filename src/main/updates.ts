import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BusinessError } from "../core/errors";
import { type SignedManifest, type UpdateManifest, verifyPackage } from "../core/updates";

/** The newest release's signed manifest from our server, or null when there is none yet. */
export async function fetchManifest(server: string): Promise<SignedManifest | null> {
  let response: Response;
  try {
    response = await fetch(`${server}/v1/update`, { headers: { "Cache-Control": "no-cache" } });
  } catch (error) {
    throw new BusinessError("update_unreachable", `The update server could not be reached: ${String(error)}`);
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new BusinessError("update_unreachable", `Update server error ${response.status}`);
  return (await response.json()) as SignedManifest;
}

/** Downloads the installer the manifest names into `folder` and checks it is exactly that one before anything runs it. */
export async function downloadInstaller(manifest: UpdateManifest, folder: string): Promise<string> {
  let bytes: Uint8Array;
  try {
    const response = await fetch(manifest.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw new BusinessError("update_unreachable", `The installer could not be downloaded: ${String(error)}`);
  }
  verifyPackage(bytes, manifest);
  const path = join(folder, `Manager-Plus-Setup-${manifest.version}.exe`);
  writeFileSync(path, bytes);
  return path;
}

/** Starts the installer silently, on its own, and opens the app again when it's done; the caller then quits. */
export function runInstaller(path: string): void {
  spawn(path, ["/S", "--force-run"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}
