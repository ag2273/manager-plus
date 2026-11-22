import { BusinessError } from "../errors";
import { type Signer, cadesBes } from "./cades";
import type { EtaDocumentRow, EtaKind, EtaOutcome } from "./store";
import type { EtaReceiptKind, EtaReceiptOutcome, EtaReceiptRow } from "./receipts-store";

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

/** The ETA's e-receipt API for the registered POS, injected like the invoice client. */
export type EtaReceiptClient = {
  submitReceipts(receipts: Record<string, unknown>[]): Promise<{ accepted: { uuid: string }[]; rejected: { uuid: string; error: string }[] }>;
  receiptStatus(uuid: string): Promise<EtaVerdict>;
};

export type EtaReceiptBooks = {
  etaReceipts(statuses?: EtaReceiptRow["status"][]): EtaReceiptRow[];
  etaPrepareReceipt(kind: EtaReceiptKind, id: number): { receipt: Record<string, unknown>; uuid: string };
  etaRecordReceipt(kind: EtaReceiptKind, id: number, outcome: EtaReceiptOutcome): void;
};

/**
 * Sends pending e-receipts in the order the till issued them, each naming the one before it.
 * They got their UUIDs when posted; one sent again after a fix gets the next UUID now, or fails
 * again with the reason. When the ETA can't be reached they all stay pending, so sales made
 * offline go later, in order, as the same receipts.
 */
export async function sendReceipts(books: EtaReceiptBooks, client: EtaReceiptClient): Promise<number> {
  const batch: { row: EtaReceiptRow; receipt: Record<string, unknown>; uuid: string }[] = [];
  for (const row of books.etaReceipts(["pending"])) {
    try {
      batch.push({ row, ...books.etaPrepareReceipt(row.kind, row.id) });
    } catch (error) {
      books.etaRecordReceipt(row.kind, row.id, { status: "failed", error: reason(error) });
    }
  }
  if (batch.length === 0) return 0;
  const ordered = chainOrder(batch);
  let result: Awaited<ReturnType<EtaReceiptClient["submitReceipts"]>>;
  try {
    result = await client.submitReceipts(ordered.map((b) => b.receipt));
  } catch (error) {
    throw new BusinessError("eta_unreachable", `The ETA could not be reached: ${message(error)}`);
  }
  for (const { row, uuid } of batch) {
    const rejected = result.rejected.find((r) => r.uuid === uuid);
    if (rejected) books.etaRecordReceipt(row.kind, row.id, { status: "failed", error: `eta_rejected: ${rejected.error}` });
    else if (result.accepted.some((a) => a.uuid === uuid)) books.etaRecordReceipt(row.kind, row.id, { status: "submitted" });
  }
  return result.accepted.length;
}

/** Puts receipts after the one each names, so a receipt sent again after a fix goes after those issued while it waited. */
function chainOrder<T extends { receipt: Record<string, unknown>; uuid: string }>(batch: T[]): T[] {
  const previous = (b: T) => (b.receipt["header"] as { previousUUID: string }).previousUUID;
  const next = new Map(batch.map((b) => [previous(b), b]));
  const ordered: T[] = [];
  const placed = new Set<string>();
  for (const start of batch.filter((b) => !batch.some((o) => o.uuid === previous(b)))) {
    for (let b: T | undefined = start; b && !placed.has(b.uuid); b = next.get(b.uuid)) {
      ordered.push(b);
      placed.add(b.uuid);
    }
  }
  return [...ordered, ...batch.filter((b) => !placed.has(b.uuid))];
}

/** Asks the ETA for its verdict on every submitted e-receipt. */
export async function refreshReceiptStatuses(books: EtaReceiptBooks, client: EtaReceiptClient): Promise<void> {
  for (const row of books.etaReceipts(["submitted"])) {
    const verdict = await client.receiptStatus(row.uuid);
    if (verdict.status === "valid" || verdict.status === "invalid") {
      books.etaRecordReceipt(row.kind, row.id, { status: verdict.status, error: verdict.error ? `eta_rejected: ${verdict.error}` : "" });
    }
  }
}
