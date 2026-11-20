import { existsSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { BusinessError } from "./errors";
import {
  type Account,
  type AccountChanges,
  type IsoDate,
  type JournalEntryInput,
  type JournalLine,
  type NewAccount,
  type TrialBalance,
  addAccount,
  deleteAccount,
  listAccounts,
  postJournalEntry,
  postOpeningBalances,
  setAccountActive,
  trialBalance,
  updateAccount,
} from "./ledger";
import { LATEST_SCHEMA_VERSION, migrate } from "./migrations";

const IN_MEMORY = ":memory:";
/** Marks a SQLite file as a Manager+ business file ("MPLS"). */
const APPLICATION_ID = 0x4d504c53;

export type BusinessSettings = {
  name: string;
  address: string;
  /** Egyptian Tax Authority registration number (9 digits), empty if none. */
  taxRegistrationNumber: string;
  vatRegistered: boolean;
  /** Month the fiscal year starts, 1 = January. */
  fiscalYearStartMonth: number;
};

/**
 * The one entry point to a shop's books. Every business rule lives behind
 * this facade; screens only call its commands and queries.
 */
export class Business {
  private constructor(private readonly db: Database.Database) {}

  /** Create a new business file at `path` (or ":memory:"). */
  static create(path: string, settings: BusinessSettings): Business {
    const clean = normalizeSettings(settings);
    if (path !== IN_MEMORY && existsSync(path)) {
      throw new BusinessError("file_exists", `A file already exists at ${path}`);
    }
    const db = new Database(path);
    try {
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");
      db.pragma(`application_id = ${APPLICATION_ID}`);
      db.transaction(() => {
        migrate(db);
        db.prepare(
          `INSERT INTO business_settings
             (id, name, address, tax_registration_number, vat_registered, fiscal_year_start_month)
           VALUES (1, ?, ?, ?, ?, ?)`,
        ).run(
          clean.name,
          clean.address,
          clean.taxRegistrationNumber,
          clean.vatRegistered ? 1 : 0,
          clean.fiscalYearStartMonth,
        );
      })();
    } catch (error) {
      // Never leave a half-made business file behind.
      db.close();
      if (path !== IN_MEMORY) {
        for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
      }
      throw error;
    }
    return new Business(db);
  }

  /** Open an existing business file. */
  static open(path: string): Business {
    if (!existsSync(path)) {
      throw new BusinessError("file_not_found", `No file at ${path}`);
    }
    const db = new Database(path, { fileMustExist: true });
    try {
      if (db.pragma("application_id", { simple: true }) !== APPLICATION_ID) {
        throw new BusinessError("not_a_business_file", `${path} is not a Manager+ business file`);
      }
      if ((db.pragma("user_version", { simple: true }) as number) > LATEST_SCHEMA_VERSION) {
        throw new BusinessError("made_by_newer_version", `${path} was saved by a newer version of the app`);
      }
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");
      migrate(db);
    } catch (error) {
      db.close();
      if (error instanceof BusinessError) throw error;
      throw new BusinessError("not_a_business_file", `${path} is not a Manager+ business file`);
    }
    return new Business(db);
  }

  settings(): BusinessSettings {
    const row = this.db
      .prepare(
        `SELECT name, address, tax_registration_number, vat_registered, fiscal_year_start_month
           FROM business_settings WHERE id = 1`,
      )
      .get() as {
      name: string;
      address: string;
      tax_registration_number: string;
      vat_registered: number;
      fiscal_year_start_month: number;
    };
    return {
      name: row.name,
      address: row.address,
      taxRegistrationNumber: row.tax_registration_number,
      vatRegistered: row.vat_registered === 1,
      fiscalYearStartMonth: row.fiscal_year_start_month,
    };
  }

  accounts(): Account[] {
    return listAccounts(this.db);
  }

  /** Posts a manual journal entry and returns its id. */
  postJournalEntry(entry: JournalEntryInput): number {
    return this.db.transaction(() => postJournalEntry(this.db, entry))();
  }

  /** Adds an account to the chart and returns its id. */
  addAccount(account: NewAccount): number {
    return this.db.transaction(() => addAccount(this.db, account))();
  }

  /** Renames or renumbers an account. Its postings stay with it. */
  updateAccount(id: number, changes: AccountChanges): void {
    this.db.transaction(() => updateAccount(this.db, id, changes))();
  }

  deactivateAccount(id: number): void {
    this.db.transaction(() => setAccountActive(this.db, id, false))();
  }

  reactivateAccount(id: number): void {
    this.db.transaction(() => setAccountActive(this.db, id, true))();
  }

  /** Deletes an account that has never been posted to. */
  deleteAccount(id: number): void {
    this.db.transaction(() => deleteAccount(this.db, id))();
  }

  /** Posts opening balances; the difference goes to the opening balances account. */
  postOpeningBalances(date: IsoDate, lines: JournalLine[]): number {
    return this.db.transaction(() => postOpeningBalances(this.db, date, lines))();
  }

  trialBalance(asOf: IsoDate): TrialBalance {
    return trialBalance(this.db, asOf);
  }

  close(): void {
    this.db.close();
  }
}

const ARABIC_INDIC_ZERO = 0x0660;

/** Converts Arabic-Indic digits (٠-٩) to Western digits (0-9). */
function toWesternDigits(text: string): string {
  return text.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - ARABIC_INDIC_ZERO));
}

function normalizeSettings(settings: BusinessSettings): BusinessSettings {
  const clean: BusinessSettings = {
    name: settings.name.trim(),
    address: settings.address.trim(),
    taxRegistrationNumber: toWesternDigits(settings.taxRegistrationNumber.trim()),
    vatRegistered: settings.vatRegistered,
    fiscalYearStartMonth: settings.fiscalYearStartMonth,
  };
  if (clean.name === "") {
    throw new BusinessError("name_required", "A business needs a name");
  }
  if (clean.taxRegistrationNumber !== "" && !/^\d{9}$/.test(clean.taxRegistrationNumber)) {
    throw new BusinessError("tax_registration_number_invalid", "Tax registration number must be 9 digits");
  }
  if (!Number.isInteger(clean.fiscalYearStartMonth) || clean.fiscalYearStartMonth < 1 || clean.fiscalYearStartMonth > 12) {
    throw new BusinessError("fiscal_year_start_month_invalid", "Fiscal year start month must be 1 to 12");
  }
  return clean;
}
