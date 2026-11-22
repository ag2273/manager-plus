import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { Business } from "./business";
import { type SignedManifest, type UpdateManifest, checkUpdate, isNewer, verifyManifest, verifyPackage } from "./updates";

const keys = generateKeyPairSync("ed25519");
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const installer = new Uint8Array(Buffer.from("MZ pretend installer bytes"));
const manifest: UpdateManifest = {
  version: "1.2.0",
  releaseDate: "2027-03-01",
  url: "https://downloads.example/Manager-Plus-Setup-1.2.0.exe",
  sha256: "4f3c0b2e1d6a3b8f5d7c9e0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e",
  size: installer.length,
  notes: { ar: "تحسينات", en: "Improvements" },
};

function signed(m: unknown, key = keys.privateKey): SignedManifest {
  const data = Buffer.from(JSON.stringify(m));
  return { manifest: data.toString("base64"), signature: sign(null, data, key).toString("base64") };
}

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "mplus-update-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("update manifests", () => {
  test("only a manifest signed with our key, and well formed, is believed", () => {
    expect(verifyManifest(signed(manifest), publicKeyPem)).toEqual(manifest);
    const good = signed(manifest);
    const tampered = { ...good, manifest: Buffer.from(JSON.stringify({ ...manifest, url: "https://evil.example/x.exe" })).toString("base64") };
    expect(() => verifyManifest(tampered, publicKeyPem)).toThrow(expect.objectContaining({ code: "update_invalid" }));
    expect(() => verifyManifest(signed(manifest, generateKeyPairSync("ed25519").privateKey), publicKeyPem)).toThrow(
      expect.objectContaining({ code: "update_invalid" }),
    );
    expect(() => verifyManifest({ manifest: good.manifest, signature: "" }, publicKeyPem)).toThrow(
      expect.objectContaining({ code: "update_invalid" }),
    );
    expect(() => verifyManifest(signed({ ...manifest, url: "http://downloads.example/x.exe" }), publicKeyPem)).toThrow(
      expect.objectContaining({ code: "update_invalid" }),
    );
  });

  test("versions compare by number", () => {
    expect(isNewer("1.10.0", "1.9.9")).toBe(true);
    expect(isNewer("1.2.0", "1.2.0")).toBe(false);
    expect(isNewer("0.9.0", "1.0.0")).toBe(false);
  });

  test("a newer version is offered only when released within the support plan", () => {
    const supportUntil = "2027-02-28";
    const allowed = (releaseDate: string) => releaseDate <= supportUntil;
    expect(checkUpdate(signed(manifest), { publicKeyPem, currentVersion: "1.2.0", allowed })).toEqual({ kind: "none" });
    expect(checkUpdate(signed(manifest), { publicKeyPem, currentVersion: "1.1.0", allowed })).toEqual({ kind: "not_eligible", manifest });
    expect(checkUpdate(signed({ ...manifest, releaseDate: "2027-02-28" }), { publicKeyPem, currentVersion: "1.1.0", allowed })).toMatchObject({
      kind: "available",
    });
  });

  test("the downloaded installer must be exactly the one the manifest names", async () => {
    const { createHash } = await import("node:crypto");
    const real = { ...manifest, sha256: createHash("sha256").update(installer).digest("hex") };
    expect(() => verifyPackage(installer, real)).not.toThrow();
    const changed = installer.slice();
    changed[0] = 0;
    expect(() => verifyPackage(changed, real)).toThrow(expect.objectContaining({ code: "update_invalid" }));
    expect(() => verifyPackage(installer.slice(1), real)).toThrow(expect.objectContaining({ code: "update_invalid" }));
  });

  test("the release script's signed manifest is one the app believes", () => {
    const dir = tempDir();
    const keyFile = join(dir, "release-key.pem");
    writeFileSync(keyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }));
    const exe = join(dir, "setup.exe");
    writeFileSync(exe, installer);
    const out = execFileSync(
      process.execPath,
      ["scripts/release.mjs", "sign", keyFile, exe, "https://downloads.example/setup.exe", "2027-03-01", "تحسينات", "Improvements"],
      {
        encoding: "utf8",
      },
    );
    const m = verifyManifest(JSON.parse(out) as SignedManifest, publicKeyPem);
    expect(m).toMatchObject({ releaseDate: "2027-03-01", size: installer.length, notes: { ar: "تحسينات", en: "Improvements" } });
    expect(() => verifyPackage(installer, m)).not.toThrow();
  });
});

describe("backing up before an update", () => {
  const manager = { name: "أيمن", password: "كلمة سر قوية" };
  const shop = { name: "شركة النور", address: "", taxRegistrationNumber: "", vatRegistered: false, fiscalYearStartMonth: 1 };

  test("goes to the backup folder when one is set, otherwise beside the file; only a manager may", () => {
    const dir = tempDir();
    const path = join(dir, "shop.mplus");
    const business = Business.create(path, shop, manager);
    const beside = business.backupBeforeUpdate("1.2.0");
    expect(beside).toBe(join(dir, "shop قبل تحديث البرنامج 1.2.0.mplus"));
    expect(existsSync(beside)).toBe(true);
    expect(business.backupBeforeUpdate("1.2.0")).toBe(join(dir, "shop قبل تحديث البرنامج 1.2.0 (2).mplus"));

    const folder = join(dir, "USB");
    mkdirSync(folder);
    business.setBackupFolder(folder);
    expect(business.backupBeforeUpdate("1.2.0").startsWith(folder)).toBe(true);
    expect(readdirSync(folder)).toHaveLength(1);

    business.addUser({ name: "سارة", password: "كلمة سر قوية", role: "cashier" });
    expect(() => business.signIn("سارة", "كلمة سر قوية").backupBeforeUpdate("1.2.0")).toThrow(expect.objectContaining({ code: "not_allowed" }));
    business.close();
  });
});
