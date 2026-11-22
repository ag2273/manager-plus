//! Signing and sending the queue to the ETA, and asking for its verdicts. The PC that holds the
//! file runs this in the background, signed in or not; posting in the books never waits on it.

use chrono::{DateTime, Utc};
use serde_json::{json, Value};

use super::cades::{cades_bes, Signer};
use super::receipts_store::{self, reason, EtaReceiptRow};
use super::store::{self, EtaDocumentRow, EtaOutcome};
use crate::business::Business;
use crate::error::{refuse, BusinessError, Result};

/** What the ETA says about one document: submitted (still checking), valid, invalid or cancelled. */
#[derive(Debug, Clone, PartialEq)]
pub struct EtaVerdict {
    pub status: &'static str,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct EtaSubmission {
    /** (internal ID, UUID) of each document the ETA took. */
    pub accepted: Vec<(String, String)>,
    /** (internal ID, why) of each it refused. */
    pub rejected: Vec<(String, String)>,
}

/** The ETA's invoicing API, injected so tests use a fake. An error means nothing reached the ETA. */
pub trait EtaClient {
    fn submit(&self, documents: &[Value]) -> std::result::Result<EtaSubmission, String>;
    fn status(&self, uuid: &str) -> std::result::Result<EtaVerdict, String>;
    fn cancel(&self, uuid: &str, reason: &str) -> std::result::Result<(), String>;
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ReceiptSubmission {
    pub accepted: Vec<String>,
    /** (UUID, why). */
    pub rejected: Vec<(String, String)>,
}

/** The ETA's e-receipt API for the registered POS. */
pub trait EtaReceiptClient {
    fn submit_receipts(&self, receipts: &[Value])
        -> std::result::Result<ReceiptSubmission, String>;
    fn receipt_status(&self, uuid: &str) -> std::result::Result<EtaVerdict, String>;
}

fn unreachable(message: String) -> BusinessError {
    BusinessError::new(
        "eta_unreachable",
        format!("The ETA could not be reached: {message}"),
    )
}

impl Business {
    fn eta_documents_in(&self, statuses: &[&str]) -> Result<Vec<EtaDocumentRow>> {
        store::eta_documents(&self.conn(), Some(statuses))
    }

    fn eta_record(&self, kind: &str, id: i64, outcome: EtaOutcome) -> Result<()> {
        store::record_eta_outcome(&self.conn(), kind, id, &outcome, Utc::now())
    }

    fn eta_prepare(&self, kind: &str, id: i64, now: DateTime<Utc>) -> Result<(Value, String)> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let prepared = store::prepare_eta_document(&tx, kind, id, now)?;
        tx.commit()?;
        Ok(prepared)
    }

    /**
     * Signs and submits every pending document. A document that can't be prepared or signed, or that
     * the ETA refuses, is marked failed with the reason, for the owner to fix and retry; the others
     * go on. Returns how many were accepted. The token is asked to sign with the file unlocked.
     */
    pub fn send_pending_eta(
        &self,
        signer: &dyn Signer,
        client: &dyn EtaClient,
        now: DateTime<Utc>,
    ) -> Result<usize> {
        let mut signed: Vec<(EtaDocumentRow, Value)> = vec![];
        for row in self.eta_documents_in(&["pending"])? {
            let prepared =
                self.eta_prepare(&row.kind, row.document_id, now)
                    .and_then(|(document, text)| {
                        Ok((cades_bes(text.as_bytes(), signer, now)?, document))
                    });
            match prepared {
                Ok((signature, mut document)) => {
                    use base64_engine::encode;
                    document["signatures"] =
                        json!([{ "signatureType": "I", "value": encode(&signature) }]);
                    signed.push((row, document));
                }
                Err(error) if error.code == "internal" => return Err(error),
                Err(error) => {
                    let failed = EtaOutcome {
                        status: "failed",
                        uuid: None,
                        error: Some(reason(&error)),
                    };
                    self.eta_record(&row.kind, row.document_id, failed)?;
                }
            }
        }
        if signed.is_empty() {
            return Ok(0);
        }
        let documents: Vec<Value> = signed.iter().map(|(_, d)| d.clone()).collect();
        // Nothing reached the ETA: they stay pending for the next try.
        let result = client.submit(&documents).map_err(unreachable)?;
        for (row, document) in &signed {
            let internal_id = document["internalID"].as_str().unwrap_or_default();
            let accepted = result.accepted.iter().find(|(id, _)| id == internal_id);
            let rejected = result.rejected.iter().find(|(id, _)| id == internal_id);
            let outcome = match (accepted, rejected) {
                (Some((_, uuid)), _) => EtaOutcome {
                    status: "submitted",
                    uuid: Some(uuid.clone()),
                    error: None,
                },
                (None, Some((_, why))) => EtaOutcome {
                    status: "failed",
                    uuid: None,
                    error: Some(format!("eta_rejected: {why}")),
                },
                (None, None) => EtaOutcome {
                    status: "failed",
                    uuid: None,
                    error: Some("eta_rejected".into()),
                },
            };
            self.eta_record(&row.kind, row.document_id, outcome)?;
        }
        Ok(result.accepted.len())
    }

    /** Asks the ETA for its verdict on every submitted document. */
    pub fn refresh_eta_statuses(&self, client: &dyn EtaClient) -> Result<()> {
        for row in self.eta_documents_in(&["submitted"])? {
            let verdict = client.status(&row.uuid).map_err(unreachable)?;
            if verdict.status != "submitted" {
                let error = verdict.error.map(|e| format!("eta_rejected: {e}"));
                self.eta_record(
                    &row.kind,
                    row.document_id,
                    EtaOutcome {
                        status: verdict.status,
                        uuid: None,
                        error,
                    },
                )?;
            }
        }
        Ok(())
    }

    /** Cancels a document the ETA accepted; the books are corrected separately with a credit note. */
    pub fn cancel_eta(
        &self,
        client: &dyn EtaClient,
        kind: &str,
        document_id: i64,
        reason: &str,
    ) -> Result<()> {
        let row = store::eta_documents(&self.conn(), None)?
            .into_iter()
            .find(|d| d.kind == kind && d.document_id == document_id);
        let Some(row) = row.filter(|r| r.status == "valid" || r.status == "submitted") else {
            return refuse(
                "eta_not_cancellable",
                "Only a submitted or valid document can be cancelled",
            );
        };
        client
            .cancel(&row.uuid, reason)
            .map_err(|e| BusinessError::new("eta_unreachable", e))?;
        self.eta_record(
            kind,
            document_id,
            EtaOutcome {
                status: "cancelled",
                uuid: None,
                error: None,
            },
        )
    }

    fn eta_receipts_in(&self, statuses: &[&str]) -> Result<Vec<EtaReceiptRow>> {
        receipts_store::eta_receipts(&self.conn(), Some(statuses))
    }

    /**
     * Sends pending e-receipts in the order the till issued them, each naming the one before it.
     * They got their UUIDs when posted; one sent again after a fix gets the next UUID now, or fails
     * again with the reason. When the ETA can't be reached they all stay pending, so sales made
     * offline go later, in order, as the same receipts.
     */
    pub fn send_eta_receipts(&self, client: &dyn EtaReceiptClient) -> Result<usize> {
        let mut batch: Vec<(EtaReceiptRow, Value, String)> = vec![];
        for row in self.eta_receipts_in(&["pending"])? {
            let prepared = {
                let mut conn = self.conn();
                let tx = conn.transaction()?;
                let prepared = receipts_store::prepare_eta_receipt(&tx, &row.kind, row.id);
                if prepared.is_ok() {
                    tx.commit()?;
                }
                prepared
            };
            match prepared {
                Ok((receipt, uuid)) => batch.push((row, receipt, uuid)),
                Err(error) if error.code == "internal" => return Err(error),
                Err(error) => receipts_store::record_eta_receipt(
                    &self.conn(),
                    &row.kind,
                    row.id,
                    "failed",
                    &reason(&error),
                )?,
            }
        }
        if batch.is_empty() {
            return Ok(0);
        }
        let ordered = chain_order(&batch);
        let result = client.submit_receipts(&ordered).map_err(unreachable)?;
        for (row, _, uuid) in &batch {
            if let Some((_, why)) = result.rejected.iter().find(|(u, _)| u == uuid) {
                receipts_store::record_eta_receipt(
                    &self.conn(),
                    &row.kind,
                    row.id,
                    "failed",
                    &format!("eta_rejected: {why}"),
                )?;
            } else if result.accepted.contains(uuid) {
                receipts_store::record_eta_receipt(
                    &self.conn(),
                    &row.kind,
                    row.id,
                    "submitted",
                    "",
                )?;
            }
        }
        Ok(result.accepted.len())
    }

    /** Asks the ETA for its verdict on every submitted e-receipt. */
    pub fn refresh_eta_receipt_statuses(&self, client: &dyn EtaReceiptClient) -> Result<()> {
        for row in self.eta_receipts_in(&["submitted"])? {
            let verdict = client.receipt_status(&row.uuid).map_err(unreachable)?;
            if verdict.status == "valid" || verdict.status == "invalid" {
                let error = verdict
                    .error
                    .map(|e| format!("eta_rejected: {e}"))
                    .unwrap_or_default();
                receipts_store::record_eta_receipt(
                    &self.conn(),
                    &row.kind,
                    row.id,
                    verdict.status,
                    &error,
                )?;
            }
        }
        Ok(())
    }
}

/** Puts receipts after the one each names, so a receipt sent again after a fix goes after those issued while it waited. */
fn chain_order(batch: &[(EtaReceiptRow, Value, String)]) -> Vec<Value> {
    let previous = |b: &(EtaReceiptRow, Value, String)| {
        b.1["header"]["previousUUID"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    };
    let mut ordered: Vec<Value> = vec![];
    let mut placed: Vec<String> = vec![];
    let starts = batch
        .iter()
        .filter(|b| !batch.iter().any(|o| o.2 == previous(b)));
    for start in starts {
        let mut at = Some(start);
        while let Some(b) = at.filter(|b| !placed.contains(&b.2)) {
            ordered.push(b.1.clone());
            placed.push(b.2.clone());
            // The last receipt naming this one wins, as a map keyed by "previous" keeps the last.
            at = batch.iter().rev().find(|n| previous(n) == b.2);
        }
    }
    for b in batch {
        if !placed.contains(&b.2) {
            ordered.push(b.1.clone());
        }
    }
    ordered
}

/** Standard base64 with padding, as `Buffer.toString("base64")` writes it. */
mod base64_engine {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    pub fn encode(bytes: &[u8]) -> String {
        let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
        for chunk in bytes.chunks(3) {
            let n = (u32::from(chunk[0]) << 16)
                | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
                | u32::from(*chunk.get(2).unwrap_or(&0));
            out.push(ALPHABET[(n >> 18) as usize & 63] as char);
            out.push(ALPHABET[(n >> 12) as usize & 63] as char);
            out.push(if chunk.len() > 1 {
                ALPHABET[(n >> 6) as usize & 63] as char
            } else {
                '='
            });
            out.push(if chunk.len() > 2 {
                ALPHABET[n as usize & 63] as char
            } else {
                '='
            });
        }
        out
    }
}
