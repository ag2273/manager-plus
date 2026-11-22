import type { EtaDocumentRow, EtaKind, EtaOutcome } from "./store";
import type { EtaReceiptKind, EtaReceiptOutcome, EtaReceiptRow } from "./receipts-store";
/** What the ETA says about one document. */
export type EtaVerdict = {
    status: "submitted" | "valid" | "invalid" | "cancelled";
    error?: string;
};
export type EtaSubmission = {
    accepted: {
        internalId: string;
        uuid: string;
    }[];
    rejected: {
        internalId: string;
        error: string;
    }[];
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
    etaPrepare(kind: EtaKind, documentId: number, now: Date): {
        document: Record<string, unknown>;
        canonical: string;
    };
    etaRecord(kind: EtaKind, documentId: number, outcome: EtaOutcome): void;
};
/** The ETA's e-receipt API for the registered POS, injected like the invoice client. */
export type EtaReceiptClient = {
    submitReceipts(receipts: Record<string, unknown>[]): Promise<{
        accepted: {
            uuid: string;
        }[];
        rejected: {
            uuid: string;
            error: string;
        }[];
    }>;
    receiptStatus(uuid: string): Promise<EtaVerdict>;
};
export type EtaReceiptBooks = {
    etaReceipts(statuses?: EtaReceiptRow["status"][]): EtaReceiptRow[];
    etaPrepareReceipt(kind: EtaReceiptKind, id: number): {
        receipt: Record<string, unknown>;
        uuid: string;
    };
    etaRecordReceipt(kind: EtaReceiptKind, id: number, outcome: EtaReceiptOutcome): void;
};
