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
  type Piastres,
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
import {
  type BasisPoints,
  type Item,
  type ItemChanges,
  type ItemInput,
  type ScannedUnit,
  type TaxCode,
  addItem,
  addTaxRate,
  findByBarcode,
  listItems,
  listTaxCodes,
  setItemActive,
  updateItem,
  vatRate,
} from "./items";
import { LATEST_SCHEMA_VERSION, migrate } from "./migrations";
import {
  type PricedPurchase,
  type PurchaseInvoice,
  type PurchaseLineInput,
  type PurchaseInvoiceInput,
  type Supplier,
  type SupplierChanges,
  type SupplierInput,
  addSupplier,
  listPurchaseInvoices,
  listSuppliers,
  postPurchaseInvoice,
  pricePurchase,
  setSupplierActive,
  supplierBalance,
  supplierAccount,
  type SupplierAccount,
  type PurchaseMoney,
  updateSupplier,
} from "./purchases";
import {
  type CreditNote,
  type CreditNoteInput,
  type InvoiceLineInput,
  type PricedInvoice,
  type SalesInvoice,
  type SalesInvoiceInput,
  type SalesInvoiceResult,
  findCreditNote,
  findSalesInvoice,
  listSalesInvoices,
  postCreditNote,
  postSalesInvoice,
  priceInvoice,
} from "./invoices";
import { type SerialHistory, findSerial, setItemSerials } from "./serials";
import { type DebitNote, type DebitNoteInput, listDebitNotes, postDebitNote } from "./debit-notes";
import { type ImportShipment, type ImportShipmentInput, listImportShipments, postImportShipment } from "./shipments";
import {
  type AccountLine,
  type Expense,
  type ExpenseInput,
  type MoneyAccount,
  type MoneyTransfer,
  type PostedDocument,
  type Reconciliation,
  type MoneyTransferInput,
  accountLines,
  listExpenses,
  listMoneyAccounts,
  listMoneyTransfers,
  lockDate,
  reconciliation,
  recordExpense,
  setCleared,
  setLockDate,
  transferMoney,
  voidEntry,
} from "./money";
import {
  type WithholdingCategory,
  type WithholdingReport,
  addWithholdingRate,
  listWithholdingCategories,
  withholdingReport,
  withholdingTax,
} from "./withholding";
import { type Quotation, type QuotationInput, findQuotation, listPrice, listQuotations, saveQuotation } from "./quotations";
import {
  type Aging,
  type OpenDocument,
  type PartyKind,
  type PaymentInput,
  type PaymentResult,
  type Statement,
  aging,
  openDocuments,
  recordPayment,
  statement,
} from "./settlements";
import { type ReturnInput, type ReturnResult, type SaleReturn, findReturn, returnSale } from "./returns";
import {
  type CashInOut,
  type CloseShiftInput,
  type Shift,
  type ZReport,
  cashInOut,
  closeShift,
  listShifts,
  openShift,
  openShiftOf,
  zReport,
} from "./shifts";
import {
  type Customer,
  type CustomerChanges,
  type CustomerInput,
  addCustomer,
  customerBalance,
  listCustomers,
  setCustomerActive,
  updateCustomer,
} from "./customers";
import {
  type CashSaleInput,
  findReceipt,
  type Discount,
  type HeldSale,
  type HeldSaleInput,
  type SaleInput,
  type SaleResult,
  holdSale,
  listHeldSales,
  postSale,
  recallSale,
  type CashSaleResult,
  type PricedSale,
  type Receipt,
  type SaleLineInput,
  listReceipts,
  postCashSale,
  priceSale,
} from "./sales";
import {
  type OpeningStockLine,
  type StockOnHand,
  type Transfer,
  type TransferInput,
  type Warehouse,
  addWarehouse,
  averageCost,
  listTransfers,
  stockValue,
  listWarehouses,
  postOpeningStock,
  renameWarehouse,
  setWarehouseActive,
  stockOnHand,
  transferStock,
} from "./stock";
import {
  type AuditEntry,
  type Credentials,
  type NewUser,
  type User,
  type UserChanges,
  PERMISSIONS,
  addUser,
  authenticate,
  findUser,
  listUsers,
  readAuditLog,
  setPassword,
  setUserActive,
  updateUser,
  writeAudit,
} from "./users";

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

/** A document's audit detail: a manager's credit approval is logged by name, never with the password. */
function withoutPassword<T extends { creditApproval?: { name: string } }>(input: T): Omit<T, "creditApproval"> & { creditApprovedBy?: string } {
  const { creditApproval, ...rest } = input;
  return creditApproval ? { ...rest, creditApprovedBy: creditApproval.name } : rest;
}

/**
 * The one entry point to a business's books. Every business rule lives behind
 * this facade; screens only call its commands and queries.
 *
 * A `Business` acts for one signed-in user. `create` signs in the first
 * manager; `open` returns a signed-out business whose `signIn` returns one
 * that acts for that user. Every command checks the user's role and is
 * written to the audit log in the same transaction.
 */
export class Business {
  private constructor(
    private readonly db: Database.Database,
    private readonly user: User | null,
  ) {}

  /** Create a new business file at `path` (or ":memory:"), with its first manager signed in. */
  static create(path: string, settings: BusinessSettings, manager: Credentials): Business {
    const clean = normalizeSettings(settings);
    if (path !== IN_MEMORY && existsSync(path)) {
      throw new BusinessError("file_exists", `A file already exists at ${path}`);
    }
    const db = new Database(path);
    let first: User;
    try {
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");
      db.pragma(`application_id = ${APPLICATION_ID}`);
      first = db.transaction(() => {
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
        const id = addUser(db, { ...manager, role: "manager" });
        writeAudit(db, { userId: id, action: "createBusiness", entityId: null, detail: JSON.stringify(clean) });
        return findUser(db, id);
      })();
    } catch (error) {
      // Never leave a half-made business file behind.
      db.close();
      if (path !== IN_MEMORY) {
        for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
      }
      throw error;
    }
    return new Business(db, first);
  }

  /** Open an existing business file, signed out. */
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
    return new Business(db, null);
  }

  /** Returns this business acting for the user with these credentials. */
  signIn(name: string, password: string): Business {
    return new Business(this.db, authenticate(this.db, { name, password }));
  }

  /** The signed-in user, or null when signed out. */
  currentUser(): User | null {
    return this.user;
  }

  /** Shown before sign-in, so it needs none. */
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

  private allow(method: string): User {
    if (!this.user) throw new BusinessError("sign_in_required", "Sign in first");
    const roles = PERMISSIONS[method] ?? ["manager"];
    if (!roles.includes(this.user.role)) {
      throw new BusinessError("not_allowed", `A ${this.user.role} may not ${method}`);
    }
    return this.user;
  }

  /** A query: role check only. */
  private read<T>(method: string, work: () => T): T {
    this.allow(method);
    return work();
  }

  /** A command: role check, then the change and its audit entry in one transaction. */
  private write<T>(method: string, detail: unknown, work: () => T, entityId?: number): T {
    const user = this.allow(method);
    return this.db.transaction(() => {
      const result = work();
      writeAudit(this.db, {
        userId: user.id,
        action: method,
        entityId: entityId ?? idOf(result),
        detail: JSON.stringify(detail ?? null),
      });
      return result;
    })();
  }

  // Users

  users(): User[] {
    return this.read("users", () => listUsers(this.db));
  }

  /** Adds a user and returns their id. */
  addUser(user: NewUser): number {
    return this.write("addUser", { name: user.name, role: user.role }, () => addUser(this.db, user));
  }

  updateUser(id: number, changes: UserChanges): void {
    this.write("updateUser", changes, () => updateUser(this.db, id, changes), id);
  }

  resetPassword(id: number, password: string): void {
    this.write("resetPassword", null, () => setPassword(this.db, id, password), id);
  }

  changeOwnPassword(current: string, next: string): void {
    const user = this.allow("changeOwnPassword");
    authenticate(this.db, { name: user.name, password: current });
    this.write("changeOwnPassword", null, () => setPassword(this.db, user.id, next), user.id);
  }

  deactivateUser(id: number): void {
    this.write("deactivateUser", null, () => setUserActive(this.db, id, false), id);
  }

  reactivateUser(id: number): void {
    this.write("reactivateUser", null, () => setUserActive(this.db, id, true), id);
  }

  /** Who changed what, newest first. */
  auditLog(): AuditEntry[] {
    return this.read("auditLog", () => readAuditLog(this.db));
  }

  // Accounts and the ledger

  accounts(): Account[] {
    return this.read("accounts", () => listAccounts(this.db));
  }

  /** Posts a manual journal entry and returns its id. */
  postJournalEntry(entry: JournalEntryInput): number {
    return this.write("postJournalEntry", entry, () => postJournalEntry(this.db, entry));
  }

  /** Adds an account to the chart and returns its id. */
  addAccount(account: NewAccount): number {
    return this.write("addAccount", account, () => addAccount(this.db, account));
  }

  /** Renames or renumbers an account. Its postings stay with it. */
  updateAccount(id: number, changes: AccountChanges): void {
    this.write("updateAccount", changes, () => updateAccount(this.db, id, changes), id);
  }

  deactivateAccount(id: number): void {
    this.write("deactivateAccount", null, () => setAccountActive(this.db, id, false), id);
  }

  reactivateAccount(id: number): void {
    this.write("reactivateAccount", null, () => setAccountActive(this.db, id, true), id);
  }

  /** Deletes an account that has never been posted to. */
  deleteAccount(id: number): void {
    this.write("deleteAccount", null, () => deleteAccount(this.db, id), id);
  }

  /** Posts opening balances; the difference goes to the opening balances account. */
  postOpeningBalances(date: IsoDate, lines: JournalLine[]): number {
    return this.write("postOpeningBalances", { date, lines }, () => postOpeningBalances(this.db, date, lines));
  }

  trialBalance(asOf: IsoDate): TrialBalance {
    return this.read("trialBalance", () => trialBalance(this.db, asOf));
  }

  // Tax codes and items

  taxCodes(): TaxCode[] {
    return this.read("taxCodes", () => listTaxCodes(this.db));
  }

  /** Adds a rate that applies from `from` onwards, for example when the law changes. */
  addTaxRate(taxCodeId: number, rate: { from: IsoDate; rate: BasisPoints }): void {
    this.write("addTaxRate", rate, () => addTaxRate(this.db, taxCodeId, rate), taxCodeId);
  }

  /** The VAT rate (basis points) in force on a document date; zero when the business is not VAT-registered. */
  vatRate(taxCodeId: number, date: IsoDate): BasisPoints {
    return this.read("vatRate", () => vatRate(this.db, taxCodeId, date, this.settings().vatRegistered));
  }

  /** Active items by Arabic name; `search` matches Arabic or English name, code or barcode. */
  items(options: { search?: string; includeInactive?: boolean } = {}): Item[] {
    return this.read("items", () => listItems(this.db, options));
  }

  addItem(item: ItemInput): number {
    return this.write("addItem", item, () => addItem(this.db, item));
  }

  /** Changes an item; pass `pack: null` to remove its pack unit. */
  updateItem(id: number, changes: ItemChanges): void {
    this.write("updateItem", changes, () => updateItem(this.db, id, changes), id);
  }

  /** Hides an item from lists and the till; its history stays. */
  deactivateItem(id: number): void {
    this.write("deactivateItem", null, () => setItemActive(this.db, id, false), id);
  }

  reactivateItem(id: number): void {
    this.write("reactivateItem", null, () => setItemActive(this.db, id, true), id);
  }

  findByBarcode(barcode: string): ScannedUnit | null {
    return this.read("findByBarcode", () => findByBarcode(this.db, barcode));
  }

  // Warehouses and stock

  warehouses(): Warehouse[] {
    return this.read("warehouses", () => listWarehouses(this.db));
  }

  addWarehouse(name: string): number {
    return this.write("addWarehouse", { name }, () => addWarehouse(this.db, name));
  }

  renameWarehouse(id: number, name: string): void {
    this.write("renameWarehouse", { name }, () => renameWarehouse(this.db, id, name), id);
  }

  /** Stops a warehouse that holds no stock. */
  deactivateWarehouse(id: number): void {
    this.write("deactivateWarehouse", null, () => setWarehouseActive(this.db, id, false), id);
  }

  reactivateWarehouse(id: number): void {
    this.write("reactivateWarehouse", null, () => setWarehouseActive(this.db, id, true), id);
  }

  /** Quantity of an item in thousandths of its base unit: in total and per warehouse. */
  stockOnHand(itemId: number): StockOnHand {
    return this.read("stockOnHand", () => stockOnHand(this.db, itemId));
  }

  /** Stock held on the day the business starts using the app, at its cost. */
  postOpeningStock(date: IsoDate, warehouseId: number, lines: OpeningStockLine[]): number {
    return this.write("postOpeningStock", { date, warehouseId, lines }, () =>
      postOpeningStock(this.db, date, warehouseId, lines),
    );
  }

  /** Moves stock from one warehouse to another and returns the transfer's id. */
  transferStock(transfer: TransferInput): number {
    return this.write("transferStock", transfer, () => transferStock(this.db, transfer));
  }

  /** Transfers, newest first. */
  transfers(): Transfer[] {
    return this.read("transfers", () => listTransfers(this.db));
  }

  /** Weighted average cost of one base unit of an item, in piastres, across all warehouses. */
  averageCost(itemId: number): Piastres {
    return this.read("averageCost", () => averageCost(this.db, itemId));
  }

  /** Value at cost of all stock held of an item, in piastres. */
  stockValue(itemId: number): Piastres {
    return this.read("stockValue", () => stockValue(this.db, itemId));
  }

  // The till

  /** Opens a shift at the till for the signed-in user, with the cash float in the drawer. */
  openShift(openingFloat: Piastres): number {
    const user = this.allow("openShift");
    return this.write("openShift", { openingFloat }, () => openShift(this.db, user.id, openingFloat));
  }

  /** The signed-in user's open shift, or null. */
  currentShift(): Shift | null {
    const user = this.allow("currentShift");
    return openShiftOf(this.db, user.id);
  }

  /** Cash paid into or out of the drawer during the signed-in user's shift. */
  cashInOut(movement: CashInOut): number {
    const user = this.allow("cashInOut");
    return this.write("cashInOut", movement, () => cashInOut(this.db, user.id, movement));
  }

  /** Closes the signed-in user's shift with the cash counted, and returns its Z report. */
  closeShift(close: CloseShiftInput): ZReport {
    const user = this.allow("closeShift");
    return this.write("closeShift", close, () => closeShift(this.db, user.id, close));
  }

  zReport(shiftId: number): ZReport {
    return this.read("zReport", () => zReport(this.db, shiftId));
  }

  /** Shifts, newest first. */
  shifts(): Shift[] {
    return this.read("shifts", () => listShifts(this.db));
  }

  /** Prices till lines at shelf prices (VAT-inclusive), without selling anything. */
  priceSale(date: IsoDate, lines: SaleLineInput[], discount?: Discount): PricedSale {
    return this.read("priceSale", () => priceSale(this.db, date, lines, discount));
  }

  /** Puts the cart aside to serve the next customer; returns its id. */
  holdSale(cart: HeldSaleInput): number {
    const user = this.allow("holdSale");
    return this.write("holdSale", cart, () => holdSale(this.db, user.id, cart));
  }

  heldSales(): HeldSale[] {
    return this.read("heldSales", () => listHeldSales(this.db));
  }

  /** Brings a held cart back to the till. */
  recallSale(id: number): HeldSale {
    return this.write("recallSale", null, () => recallSale(this.db, id), id);
  }

  /** Sells for cash at the till; returns the receipt number and the change to give. */
  postCashSale(sale: CashSaleInput): CashSaleResult {
    const user = this.allow("postCashSale");
    return this.write("postCashSale", sale, () => postCashSale(this.db, sale, user.id));
  }

  /** Sells at the till, paid by any mix of cash, card and wallet, with any rest on a customer's account. */
  postSale(sale: SaleInput): SaleResult {
    const user = this.allow("postSale");
    return this.write("postSale", withoutPassword(sale), () => postSale(this.db, sale, user.id));
  }

  // Customers

  customers(): Customer[] {
    return this.read("customers", () => listCustomers(this.db));
  }

  addCustomer(customer: CustomerInput): number {
    return this.write("addCustomer", customer, () => addCustomer(this.db, customer));
  }

  updateCustomer(id: number, changes: CustomerChanges): void {
    this.write("updateCustomer", changes, () => updateCustomer(this.db, id, changes), id);
  }

  /** A stopped customer stays in the books but cannot buy on credit. */
  deactivateCustomer(id: number): void {
    this.write("deactivateCustomer", null, () => setCustomerActive(this.db, id, false), id);
  }

  reactivateCustomer(id: number): void {
    this.write("reactivateCustomer", null, () => setCustomerActive(this.db, id, true), id);
  }

  /** What a customer owes the business, in piastres. */
  customerBalance(id: number): Piastres {
    return this.read("customerBalance", () => customerBalance(this.db, id));
  }

  /** A receipt by its printed number, with what of each line was already returned. */
  findReceipt(number: number): Receipt {
    return this.read("findReceipt", () => findReceipt(this.db, number));
  }

  /** Takes items back against their receipt, refunded in cash or to the receipt's customer. */
  returnSale(input: ReturnInput): ReturnResult {
    const user = this.allow("returnSale");
    return this.write("returnSale", input, () => returnSale(this.db, input, user.id));
  }

  /** A return by its printed number. */
  findReturn(number: number): SaleReturn {
    return this.read("findReturn", () => findReturn(this.db, number));
  }

  /** Till receipts, newest first. */
  receipts(): Receipt[] {
    return this.read("receipts", () => listReceipts(this.db));
  }

  // Suppliers and purchases

  suppliers(): Supplier[] {
    return this.read("suppliers", () => listSuppliers(this.db));
  }

  addSupplier(supplier: SupplierInput): number {
    return this.write("addSupplier", supplier, () => addSupplier(this.db, supplier));
  }

  updateSupplier(id: number, changes: SupplierChanges): void {
    this.write("updateSupplier", changes, () => updateSupplier(this.db, id, changes), id);
  }

  /** A stopped supplier stays in the books but cannot be bought from. */
  deactivateSupplier(id: number): void {
    this.write("deactivateSupplier", null, () => setSupplierActive(this.db, id, false), id);
  }

  reactivateSupplier(id: number): void {
    this.write("reactivateSupplier", null, () => setSupplierActive(this.db, id, true), id);
  }

  /** What the business owes a supplier, in piastres. */
  supplierBalance(id: number): Piastres {
    return this.read("supplierBalance", () => supplierBalance(this.db, id));
  }

  /** What the business owes a supplier in their own currency, and in EGP as the books carry it. */
  supplierAccount(id: number): SupplierAccount {
    return this.read("supplierAccount", () => supplierAccount(this.db, id));
  }

  /** Net, VAT and total of purchase lines on a date, without posting anything. */
  pricePurchase(date: IsoDate, lines: PurchaseLineInput[], money?: PurchaseMoney): PricedPurchase {
    return this.read("pricePurchase", () => {
      const priced = pricePurchase(this.db, date, lines, money);
      return {
        net: priced.net,
        vat: priced.vat,
        total: priced.total,
        totalEgp: priced.totalEgp,
        lines: priced.lines.map((l) => ({
          itemId: l.itemId,
          unit: l.unit,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          net: l.net,
          vatRate: l.vatRate,
          vat: l.vat,
        })),
      };
    });
  }

  /** Posts a supplier's invoice into a warehouse and returns its id. */
  postPurchaseInvoice(invoice: PurchaseInvoiceInput): number {
    const user = this.allow("postPurchaseInvoice");
    return this.write("postPurchaseInvoice", invoice, () => postPurchaseInvoice(this.db, invoice, user.id));
  }

  /** Purchase invoices, newest first. */
  purchaseInvoices(): PurchaseInvoice[] {
    return this.read("purchaseInvoices", () => listPurchaseInvoices(this.db));
  }

  // Serial numbers

  /** Turns serial tracking on or off for an item, with its warranty in months. */
  setItemSerials(itemId: number, settings: { serialised: boolean; warrantyMonths: number }): void {
    this.write("setItemSerials", settings, () => setItemSerials(this.db, itemId, settings), itemId);
  }

  /** Where a serial number came from and went, and whether it is under warranty on `today`. */
  findSerial(serial: string, today: IsoDate): SerialHistory[] {
    return this.read("findSerial", () => findSerial(this.db, serial, today));
  }

  /** Sends goods back to a supplier against their invoice. */
  postDebitNote(note: DebitNoteInput): { id: number; number: number; total: Piastres } {
    const user = this.allow("postDebitNote");
    return this.write("postDebitNote", note, () => postDebitNote(this.db, note, user.id));
  }

  /** Spreads an import shipment's customs, freight and other costs into its items' cost. */
  postImportShipment(shipment: ImportShipmentInput): number {
    const user = this.allow("postImportShipment");
    return this.write("postImportShipment", shipment, () => postImportShipment(this.db, shipment, user.id));
  }

  /** Import shipments, newest first, with each item's landed unit cost. */
  importShipments(): ImportShipment[] {
    return this.read("importShipments", () => listImportShipments(this.db));
  }

  /** The VAT-exclusive price of one unit for a customer's price level (retail with no customer). */
  listPrice(customerId: number | null, itemId: number, unit: "base" | "pack", date: IsoDate): Piastres {
    return this.read("listPrice", () => listPrice(this.db, customerId, itemId, unit, date));
  }

  /** Saves a quotation for a customer; it posts nothing and moves no stock. */
  saveQuotation(quotation: QuotationInput): { id: number; number: number } {
    const user = this.allow("saveQuotation");
    return this.write("saveQuotation", quotation, () => saveQuotation(this.db, quotation, user.id));
  }

  /** Quotations, newest first, with their status (open, expired, converted) on `today`. */
  quotations(today: IsoDate): Quotation[] {
    return this.read("quotations", () => listQuotations(this.db, today));
  }

  findQuotation(number: number, today: IsoDate): Quotation {
    return this.read("findQuotation", () => findQuotation(this.db, number, today));
  }

  /** Debit notes, newest first. */
  debitNotes(): DebitNote[] {
    return this.read("debitNotes", () => listDebitNotes(this.db));
  }

  // Sales invoices

  /** Net, VAT and total of VAT-exclusive invoice lines on a date, without posting anything. */
  priceInvoice(date: IsoDate, lines: InvoiceLineInput[]): PricedInvoice {
    return this.read("priceInvoice", () => priceInvoice(this.db, date, lines));
  }

  /** Posts a tax invoice to a customer's account. */
  postSalesInvoice(invoice: SalesInvoiceInput): SalesInvoiceResult {
    const user = this.allow("postSalesInvoice");
    return this.write("postSalesInvoice", withoutPassword(invoice), () => postSalesInvoice(this.db, invoice, user.id));
  }

  /** Sales invoices, newest first. */
  salesInvoices(): SalesInvoice[] {
    return this.read("salesInvoices", () => listSalesInvoices(this.db));
  }

  /** A sales invoice by its printed number. */
  findSalesInvoice(number: number): SalesInvoice {
    return this.read("findSalesInvoice", () => findSalesInvoice(this.db, number));
  }

  /** Takes goods back against a sales invoice, credited to the customer's account. */
  postCreditNote(note: CreditNoteInput): { id: number; number: number; total: Piastres } {
    const user = this.allow("postCreditNote");
    return this.write("postCreditNote", note, () => postCreditNote(this.db, note, user.id));
  }

  /** A credit note by its printed number. */
  findCreditNote(number: number): CreditNote {
    return this.read("findCreditNote", () => findCreditNote(this.db, number));
  }

  // Money accounts, expenses, transfers, reconciliation and the lock date

  /** Cash, bank and wallet accounts with their balances on a date. */
  moneyAccounts(asOf: IsoDate): MoneyAccount[] {
    return this.read("moneyAccounts", () => listMoneyAccounts(this.db, asOf));
  }

  recordExpense(expense: ExpenseInput): PostedDocument {
    const user = this.allow("recordExpense");
    return this.write("recordExpense", expense, () => recordExpense(this.db, expense, user.id));
  }

  /** Expenses, newest first. */
  expenses(): Expense[] {
    return this.read("expenses", () => listExpenses(this.db));
  }

  transferMoney(transfer: MoneyTransferInput): PostedDocument {
    const user = this.allow("transferMoney");
    return this.write("transferMoney", transfer, () => transferMoney(this.db, transfer, user.id));
  }

  /** Transfers between money accounts, newest first. */
  moneyTransfers(): MoneyTransfer[] {
    return this.read("moneyTransfers", () => listMoneyTransfers(this.db));
  }

  /** Every posting to an account between two dates, with its reconciled tick. */
  accountLines(accountId: number, from: IsoDate, to: IsoDate): AccountLine[] {
    return this.read("accountLines", () => accountLines(this.db, accountId, from, to));
  }

  /** Ticks (or unticks) ledger lines of an account as on the bank statement. */
  setCleared(accountId: number, lineIds: number[], cleared: boolean): void {
    this.write("setCleared", { lineIds, cleared }, () => setCleared(this.db, accountId, lineIds, cleared), accountId);
  }

  /** The account's balance and its ticked lines' balance against a statement balance. */
  reconciliation(accountId: number, statement: Piastres): Reconciliation {
    return this.read("reconciliation", () => reconciliation(this.db, accountId, statement));
  }

  lockDate(): IsoDate | null {
    return this.read("lockDate", () => lockDate(this.db));
  }

  /** Nothing can be posted on or before this date; null unlocks. */
  setLockDate(date: IsoDate | null): void {
    this.write("setLockDate", { date }, () => setLockDate(this.db, date));
  }

  /** Voids a journal entry, expense or transfer by posting its reverse on `date`; returns the reversing entry. */
  voidEntry(entryId: number, date: IsoDate): number {
    return this.write("voidEntry", { date }, () => voidEntry(this.db, entryId, date), entryId);
  }

  // Withholding tax

  withholdingCategories(): WithholdingCategory[] {
    return this.read("withholdingCategories", () => listWithholdingCategories(this.db));
  }

  /** Adds a withholding rate that applies from `from` onwards. */
  addWithholdingRate(categoryId: number, rate: { from: IsoDate; rate: BasisPoints }): void {
    this.write("addWithholdingRate", rate, () => addWithholdingRate(this.db, categoryId, rate), categoryId);
  }

  /** The withholding on `base` (the documents' value before VAT) at the category's rate on `date`. */
  withholdingTax(categoryId: number, date: IsoDate, base: Piastres): Piastres {
    return this.read("withholdingTax", () => withholdingTax(this.db, categoryId, date, base));
  }

  /** Withholding taken on payments and receipts between two dates, for the quarterly form. */
  withholdingReport(from: IsoDate, to: IsoDate): WithholdingReport {
    return this.read("withholdingReport", () => withholdingReport(this.db, from, to));
  }

  // Payments, statements and aging

  /** Money received from a customer. */
  receiveCustomerPayment(payment: PaymentInput): PaymentResult {
    const user = this.allow("receiveCustomerPayment");
    return this.write("receiveCustomerPayment", payment, () => recordPayment(this.db, "customer", payment, user.id));
  }

  /** Money paid to a supplier. */
  paySupplier(payment: PaymentInput): PaymentResult {
    const user = this.allow("paySupplier");
    return this.write("paySupplier", payment, () => recordPayment(this.db, "supplier", payment, user.id));
  }

  /** A customer's or supplier's documents with something still free to allocate a payment to. */
  openDocuments(kind: PartyKind, partyId: number): OpenDocument[] {
    return this.read("openDocuments", () => openDocuments(this.db, kind, partyId));
  }

  /** A customer's or supplier's account between two dates. */
  statement(kind: PartyKind, partyId: number, from: IsoDate, to: IsoDate): Statement {
    return this.read("statement", () => statement(this.db, kind, partyId, from, to));
  }

  /** Aged receivables (customers) or payables (suppliers) on a date. */
  aging(kind: PartyKind, asOf: IsoDate): Aging {
    return this.read("aging", () => aging(this.db, kind, asOf));
  }

  close(): void {
    this.db.close();
  }
}

/** The id a command returned, either as a number or as `{ id }`. */
function idOf(result: unknown): number | null {
  if (typeof result === "number") return result;
  if (typeof result === "object" && result !== null && "id" in result && typeof result.id === "number") return result.id;
  return null;
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
