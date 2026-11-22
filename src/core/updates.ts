import { createHash, createPublicKey, verify } from "node:crypto";
import { BusinessError } from "./errors";

/** One release, as our release script writes it and signs it. */
export type UpdateManifest = {
  version: string;
  /** YYYY-MM-DD: an update installs only on a licence whose support runs to this date or later. */
  releaseDate: string;
  /** The installer, over HTTPS. */
  url: string;
  sha256: string;
  size: number;
  notes: { ar: string; en: string };
};

/** The manifest's JSON in base64 and its Ed25519 signature, as the update server hands it out. */
export type SignedManifest = { manifest: string; signature: string };

export type UpdateCheck =
  | { kind: "none" }
  | { kind: "available"; manifest: UpdateManifest }
  /** A newer version exists but was released after the support plan ended; the installed one keeps working. */
  | { kind: "not_eligible"; manifest: UpdateManifest };

/** The manifest, once its signature checks out against our update key and its fields make sense. */
export function verifyManifest(signed: SignedManifest, publicKeyPem: string): UpdateManifest {
  try {
    const data = Buffer.from(signed.manifest, "base64");
    if (!verify(null, data, createPublicKey(publicKeyPem), Buffer.from(signed.signature, "base64"))) throw new Error("bad signature");
    const m = JSON.parse(data.toString("utf8")) as UpdateManifest;
    if (
      !/^\d+\.\d+\.\d+$/.test(m.version) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(m.releaseDate) ||
      !m.url.startsWith("https://") ||
      !/^[0-9a-f]{64}$/.test(m.sha256) ||
      !Number.isInteger(m.size) ||
      m.size <= 0 ||
      typeof m.notes?.ar !== "string" ||
      typeof m.notes?.en !== "string"
    ) {
      throw new Error("bad manifest");
    }
    return m;
  } catch {
    throw new BusinessError("update_invalid", "The update manifest is not signed by us");
  }
}

/** Whether version a is newer than b (major.minor.patch). */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

/** What to tell the owner about a signed manifest, given the installed version and the licence. */
export function checkUpdate(
  signed: SignedManifest,
  options: { publicKeyPem: string; currentVersion: string; allowed: (releaseDate: string) => boolean },
): UpdateCheck {
  const manifest = verifyManifest(signed, options.publicKeyPem);
  if (!isNewer(manifest.version, options.currentVersion)) return { kind: "none" };
  return options.allowed(manifest.releaseDate) ? { kind: "available", manifest } : { kind: "not_eligible", manifest };
}

/** Checks a downloaded installer is exactly the one the signed manifest names. */
export function verifyPackage(bytes: Uint8Array, manifest: UpdateManifest): void {
  if (bytes.length !== manifest.size || createHash("sha256").update(bytes).digest("hex") !== manifest.sha256) {
    throw new BusinessError("update_invalid", "The downloaded installer doesn't match the signed manifest");
  }
}
