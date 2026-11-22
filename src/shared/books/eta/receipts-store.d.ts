export type EtaReceiptSettings = {
    enabled: boolean;
    /** The POS as registered with the ETA. */
    posSerial: string;
    posOsVersion: string;
    posModel: string;
    posClientId: string;
    /** Whether the POS client secret and pre-shared key are saved; they never leave the PC that sealed them. */
    hasPosSecrets: boolean;
};
export type EtaReceiptSettingsInput = Omit<EtaReceiptSettings, "hasPosSecrets"> & {
    /** Sealed by the PC; left out to keep the saved ones. */
    posClientSecret?: string;
    presharedKey?: string;
};
export type EtaReceiptCredentials = {
    production: boolean;
    posSerial: string;
    posOsVersion: string;
    posModel: string;
    posClientId: string;
    posClientSecret: string;
    presharedKey: string;
};
export type EtaReceiptKind = "sale" | "return";
/** "" the receipt isn't an e-receipt; pending, failed, submitted, valid, invalid as for invoices. */
export type EtaReceiptStatus = "pending" | "failed" | "submitted" | "valid" | "invalid";
export type EtaReceiptRow = {
    kind: EtaReceiptKind;
    id: number;
    number: number;
    at: string;
    status: EtaReceiptStatus;
    uuid: string;
    error: string;
};
export type EtaReceiptOutcome = {
    status: EtaReceiptStatus;
    error?: string;
};
