import { createPublicKey, verify } from "node:crypto";
import { BusinessError } from "../errors";

export const TRIAL_DAYS = 14;
/** How far the clock may go back (a time-zone or summer-time fix) before it counts as turned back. */
const CLOCK_SLACK_MS = 26 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

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
export type LicenceFile = { payload: string; signature: string };

/** What this PC keeps: when the trial started, the latest time it saw, and the licence once activated. */
export type LicenceState = { trialStartedAt: string; lastSeenAt: string; licence: LicenceFile | null };

export type ReadOnlyReason = "trial_over" | "clock_back" | "licence_invalid" | "licence_other_machine";

export type LicenceStatus =
  | { mode: "trial"; trialEndsAt: string; daysLeft: number }
  | { mode: "licensed"; company: string; users: number; supportUntil: string }
  | { mode: "read_only"; reason: ReadOnlyReason };

/** What the books enforce: read-only or not, and how many users may be signed in at once. */
export type LicenceLimits = { readOnly: ReadOnlyReason | null; users: number | null };

/** The licence server, injected so tests use a fake. */
export type LicenceClient = {
  /** Activates a key on this PC; a key already on another PC moves here if the licence has a move left. */
  activate(key: string, machine: string): Promise<LicenceFile>;
};

/** Where this PC keeps its licence state. */
export type LicenceStore = { read(): LicenceState | null; write(state: LicenceState): void };

/** The licence's payload, once its signature checks out against our public key and it is for this PC. */
export function verifyLicence(file: LicenceFile, publicKeyPem: string, machine: string): LicencePayload {
  let payload: LicencePayload;
  try {
    const data = Buffer.from(file.payload, "base64");
    if (!verify(null, data, createPublicKey(publicKeyPem), Buffer.from(file.signature, "base64"))) throw new Error("bad signature");
    payload = JSON.parse(data.toString("utf8")) as LicencePayload;
    if (
      typeof payload.machine !== "string" ||
      !Number.isInteger(payload.users) ||
      payload.users < 1 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(payload.supportUntil)
    ) {
      throw new Error("bad payload");
    }
  } catch {
    throw new BusinessError("licence_invalid", "The licence file is not valid");
  }
  if (payload.machine !== machine) throw new BusinessError("licence_other_machine", "The licence is for another PC");
  return payload;
}

/**
 * The licence on this PC: a 14-day trial from the first business file, then the signed licence
 * file, checked offline at every start. Without one the books open read-only.
 */
export class Licensing {
  constructor(private readonly options: { store: LicenceStore; client: LicenceClient; publicKeyPem: string; machine: string }) {}

  /**
   * Notes that a business file is open, and since when it has records: the trial starts with the
   * first one, and a file older than the trial's start moves the start back, so deleting the
   * licence state doesn't start a new trial.
   */
  noteFile(fileStartedAt: Date, now: Date): void {
    const state = this.options.store.read();
    const start = new Date(Math.min(fileStartedAt.getTime(), now.getTime(), state ? Date.parse(state.trialStartedAt) : Infinity));
    this.options.store.write({
      trialStartedAt: start.toISOString(),
      lastSeenAt: state?.lastSeenAt ?? now.toISOString(),
      licence: state?.licence ?? null,
    });
  }

  /** The licence's state now. Moves the latest seen time forward, so turning the clock back is noticed. */
  status(now: Date): LicenceStatus {
    const state = this.options.store.read();
    if (state?.licence) {
      try {
        const licence = verifyLicence(state.licence, this.options.publicKeyPem, this.options.machine);
        return { mode: "licensed", company: licence.company, users: licence.users, supportUntil: licence.supportUntil };
      } catch (error) {
        return {
          mode: "read_only",
          reason: error instanceof BusinessError && error.code === "licence_other_machine" ? "licence_other_machine" : "licence_invalid",
        };
      }
    }
    // No business file yet: the trial hasn't started.
    if (!state) return { mode: "trial", trialEndsAt: new Date(now.getTime() + TRIAL_DAYS * DAY_MS).toISOString(), daysLeft: TRIAL_DAYS };
    const lastSeen = Date.parse(state.lastSeenAt);
    if (now.getTime() < lastSeen - CLOCK_SLACK_MS) return { mode: "read_only", reason: "clock_back" };
    if (now.getTime() > lastSeen) this.options.store.write({ ...state, lastSeenAt: now.toISOString() });
    const ends = Date.parse(state.trialStartedAt) + TRIAL_DAYS * DAY_MS;
    if (now.getTime() >= ends) return { mode: "read_only", reason: "trial_over" };
    return { mode: "trial", trialEndsAt: new Date(ends).toISOString(), daysLeft: Math.ceil((ends - now.getTime()) / DAY_MS) };
  }

  /** What the books enforce now. */
  limits(now: Date): LicenceLimits {
    const status = this.status(now);
    if (status.mode === "read_only") return { readOnly: status.reason, users: null };
    return { readOnly: null, users: status.mode === "licensed" ? status.users : null };
  }

  /** Activates a key on this PC and keeps the signed licence the server returns, once it checks out. */
  async activate(key: string, now: Date): Promise<LicenceStatus> {
    const clean = key.trim().toUpperCase();
    if (clean === "") throw new BusinessError("licence_key_invalid", "Type the licence key");
    let file: LicenceFile;
    try {
      file = await this.options.client.activate(clean, this.options.machine);
    } catch (error) {
      if (error instanceof BusinessError) throw error;
      throw new BusinessError(
        "licence_unreachable",
        `The licence server could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    verifyLicence(file, this.options.publicKeyPem, this.options.machine);
    const state = this.options.store.read();
    this.options.store.write({
      trialStartedAt: state?.trialStartedAt ?? now.toISOString(),
      lastSeenAt: now.toISOString(),
      licence: file,
    });
    return this.status(now);
  }

  /**
   * Whether an update released on `releaseDate` (YYYY-MM-DD) may install: licensed, only if released
   * within the support plan; during the trial, yes; read-only, no. The version installed keeps working either way.
   */
  updateAllowed(releaseDate: string, now: Date): boolean {
    const status = this.status(now);
    if (status.mode === "licensed") return releaseDate <= status.supportUntil;
    return status.mode === "trial";
  }
}
