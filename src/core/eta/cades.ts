import { createHash } from "node:crypto";
import { children, context, integer, nul, octets, oid, read, sequence, set, tlv, utcTime, type Der } from "./der";

/**
 * Signs with the private key on the USB token: RSA PKCS#1 v1.5 over SHA-256 of `data`.
 * The token never gives its key out; this is the only thing asked of it.
 */
export type Signer = {
  /** The signing certificate, DER-encoded. */
  certificate(): Promise<Uint8Array>;
  sign(data: Uint8Array): Promise<Uint8Array>;
};

const OID = {
  data: "1.2.840.113549.1.7.1",
  signedData: "1.2.840.113549.1.7.2",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
  sha256: "2.16.840.1.101.3.4.2.1",
  sha256WithRsa: "1.2.840.113549.1.1.11",
};

const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const attribute = (type: string, value: Der) => sequence(oid(type), set(value));

/** The issuer name and serial number of a certificate, as raw DER. */
export function issuerAndSerial(certificate: Uint8Array): { issuer: Der; serial: Der } {
  const tbs = children(read(certificate))[0]!;
  const fields = children(tbs);
  // tbsCertificate: [0] version (optional), serialNumber, signature, issuer, ...
  const at = fields[0]!.tag === 0xa0 ? 1 : 0;
  return { serial: fields[at]!.whole, issuer: fields[at + 2]!.whole };
}

/** The signed attributes of a CAdES-BES signature, as the SET whose DER the token signs. */
export function signedAttributes(content: Uint8Array, certificate: Uint8Array, at: Date): Der {
  const { issuer, serial } = issuerAndSerial(certificate);
  // ESSCertIDv2 with the default hash (SHA-256) left out, as DER requires, and the issuer and serial.
  const certId = sequence(octets(sha256(certificate)), sequence(sequence(context(4, issuer)), serial));
  return set(
    attribute(OID.contentType, oid(OID.data)),
    attribute(OID.signingTime, utcTime(at)),
    attribute(OID.messageDigest, octets(sha256(content))),
    attribute(OID.signingCertificateV2, sequence(sequence(certId))),
  );
}

/**
 * A detached CAdES-BES signature (CMS SignedData) over `content`, the form the ETA takes in a
 * document's "signatures" as base64.
 */
export async function cadesBes(content: Uint8Array, signer: Signer, at: Date): Promise<Uint8Array> {
  const certificate = await signer.certificate();
  const attributes = signedAttributes(content, certificate, at);
  const signature = await signer.sign(attributes);
  const { issuer, serial } = issuerAndSerial(certificate);
  const sha = sequence(oid(OID.sha256), nul());
  const signerInfo = sequence(
    integer(1),
    sequence(issuer, serial),
    sha,
    // The same attributes, re-tagged [0] IMPLICIT in place of SET.
    tlv(0xa0, read(attributes).content),
    sequence(oid(OID.sha256WithRsa), nul()),
    octets(signature),
  );
  const signedData = sequence(integer(1), set(sha), sequence(oid(OID.data)), context(0, certificate), set(signerInfo));
  return sequence(oid(OID.signedData), context(0, signedData));
}
