import { BusinessError } from "../errors";
import { type Signer, cadesBes } from "./cades";
import type { EtaDocumentRow, EtaKind, EtaOutcome } from "./store";

/** What the ETA says about one document. */
export type EtaVerdict = { status: "submitted" | "valid" | "invalid" | "cancelled"; error?: string };
export type EtaSubmission = {
  accepted: { internalId: string; uuid: string }[];
  rejected: { internalId: string; error: string }[];
};

/** The ETA's API, injected so tests use a fake server. */
export type EtaClient = {
  submit(documents: Record<string, unknown>[]): Promise<EtaSubmission>;
  status(uuid: string): Promise<EtaVerdict>;
  cancel(uuid: string, reason: string): Promise<void>;
};

/** The few business commands the sender needs; the Business facade has them. */
export type EtaBooks = {
  etaDocuments(statuses?: EtaDocumentRow["status"][]): EtaDocumentRow[];
  etaPrepare(kind: EtaKind, documentId: number, now: Date): { document: Record<string, unknown>; canonical: string };
  etaRecord(kind: EtaKind, documentId: number, outcome: EtaOutcome): void;
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** Why a document failed, as "code" or "code: detail", for the screen to word in its language. */
const reason = (error: unknown) =>
  error instanceof BusinessError ? (error.detail ? `${error.code}: ${error.detail}` : error.code) : `eta_signing_failed: ${message(error)}`;

/**
 * Signs and submits every pending document. A document that can't be prepared or signed, or that
 * the ETA refuses, is marked failed with the reason, for the owner to fix and retry; the others go on.
 * Returns how many were accepted. Posting in the books never waits on this.
 */
export async function sendPending(books: EtaBooks, signer: Signer, client: EtaClient, now = new Date()): Promise<number> {
  const signed: { row: EtaDocumentRow; document: Record<string, unknown> }[] = [];
  for (const row of books.etaDocuments(["pending"])) {
    try {
      const { document, canonical } = books.etaPrepare(row.kind, row.documentId, now);
      const signature = await cadesBes(new TextEncoder().encode(canonical), signer, now);
      signed.push({ row, document: { ...document, signatures: [{ signatureType: "I", value: Buffer.from(signature).toString("base64") }] } });
    } catch (error) {
      books.etaRecord(row.kind, row.documentId, { status: "failed", error: reason(error) });
    }
  }
  if (signed.length === 0) return 0;
  let result: EtaSubmission;
  try {
    result = await client.submit(signed.map((s) => s.document));
  } catch (error) {
    // Nothing reached the ETA: they stay pending for the next try.
    throw new BusinessError("eta_unreachable", `The ETA could not be reached: ${message(error)}`);
  }
  for (const { row, document } of signed) {
    const internalId = document["internalID"];
    const accepted = result.accepted.find((a) => a.internalId === internalId);
    const rejected = result.rejected.find((r) => r.internalId === internalId);
    if (accepted) books.etaRecord(row.kind, row.documentId, { status: "submitted", uuid: accepted.uuid });
    else books.etaRecord(row.kind, row.documentId, { status: "failed", error: rejected ? `eta_rejected: ${rejected.error}` : "eta_rejected" });
  }
  return result.accepted.length;
}

/** Asks the ETA for its verdict on every submitted document. */
export async function refreshStatuses(books: EtaBooks, client: EtaClient): Promise<void> {
  for (const row of books.etaDocuments(["submitted"])) {
    const verdict = await client.status(row.uuid);
    if (verdict.status !== "submitted")
      books.etaRecord(row.kind, row.documentId, { status: verdict.status, error: verdict.error ? `eta_rejected: ${verdict.error}` : "" });
  }
}

/** Cancels a document the ETA accepted; the books are corrected separately with a credit note. */
export async function cancelDocument(books: EtaBooks, client: EtaClient, kind: EtaKind, documentId: number, reason: string): Promise<void> {
  const row = books.etaDocuments().find((d) => d.kind === kind && d.documentId === documentId);
  if (!row || (row.status !== "valid" && row.status !== "submitted")) {
    throw new BusinessError("eta_not_cancellable", "Only a submitted or valid document can be cancelled");
  }
  await client.cancel(row.uuid, reason);
  books.etaRecord(kind, documentId, { status: "cancelled" });
}
