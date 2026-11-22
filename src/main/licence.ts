import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { BusinessError, type BusinessErrorCode } from "../core/errors";
import type { LicenceClient, LicenceFile, LicenceState, LicenceStore } from "../core/licence/licence";

/** The licence server; a test build can point elsewhere. */
export const LICENCE_SERVER = process.env["MANAGER_PLUS_LICENCE_URL"] ?? "https://manager-plus-licences.ayman-abdelsalam.workers.dev";

/**
 * This PC's fingerprint: Windows's machine GUID, hashed. It stays the same across reboots and
 * hardware changes, and changes only when Windows is reinstalled, which counts as a move.
 */
export async function machineFingerprint(): Promise<string> {
  const id = await new Promise<string>((resolve) => {
    if (process.platform !== "win32") {
      try {
        resolve(readFileSync("/etc/machine-id", "utf8").trim());
      } catch {
        resolve(hostname());
      }
      return;
    }
    execFile("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64"], { windowsHide: true }, (error, stdout) => {
      const guid = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(stdout)?.[1];
      resolve(error || !guid ? hostname() : guid);
    });
  });
  return createHash("sha256").update(`manager-plus:${id.toLowerCase()}`).digest("hex").slice(0, 32);
}

/** The licence state in a JSON file in the app's data folder, written whole so a crash can't half-write it. */
export function fileLicenceStore(path: string): LicenceStore {
  return {
    read() {
      try {
        return JSON.parse(readFileSync(path, "utf8")) as LicenceState;
      } catch {
        return null;
      }
    },
    write(state) {
      writeFileSync(`${path}.tmp`, JSON.stringify(state));
      renameSync(`${path}.tmp`, path);
    },
  };
}

const REFUSALS: BusinessErrorCode[] = ["licence_key_invalid", "licence_moves_exhausted", "licence_revoked", "licence_rate_limited"];

/** The licence server over HTTPS. Its refusals come back as their codes; anything else means it couldn't be reached. */
export function httpLicenceClient(server = LICENCE_SERVER, appVersion = ""): LicenceClient {
  return {
    async activate(key, machine) {
      const response = await fetch(`${server}/v1/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, machine, appVersion }),
      });
      if (response.status >= 500) throw new Error(`Licence server error ${response.status}`);
      const body = (await response.json().catch(() => ({}))) as { licence?: LicenceFile; error?: string };
      if (response.ok && body.licence) return body.licence;
      const code = REFUSALS.find((c) => c === body.error) ?? "licence_key_invalid";
      throw new BusinessError(code, `The licence server refused: ${body.error ?? response.status}`);
    },
  };
}
