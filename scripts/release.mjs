// Release signing, run on the owner's PC.
//
//   node scripts/release.mjs keygen <private-key-file>
//     Once: makes the release key pair, writes the public key into the app
//     (src/core/update-key.ts) and the private key to <private-key-file>.
//     Keep that file off the repo and backed up; losing it means no more updates.
//
//   node scripts/release.mjs sign <private-key-file> <installer.exe> <https-url> <release-date> <notes-ar> <notes-en>
//     Prints the signed manifest to paste into the admin page's "Releases" box.
import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [command, ...args] = process.argv.slice(2);
const fail = (text) => {
  process.stderr.write(`${text}\n`);
  process.exit(1);
};

if (command === "keygen") {
  const [keyFile] = args;
  if (!keyFile) fail("Usage: node scripts/release.mjs keygen <private-key-file>");
  const target = fileURLToPath(new URL("../src/core/update-key.ts", import.meta.url));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  writeFileSync(target, readFileSync(target, "utf8").replace(/`-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----\n`/, `\`${pem}\``));
  process.stderr.write(`Private key: ${keyFile} (keep it safe). Public key written to ${target}.\n`);
} else if (command === "sign") {
  const [keyFile, installer, url, releaseDate, ar, en] = args;
  if (
    !keyFile ||
    !installer ||
    !url?.startsWith("https://") ||
    !/^\d{4}-\d{2}-\d{2}$/.test(releaseDate ?? "") ||
    ar === undefined ||
    en === undefined
  ) {
    fail("Usage: node scripts/release.mjs sign <private-key-file> <installer.exe> <https-url> <YYYY-MM-DD> <notes-ar> <notes-en>");
  }
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  const bytes = readFileSync(installer);
  const manifest = {
    version,
    releaseDate,
    url,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: statSync(installer).size,
    notes: { ar, en },
  };
  const data = Buffer.from(JSON.stringify(manifest));
  const signature = sign(null, data, createPrivateKey(readFileSync(keyFile)));
  process.stdout.write(`${JSON.stringify({ manifest: data.toString("base64"), signature: signature.toString("base64") })}\n`);
} else {
  fail("Commands: keygen, sign");
}
