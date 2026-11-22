//! The detached CAdES-BES signature (CMS SignedData) the ETA takes in a document's "signatures".

use sha2::{Digest, Sha256};

use super::der::{
    children, context, integer, nul, octets, oid, read, sequence, set, tlv, utc_time,
};
use crate::error::{BusinessError, Result};

/**
 * Signs with the private key on the USB token: RSA PKCS#1 v1.5 over SHA-256 of `data`.
 * The token never gives its key out; this is the only thing asked of it.
 */
pub trait Signer {
    /** The signing certificate, DER-encoded. */
    fn certificate(&self) -> std::result::Result<Vec<u8>, String>;
    fn sign(&self, data: &[u8]) -> std::result::Result<Vec<u8>, String>;
}

const DATA: &str = "1.2.840.113549.1.7.1";
const SIGNED_DATA: &str = "1.2.840.113549.1.7.2";
const CONTENT_TYPE: &str = "1.2.840.113549.1.9.3";
const MESSAGE_DIGEST: &str = "1.2.840.113549.1.9.4";
const SIGNING_TIME: &str = "1.2.840.113549.1.9.5";
const SIGNING_CERTIFICATE_V2: &str = "1.2.840.113549.1.9.16.2.47";
const SHA256: &str = "2.16.840.1.101.3.4.2.1";
const SHA256_WITH_RSA: &str = "1.2.840.113549.1.1.11";

fn sha256(bytes: &[u8]) -> Vec<u8> {
    Sha256::digest(bytes).to_vec()
}

fn attribute(kind: &str, value: &[u8]) -> Vec<u8> {
    sequence(&[&oid(kind), &set(&[value])])
}

fn bad_certificate() -> BusinessError {
    BusinessError::new(
        "eta_signing_failed",
        "The token's certificate could not be read",
    )
}

/** The issuer name and serial number of a certificate, as raw DER. */
pub fn issuer_and_serial(certificate: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
    let cert = read(certificate, 0).ok_or_else(bad_certificate)?;
    let tbs = *children(&cert).first().ok_or_else(bad_certificate)?;
    let fields = children(&tbs);
    // tbsCertificate: [0] version (optional), serialNumber, signature, issuer, ...
    let at = usize::from(fields.first().is_some_and(|f| f.tag == 0xa0));
    let serial = fields.get(at).ok_or_else(bad_certificate)?;
    let issuer = fields.get(at + 2).ok_or_else(bad_certificate)?;
    Ok((issuer.whole.to_vec(), serial.whole.to_vec()))
}

/** The signed attributes of a CAdES-BES signature, as the SET whose DER the token signs. */
pub fn signed_attributes(
    content: &[u8],
    certificate: &[u8],
    at: chrono::DateTime<chrono::Utc>,
) -> Result<Vec<u8>> {
    let (issuer, serial) = issuer_and_serial(certificate)?;
    // ESSCertIDv2 with the default hash (SHA-256) left out, as DER requires, and the issuer and serial.
    let general_names = sequence(&[&context(4, &issuer)]);
    let cert_id = sequence(&[
        &octets(&sha256(certificate)),
        &sequence(&[&general_names, &serial]),
    ]);
    Ok(set(&[
        &attribute(CONTENT_TYPE, &oid(DATA)),
        &attribute(SIGNING_TIME, &utc_time(at)),
        &attribute(MESSAGE_DIGEST, &octets(&sha256(content))),
        &attribute(SIGNING_CERTIFICATE_V2, &sequence(&[&sequence(&[&cert_id])])),
    ]))
}

/** A detached CAdES-BES signature over `content`, signed by the token. */
pub fn cades_bes(
    content: &[u8],
    signer: &dyn Signer,
    at: chrono::DateTime<chrono::Utc>,
) -> Result<Vec<u8>> {
    let failed = |e: String| BusinessError::new("eta_signing_failed", e);
    let certificate = signer.certificate().map_err(failed)?;
    let attributes = signed_attributes(content, &certificate, at)?;
    let signature = signer.sign(&attributes).map_err(failed)?;
    let (issuer, serial) = issuer_and_serial(&certificate)?;
    let sha = sequence(&[&oid(SHA256), &nul()]);
    let implicit = tlv(0xa0, read(&attributes, 0).expect("just built").content);
    let signer_info = sequence(&[
        &integer(1),
        &sequence(&[&issuer, &serial]),
        &sha,
        // The same attributes, re-tagged [0] IMPLICIT in place of SET.
        &implicit,
        &sequence(&[&oid(SHA256_WITH_RSA), &nul()]),
        &octets(&signature),
    ]);
    let signed_data = sequence(&[
        &integer(1),
        &set(&[&sha]),
        &sequence(&[&oid(DATA)]),
        &context(0, &certificate),
        &set(&[&signer_info]),
    ]);
    Ok(sequence(&[&oid(SIGNED_DATA), &context(0, &signed_data)]))
}
