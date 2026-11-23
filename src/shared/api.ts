import type { EtaKind, EtaSettingsInput } from "./books/eta/store";
import type { EtaReceiptSettingsInput } from "./books/eta/receipts-store";
import type { LicenceStatus } from "./books/licence/licence";
import type { UpdateCheck } from "./books/updates";
import type { Lang, ReportTable } from "./report-tables";
import type { ReadSheet } from "./spreadsheet-read";
import type { Business, BusinessSettings } from "./books/business";
import type { Credentials, User } from "./books/users";

export type { BusinessSettings, Credentials, User };

/** What every call across the screen/core channel returns. Errors carry the core's stable code. */
export type Result<T> = { ok: true; value: T } | { ok: false; code: string; message: string; amount?: number };

/** The `Business` commands and queries the screens may call on the open business. */
export const BUSINESS_METHODS = [
  "settings",
  "currentUser",
  "users",
  "addUser",
  "updateUser",
  "resetPassword",
  "changeOwnPassword",
  "deactivateUser",
  "reactivateUser",
  "auditLog",
  "accounts",
  "addAccount",
  "updateAccount",
  "deactivateAccount",
  "reactivateAccount",
  "deleteAccount",
  "postJournalEntry",
  "postOpeningBalances",
  "trialBalance",
  "taxCodes",
  "addTaxRate",
  "vatRate",
  "withholdingCategories",
  "moneyAccounts",
  "profitAndLoss",
  "balanceSheet",
  "generalLedger",
  "journalEntry",
  "salesByItem",
  "salesByDay",
  "salesByPaymentMethod",
  "salesDocuments",
  "stockAt",
  "vatReturn",
  "dashboard",
  "postStockCount",
  "stockCounts",
  "writeOffStock",
  "writeOffs",
  "setItemMinimum",
  "lowStock",
  "itemMovements",
  "recordExpense",
  "expenses",
  "transferMoney",
  "moneyTransfers",
  "accountLines",
  "setCleared",
  "reconciliation",
  "setupStatus",
  "finishSetup",
  "lockDate",
  "setLockDate",
  "voidEntry",
  "addWithholdingRate",
  "withholdingTax",
  "withholdingReport",
  "items",
  "addItem",
  "updateItem",
  "deactivateItem",
  "reactivateItem",
  "findByBarcode",
  "warehouses",
  "addWarehouse",
  "renameWarehouse",
  "deactivateWarehouse",
  "reactivateWarehouse",
  "stockOnHand",
  "postOpeningStock",
  "checkImport",
  "importData",
  "backupStatus",
  "setBackupFolder",
  "backupNow",
  "etaSettings",
  "etaDocuments",
  "etaState",
  "retryEta",
  "etaReceiptSettings",
  "etaReceipts",
  "retryEtaReceipt",
  "etaReceiptQr",
  "licenceMode",
  "transferStock",
  "transfers",
  "averageCost",
  "stockValue",
  "priceSale",
  "openShift",
  "currentShift",
  "cashInOut",
  "closeShift",
  "zReport",
  "shifts",
  "postCashSale",
  "postSale",
  "holdSale",
  "findReceipt",
  "returnSale",
  "findReturn",
  "heldSales",
  "recallSale",
  "customers",
  "addCustomer",
  "updateCustomer",
  "deactivateCustomer",
  "reactivateCustomer",
  "customerBalance",
  "receipts",
  "suppliers",
  "addSupplier",
  "updateSupplier",
  "deactivateSupplier",
  "reactivateSupplier",
  "supplierBalance",
  "supplierAccount",
  "pricePurchase",
  "postPurchaseInvoice",
  "purchaseInvoices",
  "postDebitNote",
  "postImportShipment",
  "saveQuotation",
  "quotations",
  "findQuotation",
  "listPrice",
  "importShipments",
  "debitNotes",
  "priceInvoice",
  "postSalesInvoice",
  "salesInvoices",
  "findSalesInvoice",
  "postCreditNote",
  "findCreditNote",
  "receiveCustomerPayment",
  "paySupplier",
  "openDocuments",
  "statement",
  "aging",
  "setItemSerials",
  "findSerial",
] as const satisfies readonly (keyof Business)[];

export type BusinessMethod = (typeof BUSINESS_METHODS)[number];

/** The open business as the screens see it: the same methods, called across the channel. */
export type RemoteBusiness = {
  [M in BusinessMethod]: Business[M] extends (...args: infer A) => infer R ? (...args: A) => Promise<Result<R>> : never;
};

export type ThemeId = "calm" | "sage" | "sand" | "night";
export const THEMES: readonly ThemeId[] = ["calm", "sage", "sand", "night"];

/** How this computer prints receipts. */
export type PrinterSettings =
  | { kind: "none" }
  | { kind: "windows"; deviceName: string; autoPrint: boolean; footer: string }
  | { kind: "network"; host: string; port: number; openDrawer: boolean; autoPrint: boolean; footer: string };

export const NO_PRINTER: PrinterSettings = { kind: "none" };

/** Preferences of this computer, kept outside the business file. */
export type Preferences = {
  theme: ThemeId;
  printer: PrinterSettings;
  /** The language of the screens. */
  screenLanguage: "ar" | "en";
  /** The language of receipts, invoices, statements and report exports. */
  documentLanguage: "ar" | "en";
  digits: "western" | "arabic";
};
export const DEFAULT_PREFERENCES: Preferences = { theme: "calm", printer: NO_PRINTER, screenLanguage: "ar", documentLanguage: "ar", digits: "western" };

export type FileStatus = { path: string; syncFolder: string | null; openElsewhere: { host: string; at: string } | null };

/** A Manager+ server heard on the network, or typed in. */
export type FoundServer = { name: string; host: string; port: number };
/** This PC serving its open business to others. */
export type ServerStatus = { serving: boolean; port: number; fingerprint: string; addresses: string[]; clients: number };
/** Where the open business lives: in a file on this PC, or on a server. */
export type Connection = { mode: "none" } | { mode: "local"; path: string } | { mode: "client"; host: string; port: number; name: string };

/** An A4 page to print or save as PDF. */
export type A4Request = (
  | { kind: "invoice"; number: number }
  | { kind: "creditNote"; number: number }
  | { kind: "quotation"; number: number }
  | { kind: "deliveryNote"; number: number }
  | { kind: "statement"; party: "customer" | "supplier"; id: number; from: string; to: string }
  | { kind: "report"; table: ReportTable }
) & { output: "pdf" | "print" };

/** What to print: a sale or return by its number, or a sample. */
export type PrintRequest =
  | { kind: "sale"; number: number; copy: boolean; openDrawer: boolean }
  | { kind: "return"; number: number; copy: boolean }
  | { kind: "z"; shiftId: number }
  | { kind: "test" };

/**
 * The typed channel between the screens (renderer) and the core (main process).
 * Screens never touch the database or business rules directly.
 */
export interface DesktopApi {
  /** Asks where to save, then creates the business file with its first manager signed in. `null` value = the user cancelled. */
  createBusiness(settings: BusinessSettings, manager: Credentials): Promise<Result<BusinessSettings | null>>;
  /** Opens `path`, or asks for a file when no path is given, signed out. `null` value = the user cancelled. */
  openBusiness(path?: string): Promise<Result<BusinessSettings | null>>;
  /** Signs in to the open business. */
  signIn(credentials: Credentials): Promise<Result<User>>;
  /** Signs out, keeping the business open at its sign-in screen. */
  signOut(): Promise<void>;
  recentFiles(): Promise<string[]>;
  /** Calls a `Business` method on the open business. */
  call(method: BusinessMethod, args: unknown[]): Promise<Result<unknown>>;
  preferences(): Promise<Preferences>;
  /** Saves the given preferences, keeping the others. */
  setPreferences(preferences: Partial<Preferences>): Promise<void>;
  /** Printers installed in Windows. */
  printers(): Promise<string[]>;
  /** Prints on this computer's receipt printer. */
  print(request: PrintRequest): Promise<Result<null>>;
  /** Prints an A4 document through the system print dialog, or saves it as a PDF; `saved` is the PDF's path. */
  printA4(request: A4Request): Promise<Result<{ saved: string | null }>>;
  /** Saves a report as an Excel file; `saved` is its path, or null when cancelled. */
  exportExcel(table: ReportTable): Promise<Result<{ saved: string | null }>>;
  /** Asks for an Excel or CSV file and reads its cells as text; null when cancelled. */
  openSpreadsheet(): Promise<Result<{ name: string; sheets: ReadSheet[] } | null>>;
  /** Saves the import template in Arabic or English; `saved` is its path, or null when cancelled. */
  saveImportTemplate(lang: Lang): Promise<Result<{ saved: string | null }>>;
  /** The open file on this PC: whether it sits in a sync folder and whether another PC had it open; null as a client. */
  fileStatus(): Promise<FileStatus | null>;
  /** Asks for a folder; null when cancelled. */
  chooseFolder(): Promise<string | null>;
  /** Restores a backup (asks for one when null), backing up the file first; the business reopens signed out. */
  restoreBackup(path: string | null): Promise<Result<BusinessSettings | null>>;
  /** Servers announcing themselves on the local network. */
  discoverServers(): Promise<FoundServer[]>;
  /** The server this PC last connected to, for a one-click reconnect. */
  lastServer(): Promise<FoundServer | null>;
  /** Connects to a server as a client, signed out; the first connection pins the server's certificate. */
  connectServer(host: string, port: number): Promise<Result<BusinessSettings>>;
  /** Where the open business lives. */
  connection(): Promise<Connection>;
  /** Whether this PC serves its open business, and to how many PCs. */
  serverStatus(): Promise<ServerStatus>;
  /** Starts or stops serving the open business to other PCs (managers only); remembered for this file. */
  setServing(on: boolean, port: number): Promise<Result<ServerStatus>>;
  /** Signing certificates on this PC (the USB token's, while it is plugged in). */
  etaCertificates(): Promise<TokenCertificate[]>;
  /** Saves the e-invoice settings, sealing the client secret for this PC; the secret is left as it was when empty. */
  saveEtaSettings(settings: EtaSettingsInput): Promise<Result<null>>;
  /** This PC's licence: trial, licensed or read-only; null on a PC using another's file. */
  licenceStatus(): Promise<LicenceStatus | null>;
  /** Activates a licence key on this PC, the one that holds the file. */
  activateLicence(key: string): Promise<Result<LicenceStatus>>;
  /** The app's version. */
  appVersion(): Promise<string>;
  /** Asks for the newest release (or the last answer, when `cached`) and whether this licence may install it. */
  checkUpdate(cached: boolean): Promise<Result<UpdateCheck>>;
  /** Backs up, installs the newest eligible update and restarts the app. */
  installUpdate(): Promise<Result<null>>;
  /** Saves the POS registration for e-receipts, sealing its client secret and pre-shared key on this PC. */
  saveEtaReceiptSettings(settings: EtaReceiptSettingsInput): Promise<Result<null>>;
  /** Asks the ETA for news on submitted documents, then signs and sends the pending ones; returns how many were accepted. */
  sendEtaNow(): Promise<Result<number>>;
  /** Cancels a submitted or valid document at the ETA. */
  cancelEta(kind: EtaKind, documentId: number, reason: string): Promise<Result<null>>;
}

export type TokenCertificate = { thumbprint: string; subject: string; issuer: string; notAfter: string };

export const CHANNELS = {
  createBusiness: "business:create",
  openBusiness: "business:open",
  recentFiles: "business:recent",
  signIn: "business:sign-in",
  signOut: "business:sign-out",
  call: "business:call",
  preferences: "preferences:get",
  setPreferences: "preferences:set",
  printers: "printer:list",
  print: "printer:print",
  printA4: "printer:a4",
  exportExcel: "export:excel",
  openSpreadsheet: "import:open",
  saveImportTemplate: "import:template",
  fileStatus: "file:status",
  chooseFolder: "file:choose-folder",
  restoreBackup: "file:restore",
  discoverServers: "network:discover",
  lastServer: "network:last",
  connectServer: "network:connect",
  connection: "network:connection",
  serverStatus: "network:status",
  setServing: "network:serve",
  etaCertificates: "eta:certificates",
  saveEtaSettings: "eta:save-settings",
  saveEtaReceiptSettings: "eta:save-receipt-settings",
  licenceStatus: "licence:status",
  appVersion: "app:version",
  checkUpdate: "update:check",
  installUpdate: "update:install",
  activateLicence: "licence:activate",
  sendEtaNow: "eta:send",
  cancelEta: "eta:cancel",
} as const;
