/** What the licence server signs: one company, one server PC, a number of users and a support plan. */
export type LicencePayload = {
    licenceId: string;
    company: string;
    /** The server PC's fingerprint. */
    machine: string;
    users: number;
    /** The last day of the support plan (YYYY-MM-DD): updates released after it don't install. */
    supportUntil: string;
    issuedAt: string;
};
/** The licence file as the server returns it and the PC keeps it: the payload's JSON in base64 and its Ed25519 signature. */
export type LicenceFile = {
    payload: string;
    signature: string;
};
/** What this PC keeps: when the trial started, the latest time it saw, and the licence once activated. */
export type LicenceState = {
    trialStartedAt: string;
    lastSeenAt: string;
    licence: LicenceFile | null;
};
export type ReadOnlyReason = "trial_over" | "clock_back" | "licence_invalid" | "licence_other_machine";
export type LicenceStatus = {
    mode: "trial";
    trialEndsAt: string;
    daysLeft: number;
} | {
    mode: "licensed";
    company: string;
    users: number;
    supportUntil: string;
} | {
    mode: "read_only";
    reason: ReadOnlyReason;
};
/** What the books enforce: read-only or not, and how many users may be signed in at once. */
export type LicenceLimits = {
    readOnly: ReadOnlyReason | null;
    users: number | null;
};
/** The licence server, injected so tests use a fake. */
export type LicenceClient = {
    /** Activates a key on this PC; a key already on another PC moves here if the licence has a move left. */
    activate(key: string, machine: string): Promise<LicenceFile>;
};
/** Where this PC keeps its licence state. */
export type LicenceStore = {
    read(): LicenceState | null;
    write(state: LicenceState): void;
};
/**
 * The licence on this PC: a 14-day trial from the first business file, then the signed licence
 * file, checked offline at every start. Without one the books open read-only.
 */
export declare class Licensing {
    /**
     * Notes that a business file is open, and since when it has records: the trial starts with the
     * first one, and a file older than the trial's start moves the start back, so deleting the
     * licence state doesn't start a new trial.
     */
    noteFile(fileStartedAt: Date, now: Date): void;
    /** The licence's state now. Moves the latest seen time forward, so turning the clock back is noticed. */
    status(now: Date): LicenceStatus;
    /** What the books enforce now. */
    limits(now: Date): LicenceLimits;
    /** Activates a key on this PC and keeps the signed licence the server returns, once it checks out. */
    activate(key: string, now: Date): Promise<LicenceStatus>;
    /**
     * Whether an update released on `releaseDate` (YYYY-MM-DD) may install: licensed, only if released
     * within the support plan; during the trial, yes; read-only, no. The version installed keeps working either way.
     */
    updateAllowed(releaseDate: string, now: Date): boolean;
}
