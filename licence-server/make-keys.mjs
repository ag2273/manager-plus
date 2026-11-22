// Makes the licence signing key pair. The public key is written into the app
// (src/core/licence/public-key.ts); the private key goes to standard output only,
// to be piped straight into the Worker's secret so it never lands on disk:
//
//   node licence-server/make-keys.mjs | npx wrangler secret put LICENCE_PRIVATE_KEY --config licence-server/wrangler.toml
//
// Run it once. Running it again makes every licence already issued invalid.
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const target = fileURLToPath(new URL("../src/core/licence/public-key.ts", import.meta.url));
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
const source = readFileSync(target, "utf8").replace(/`-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----\n`/, `\`${pem}\``);
writeFileSync(target, source);
process.stderr.write(`Public key written to ${target}. Commit it and build the app.\n`);
process.stdout.write(privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"));
