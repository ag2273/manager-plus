import { generateKeyPairSync, sign } from "node:crypto";
import type { Signer } from "./cades";
import { bits, context, integer, nul, oid, sequence, set, utcTime, utf8 } from "./der";

/** A software signer with a self-signed certificate, standing in for the USB token in tests. */
export function testSigner(commonName = "Test Signer"): Signer & { publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const name = sequence(set(sequence(oid("2.5.4.3"), utf8(commonName))));
  const sha256WithRsa = sequence(oid("1.2.840.113549.1.1.11"), nul());
  const tbs = sequence(
    context(0, integer(2)),
    integer(Uint8Array.from([0x01, 0x23, 0x45, 0x67])),
    sha256WithRsa,
    name,
    sequence(utcTime(new Date("2026-01-01T00:00:00Z")), utcTime(new Date("2036-01-01T00:00:00Z"))),
    name,
    new Uint8Array(publicKey.export({ type: "spki", format: "der" })),
  );
  const certificate = sequence(tbs, sha256WithRsa, bits(new Uint8Array(sign("sha256", tbs, privateKey))));
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) as string,
    certificate: async () => certificate,
    sign: async (data) => new Uint8Array(sign("sha256", data, privateKey)),
  };
}
