//! A software signer with a self-signed certificate, standing in for the USB token, and fake ETAs.
#![allow(dead_code)]

use std::cell::RefCell;
use std::collections::HashMap;

use manager_core::eta::cades::Signer;
use manager_core::eta::der::{
    bits, context, integer, integer_bytes, nul, oid, sequence, set, utc_time, utf8,
};
use manager_core::eta::sender::{
    EtaClient, EtaReceiptClient, EtaSubmission, EtaVerdict, ReceiptSubmission,
};
use rsa::pkcs1v15::{SigningKey, VerifyingKey};
use rsa::pkcs8::EncodePublicKey;
use rsa::signature::{SignatureEncoding, Signer as _, Verifier};
use rsa::{RsaPrivateKey, RsaPublicKey};
use serde_json::Value;
use sha2::Sha256;

pub struct TestSigner {
    key: RsaPrivateKey,
    certificate: Vec<u8>,
}

impl TestSigner {
    pub fn new() -> TestSigner {
        let key = RsaPrivateKey::new(&mut rand::thread_rng(), 2048).unwrap();
        let spki = RsaPublicKey::from(&key).to_public_key_der().unwrap();
        let name = sequence(&[&set(&[&sequence(&[&oid("2.5.4.3"), &utf8("Test Signer")])])]);
        let algorithm = sequence(&[&oid("1.2.840.113549.1.1.11"), &nul()]);
        let at = |s: &str| {
            chrono::DateTime::parse_from_rfc3339(s)
                .unwrap()
                .with_timezone(&chrono::Utc)
        };
        let tbs = sequence(&[
            &context(0, &integer(2)),
            &integer_bytes(&[0x01, 0x23, 0x45, 0x67]),
            &algorithm,
            &name,
            &sequence(&[
                &utc_time(at("2026-01-01T00:00:00Z")),
                &utc_time(at("2036-01-01T00:00:00Z")),
            ]),
            &name,
            spki.as_bytes(),
        ]);
        let signature = SigningKey::<Sha256>::new(key.clone()).sign(&tbs).to_vec();
        let certificate = sequence(&[&tbs, &algorithm, &bits(&signature)]);
        TestSigner { key, certificate }
    }

    pub fn verifies(&self, data: &[u8], signature: &[u8]) -> bool {
        let key = VerifyingKey::<Sha256>::new(RsaPublicKey::from(&self.key));
        let Ok(signature) = rsa::pkcs1v15::Signature::try_from(signature) else {
            return false;
        };
        key.verify(data, &signature).is_ok()
    }
}

impl Signer for TestSigner {
    fn certificate(&self) -> Result<Vec<u8>, String> {
        Ok(self.certificate.clone())
    }

    fn sign(&self, data: &[u8]) -> Result<Vec<u8>, String> {
        Ok(SigningKey::<Sha256>::new(self.key.clone())
            .sign(data)
            .to_vec())
    }
}

/** An ETA that accepts what it is sent, unless told to refuse an internal ID, and answers with set verdicts. */
#[derive(Default)]
pub struct FakeEta {
    pub refuse: HashMap<String, String>,
    pub down: bool,
    pub received: RefCell<Vec<Value>>,
    pub verdicts: RefCell<HashMap<String, EtaVerdict>>,
    pub cancelled: RefCell<Vec<String>>,
}

impl FakeEta {
    pub fn verdict(&self, uuid: &str, status: &'static str, error: Option<&str>) {
        self.verdicts.borrow_mut().insert(
            uuid.into(),
            EtaVerdict {
                status,
                error: error.map(String::from),
            },
        );
    }
}

fn submitted() -> EtaVerdict {
    EtaVerdict {
        status: "submitted",
        error: None,
    }
}

impl EtaClient for FakeEta {
    fn submit(&self, documents: &[Value]) -> Result<EtaSubmission, String> {
        if self.down {
            return Err("ECONNREFUSED".into());
        }
        self.received.borrow_mut().extend(documents.iter().cloned());
        let mut out = EtaSubmission::default();
        for d in documents {
            let id = d["internalID"].as_str().unwrap().to_string();
            match self.refuse.get(&id) {
                Some(why) => out.rejected.push((id, why.clone())),
                None => out.accepted.push((id.clone(), format!("UUID-{id}"))),
            }
        }
        Ok(out)
    }

    fn status(&self, uuid: &str) -> Result<EtaVerdict, String> {
        Ok(self
            .verdicts
            .borrow()
            .get(uuid)
            .cloned()
            .unwrap_or_else(submitted))
    }

    fn cancel(&self, uuid: &str, _reason: &str) -> Result<(), String> {
        self.cancelled.borrow_mut().push(uuid.into());
        Ok(())
    }
}

impl EtaReceiptClient for FakeEta {
    fn submit_receipts(&self, receipts: &[Value]) -> Result<ReceiptSubmission, String> {
        if self.down {
            return Err("ECONNREFUSED".into());
        }
        self.received.borrow_mut().extend(receipts.iter().cloned());
        let mut out = ReceiptSubmission::default();
        for r in receipts {
            let uuid = r["header"]["uuid"].as_str().unwrap().to_string();
            match self
                .refuse
                .get(r["header"]["receiptNumber"].as_str().unwrap())
            {
                Some(why) => out.rejected.push((uuid, why.clone())),
                None => out.accepted.push(uuid),
            }
        }
        Ok(out)
    }

    fn receipt_status(&self, uuid: &str) -> Result<EtaVerdict, String> {
        Ok(self
            .verdicts
            .borrow()
            .get(uuid)
            .cloned()
            .unwrap_or_else(submitted))
    }
}
