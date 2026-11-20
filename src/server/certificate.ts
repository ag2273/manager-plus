import { X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { generate } from "selfsigned";

export type ServerIdentity = { key: string; cert: string; fingerprint: string };

const TEN_YEARS_MS = 10 * 365 * 86_400_000;

/** The certificate's SHA-256 fingerprint as Node reports it for a peer ("AB:CD:…"). */
export function fingerprintOf(cert: string): string {
  return new X509Certificate(cert).fingerprint256;
}

/** A short form of a fingerprint for people to compare by eye: the first 8 bytes. */
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.split(":").slice(0, 8).join(":");
}

/** This PC's server certificate, made on first use and kept in `dir` so clients that pinned it keep trusting it. */
export async function loadOrCreateIdentity(dir: string): Promise<ServerIdentity> {
  const keyPath = join(dir, "server-key.pem");
  const certPath = join(dir, "server-cert.pem");
  if (existsSync(keyPath) && existsSync(certPath)) {
    const cert = readFileSync(certPath, "utf8");
    return { key: readFileSync(keyPath, "utf8"), cert, fingerprint: fingerprintOf(cert) };
  }
  const now = new Date();
  const made = await generate([{ name: "commonName", value: `Manager+ ${hostname()}` }], {
    keyType: "ec",
    curve: "P-256",
    algorithm: "sha256",
    notBeforeDate: now,
    notAfterDate: new Date(now.getTime() + TEN_YEARS_MS),
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(keyPath, made.private, { mode: 0o600 });
  writeFileSync(certPath, made.cert);
  return { key: made.private, cert: made.cert, fingerprint: fingerprintOf(made.cert) };
}
