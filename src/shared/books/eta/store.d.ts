import { type EtaAddress } from "./document";
export type EtaEnvironment = "preprod" | "production";
export type EtaSettings = {
    enabled: boolean;
    environment: EtaEnvironment;
    clientId: string;
    /** Whether a client secret is saved; the secret itself never leaves the PC that sealed it. */
    hasSecret: boolean;
    /** The four-digit activity code the business is registered under. */
    activityCode: string;
    address: EtaAddress;
    /** Which certificate on the USB token signs: its thumbprint. */
    certificate: string;
};
export type EtaSettingsInput = Omit<EtaSettings, "hasSecret"> & {
    /** The client secret, sealed by the PC (Windows DPAPI); left out to keep the saved one. */
    clientSecret?: string;
};
/** What the PC needs to talk to the ETA: never shown on screens. */
export type EtaCredentials = {
    environment: EtaEnvironment;
    clientId: string;
    clientSecret: string;
    certificate: string;
};
export type EtaKind = "invoice" | "credit_note";
/**
 * pending: waiting to be sent. failed: not sent, or refused at submission; fix and retry.
 * submitted: accepted for validation. valid / invalid: the ETA's verdict. cancelled.
 */
export type EtaStatus = "pending" | "failed" | "submitted" | "valid" | "invalid" | "cancelled";
export type EtaState = {
    status: EtaStatus;
    uuid: string;
    error: string;
};
export type EtaDocumentRow = EtaState & {
    kind: EtaKind;
    documentId: number;
    number: number;
    date: string;
    customerName: string;
    total: number;
    updatedAt: string;
};
export type EtaOutcome = {
    status: EtaStatus;
    uuid?: string;
    error?: string;
};
