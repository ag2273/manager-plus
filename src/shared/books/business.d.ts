import type { EtaBooks } from "./eta/sender";
import type { EtaDocumentRow, EtaKind, EtaSettings, EtaSettingsInput, EtaState, EtaCredentials } from "./eta/store";
import type { EtaReceiptBooks } from "./eta/sender";
import type { LicenceLimits, ReadOnlyReason } from "./licence/licence";
import type { EtaReceiptCredentials, EtaReceiptKind, EtaReceiptRow, EtaReceiptSettings, EtaReceiptSettingsInput } from "./eta/receipts-store";
import type { BackupFile, BackupStatus } from "./backup";
import type { Account, AccountChanges, IsoDate, JournalEntryInput, JournalLine, NewAccount, Piastres, TrialBalance } from "./ledger";
import type { BasisPoints, Quantity, Item, ItemChanges, ItemInput, ScannedUnit, TaxCode } from "./items";
import type { PricedPurchase, PurchaseInvoice, PurchaseLineInput, PurchaseInvoiceInput, Supplier, SupplierChanges, SupplierInput, SupplierAccount, PurchaseMoney } from "./purchases";
import type { CreditNote, CreditNoteInput, InvoiceLineInput, PricedInvoice, SalesInvoice, SalesInvoiceInput, SalesInvoiceResult } from "./invoices";
import type { SerialHistory, StockSerial } from "./serials";
import type { DebitNote, DebitNoteInput } from "./debit-notes";
import type { ImportShipment, ImportShipmentInput } from "./shipments";
import type { VatReturn } from "./vat-return";
import type { ImportInput, ImportReport } from "./import";
import type { BalanceSheet, Dashboard, DaySalesRow, EntryDetail, GeneralLedger, ItemSalesRow, MethodSalesRow, ProfitAndLoss, SalesDocument, StockReport } from "./reports";
import type { ItemMovement, LowStockRow, StockCount, StockCountInput, WriteOff, WriteOffInput } from "./inventory";
import type { AccountLine, Expense, ExpenseInput, MoneyAccount, MoneyTransfer, PostedDocument, Reconciliation, MoneyTransferInput } from "./money";
import type { WithholdingCategory, WithholdingReport } from "./withholding";
import type { Quotation, QuotationInput } from "./quotations";
import type { Aging, OpenDocument, PartyKind, PaymentInput, PaymentResult, Statement } from "./settlements";
import type { ReturnInput, ReturnResult, SaleReturn } from "./returns";
import type { CashInOut, CloseShiftInput, Shift, ZReport } from "./shifts";
import type { Customer, CustomerChanges, CustomerInput } from "./customers";
import type { CashSaleInput, Discount, HeldSale, HeldSaleInput, SaleInput, SaleResult, CashSaleResult, PricedSale, Receipt, ReceiptFilter, SaleLineInput } from "./sales";
import type { OpeningStockLine, StockOnHand, Transfer, TransferInput, Warehouse } from "./stock";
import type { AuditEntry, NewUser, User, UserChanges } from "./users";
import type { SetupStatus } from "./setup";
export type BusinessSettings = {
    name: string;
    address: string;
    /** Egyptian Tax Authority registration number (9 digits), empty if none. */
    taxRegistrationNumber: string;
    vatRegistered: boolean;
    /** Month the fiscal year starts, 1 = January. */
    fiscalYearStartMonth: number;
};
/** The licence's mode as the books see it, for every screen's banner. */
export type LicenceMode = {
    readOnly: ReadOnlyReason | null;
    users: number | null;
    signedIn: number;
};
/**
 * The one entry point to a business's books. Every business rule lives behind
 * this facade; screens only call its commands and queries.
 *
 * A `Business` acts for one signed-in user. `create` signs in the first
 * manager; `open` returns a signed-out business whose `signIn` returns one
 * that acts for that user. Every command checks the user's role and is
 * written to the audit log in the same transaction.
 */
export declare class Business {
    /**
     * Returns this business acting for the user with these credentials. The licence's number of
     * users counts different people signed in at once; signing in again as yourself is not another.
     */
    signIn(name: string, password: string): Business;
    /** Ends this sign-in, so it no longer counts against the licence's users. */
    signOut(): void;
    /** Applies the licence: read-only without a valid one, and how many users may be signed in. Set by the PC that holds the file. */
    setLicenceLimits(limits: LicenceLimits): void;
    /** Whether the books are read-only and why, and the licensed and signed-in users. */
    licenceMode(): LicenceMode;
    /** The signed-in user, or null when signed out. */
    currentUser(): User | null;
    /**
     * A copy of the file before an app update installs: a backup in the backup folder when one is
     * set, otherwise a copy beside the file. Returns where it went.
     */
    backupBeforeUpdate(version: string): string;
    /** When the file's first record was made: the licence trial counts from the oldest file. For the PC that holds it. */
    startedAt(): Date;
    /** Shown before sign-in, so it needs none. */
    settings(): BusinessSettings;
    users(): User[];
    /** Adds a user and returns their id. */
    addUser(user: NewUser): number;
    updateUser(id: number, changes: UserChanges): void;
    resetPassword(id: number, password: string): void;
    changeOwnPassword(current: string, next: string): void;
    deactivateUser(id: number): void;
    reactivateUser(id: number): void;
    /** Who changed what, newest first. */
    auditLog(): AuditEntry[];
    accounts(): Account[];
    /** Posts a manual journal entry and returns its id. */
    postJournalEntry(entry: JournalEntryInput): number;
    /** Adds an account to the chart and returns its id. */
    addAccount(account: NewAccount): number;
    /** Renames or renumbers an account. Its postings stay with it. */
    updateAccount(id: number, changes: AccountChanges): void;
    deactivateAccount(id: number): void;
    reactivateAccount(id: number): void;
    /** Deletes an account that has never been posted to. */
    deleteAccount(id: number): void;
    /** Posts opening balances; the difference goes to the opening balances account. */
    postOpeningBalances(date: IsoDate, lines: JournalLine[]): number;
    trialBalance(asOf: IsoDate): TrialBalance;
    taxCodes(): TaxCode[];
    /** Adds a rate that applies from `from` onwards, for example when the law changes. */
    addTaxRate(taxCodeId: number, rate: {
        from: IsoDate;
        rate: BasisPoints;
    }): void;
    /** The VAT rate (basis points) in force on a document date; zero when the business is not VAT-registered. */
    vatRate(taxCodeId: number, date: IsoDate): BasisPoints;
    /** Active items by Arabic name; `search` matches Arabic or English name, code or barcode. */
    items(options?: {
        search?: string;
        includeInactive?: boolean;
    }): Item[];
    addItem(item: ItemInput): number;
    /** Changes an item; pass `pack: null` to remove its pack unit. */
    updateItem(id: number, changes: ItemChanges): void;
    /** Hides an item from lists and the till; its history stays. */
    deactivateItem(id: number): void;
    reactivateItem(id: number): void;
    findByBarcode(barcode: string): ScannedUnit | null;
    warehouses(): Warehouse[];
    addWarehouse(name: string): number;
    renameWarehouse(id: number, name: string): void;
    /** Stops a warehouse that holds no stock. */
    deactivateWarehouse(id: number): void;
    reactivateWarehouse(id: number): void;
    /** Quantity of an item in thousandths of its base unit: in total and per warehouse. */
    stockOnHand(itemId: number): StockOnHand;
    /** Stock held on the day the business starts using the app, at its cost. */
    /** A dry run of an import: every row is tried and nothing is saved. */
    checkImport(input: ImportInput): ImportReport;
    /** Imports items, opening stock and opening balances; refuses with nothing saved if any row fails. */
    importData(input: ImportInput): ImportReport;
    postOpeningStock(date: IsoDate, warehouseId: number, lines: OpeningStockLine[]): number;
    /** Moves stock from one warehouse to another and returns the transfer's id. */
    transferStock(transfer: TransferInput): number;
    /** Transfers, newest first. */
    transfers(): Transfer[];
    /** Weighted average cost of one base unit of an item, in piastres, across all warehouses. */
    averageCost(itemId: number): Piastres;
    /** Value at cost of all stock held of an item, in piastres. */
    stockValue(itemId: number): Piastres;
    /** Opens a shift at the till for the signed-in user, with the cash float in the drawer. */
    openShift(openingFloat: Piastres): number;
    /** The signed-in user's open shift, or null. */
    currentShift(): Shift | null;
    /** Cash paid into or out of the drawer during the signed-in user's shift. */
    cashInOut(movement: CashInOut): number;
    /** Closes the signed-in user's shift with the cash counted, and returns its Z report. */
    closeShift(close: CloseShiftInput): ZReport;
    zReport(shiftId: number): ZReport;
    /** Shifts, newest first. */
    shifts(): Shift[];
    /** Prices till lines at shelf prices (VAT-inclusive), without selling anything. */
    priceSale(date: IsoDate, lines: SaleLineInput[], discount?: Discount): PricedSale;
    /** Puts the cart aside to serve the next customer; returns its id. */
    holdSale(cart: HeldSaleInput): number;
    heldSales(): HeldSale[];
    /** Brings a held cart back to the till. */
    recallSale(id: number): HeldSale;
    /** Sells for cash at the till; returns the receipt number and the change to give. */
    postCashSale(sale: CashSaleInput): CashSaleResult;
    /** Sells at the till, paid by any mix of cash, card and wallet, with any rest on a customer's account. */
    postSale(sale: SaleInput): SaleResult;
    customers(): Customer[];
    addCustomer(customer: CustomerInput): number;
    updateCustomer(id: number, changes: CustomerChanges): void;
    /** A stopped customer stays in the books but cannot buy on credit. */
    deactivateCustomer(id: number): void;
    reactivateCustomer(id: number): void;
    /** What a customer owes the business, in piastres. */
    customerBalance(id: number): Piastres;
    /** A receipt by its printed number, with what of each line was already returned. */
    findReceipt(number: number): Receipt;
    /** Takes items back against their receipt, refunded in cash or to the receipt's customer. */
    returnSale(input: ReturnInput): ReturnResult;
    /** A return by its printed number. */
    findReturn(number: number): SaleReturn;
    /** Till receipts, newest first. */
    receipts(): Receipt[];
    /** Till receipts by date, shift or cashier, newest first. A cashier sees only their own. */
    searchReceipts(filter: ReceiptFilter): Receipt[];
    suppliers(): Supplier[];
    addSupplier(supplier: SupplierInput): number;
    updateSupplier(id: number, changes: SupplierChanges): void;
    /** A stopped supplier stays in the books but cannot be bought from. */
    deactivateSupplier(id: number): void;
    reactivateSupplier(id: number): void;
    /** What the business owes a supplier, in piastres. */
    supplierBalance(id: number): Piastres;
    /** What the business owes a supplier in their own currency, and in EGP as the books carry it. */
    supplierAccount(id: number): SupplierAccount;
    /** Net, VAT and total of purchase lines on a date, without posting anything. */
    pricePurchase(date: IsoDate, lines: PurchaseLineInput[], money?: PurchaseMoney): PricedPurchase;
    /** Posts a supplier's invoice into a warehouse and returns its id. */
    postPurchaseInvoice(invoice: PurchaseInvoiceInput): number;
    /** Purchase invoices, newest first. */
    purchaseInvoices(): PurchaseInvoice[];
    /** Turns serial tracking on or off for an item, with its warranty in months. */
    setItemSerials(itemId: number, settings: {
        serialised: boolean;
        warrantyMonths: number;
    }): void;
    /** Where a serial number came from and went, and whether it is under warranty on `today`. */
    findSerial(serial: string, today: IsoDate): SerialHistory[];
    /** The units of a serialised item in stock now, with the warehouse each is in. */
    itemSerials(itemId: number): StockSerial[];
    /** Sends goods back to a supplier against their invoice. */
    postDebitNote(note: DebitNoteInput): {
        id: number;
        number: number;
        total: Piastres;
    };
    /** Spreads an import shipment's customs, freight and other costs into its items' cost. */
    postImportShipment(shipment: ImportShipmentInput): number;
    /** Import shipments, newest first, with each item's landed unit cost. */
    importShipments(): ImportShipment[];
    /** The VAT-exclusive price of one unit for a customer's price level (retail with no customer). */
    listPrice(customerId: number | null, itemId: number, unit: "base" | "pack", date: IsoDate): Piastres;
    /** Saves a quotation for a customer; it posts nothing and moves no stock. */
    saveQuotation(quotation: QuotationInput): {
        id: number;
        number: number;
    };
    /** Quotations, newest first, with their status (open, expired, converted) on `today`. */
    quotations(today: IsoDate): Quotation[];
    findQuotation(number: number, today: IsoDate): Quotation;
    /** Debit notes, newest first. */
    debitNotes(): DebitNote[];
    /** Net, VAT and total of VAT-exclusive invoice lines on a date, without posting anything. */
    priceInvoice(date: IsoDate, lines: InvoiceLineInput[]): PricedInvoice;
    /** Posts a tax invoice to a customer's account. */
    postSalesInvoice(invoice: SalesInvoiceInput): SalesInvoiceResult;
    /** Sales invoices, newest first. */
    salesInvoices(): SalesInvoice[];
    /** A sales invoice by its printed number. */
    findSalesInvoice(number: number): SalesInvoice;
    /** Takes goods back against a sales invoice, credited to the customer's account. */
    postCreditNote(note: CreditNoteInput): {
        id: number;
        number: number;
        total: Piastres;
    };
    /** A credit note by its printed number. */
    findCreditNote(number: number): CreditNote;
    profitAndLoss(from: IsoDate, to: IsoDate): ProfitAndLoss;
    balanceSheet(asOf: IsoDate): BalanceSheet;
    /** An account's postings between two dates, with the balance brought forward and a running balance. */
    generalLedger(accountId: number, from: IsoDate, to: IsoDate): GeneralLedger;
    /** One journal entry and its lines: where every figure drills down to. */
    journalEntry(entryId: number): EntryDetail;
    /** Quantity, net sales, cost and gross profit per item, after returns and credit notes. */
    salesByItem(from: IsoDate, to: IsoDate): ItemSalesRow[];
    salesByDay(from: IsoDate, to: IsoDate): DaySalesRow[];
    salesByPaymentMethod(from: IsoDate, to: IsoDate): MethodSalesRow[];
    /** Till sales, invoices, returns and credit notes in the period, newest first. */
    salesDocuments(from: IsoDate, to: IsoDate): SalesDocument[];
    /** Every item's quantity and value at the end of a date. */
    stockAt(asOf: IsoDate): StockReport;
    /** Output and input VAT by tax kind for a month or quarter, with the documents behind each figure. */
    vatReturn(from: IsoDate, to: IsoDate): VatReturn;
    /** Today's figures for the home screen. */
    dashboard(date: IsoDate): Dashboard;
    /** Posts a stock count for one warehouse; differences go to Stock gain or Stock loss at average cost. */
    postStockCount(count: StockCountInput): number;
    stockCounts(): StockCount[];
    /** Damaged or expired stock taken out of a warehouse with a reason. */
    writeOffStock(writeOff: WriteOffInput): number;
    writeOffs(): WriteOff[];
    /** The quantity (base thousandths) below which the item is low on stock; null for none. */
    setItemMinimum(itemId: number, minimum: Quantity | null): void;
    /** Items below their minimum, in total or in one warehouse. */
    lowStock(warehouseId?: number): LowStockRow[];
    /** An item's stock movements with a running balance, in all warehouses or one. */
    itemMovements(itemId: number, warehouseId?: number): ItemMovement[];
    /** Cash, bank and wallet accounts with their balances on a date. */
    moneyAccounts(asOf: IsoDate): MoneyAccount[];
    recordExpense(expense: ExpenseInput): PostedDocument;
    /** Expenses, newest first. */
    expenses(): Expense[];
    transferMoney(transfer: MoneyTransferInput): PostedDocument;
    /** Transfers between money accounts, newest first. */
    moneyTransfers(): MoneyTransfer[];
    /** Every posting to an account between two dates, with its reconciled tick. */
    accountLines(accountId: number, from: IsoDate, to: IsoDate): AccountLine[];
    /** Ticks (or unticks) ledger lines of an account as on the bank statement. */
    setCleared(accountId: number, lineIds: number[], cleared: boolean): void;
    /** The account's balance and its ticked lines' balance against a statement balance. */
    reconciliation(accountId: number, statement: Piastres): Reconciliation;
    /** How far the first-use setup has come, and whether sales and purchases are open. */
    setupStatus(): SetupStatus;
    /** Finishes the first-use setup: "opening" once opening balances are in, "new" with nothing to bring forward. */
    finishSetup(mode: "opening" | "new"): SetupStatus;
    lockDate(): IsoDate | null;
    /** Nothing can be posted on or before this date; null unlocks. */
    setLockDate(date: IsoDate | null): void;
    /** Voids a journal entry, expense or transfer by posting its reverse on `date`; returns the reversing entry. */
    voidEntry(entryId: number, date: IsoDate): number;
    withholdingCategories(): WithholdingCategory[];
    /** Adds a withholding rate that applies from `from` onwards. */
    addWithholdingRate(categoryId: number, rate: {
        from: IsoDate;
        rate: BasisPoints;
    }): void;
    /** The withholding on `base` (the documents' value before VAT) at the category's rate on `date`. */
    withholdingTax(categoryId: number, date: IsoDate, base: Piastres): Piastres;
    /** Withholding taken on payments and receipts between two dates, for the quarterly form. */
    withholdingReport(from: IsoDate, to: IsoDate): WithholdingReport;
    /** Money received from a customer. */
    receiveCustomerPayment(payment: PaymentInput): PaymentResult;
    /** Money paid to a supplier. */
    paySupplier(payment: PaymentInput): PaymentResult;
    /** A customer's or supplier's documents with something still free to allocate a payment to. */
    openDocuments(kind: PartyKind, partyId: number): OpenDocument[];
    /** A customer's or supplier's account between two dates. */
    statement(kind: PartyKind, partyId: number, from: IsoDate, to: IsoDate): Statement;
    /** Aged receivables (customers) or payables (suppliers) on a date. */
    aging(kind: PartyKind, asOf: IsoDate): Aging;
    /** The backup folder, when the last backup ran, and the backups kept there. */
    backupStatus(): BackupStatus;
    setBackupFolder(folder: string | null): void;
    backupNow(): BackupFile;
    /**
     * The daily backup, run by the app on the PC that holds the file whether or not anyone is signed
     * in; null when no folder is set or today's backup is done.
     */
    scheduledBackup(now: Date): BackupFile | null;
    /**
     * Puts a backup in place of this file: the file as it is now is backed up first (to the backup
     * folder, or beside it when none is set), then this business closes and the backup opens, signed out.
     */
    restore(backupPath: string): Business;
    /** Whether e-invoicing is on, and its settings; the client secret is never returned. */
    etaSettings(): EtaSettings;
    /** Saves the e-invoice settings. The PC seals the client secret before it gets here. */
    setEtaSettings(input: EtaSettingsInput): void;
    /** Sales invoices and credit notes sent, or waiting to be sent, to the ETA, newest first. */
    etaDocuments(): EtaDocumentRow[];
    /** A document's ETA status and UUID by its printed number; null when it isn't an e-invoice. */
    etaState(kind: EtaKind, number: number): EtaState | null;
    /** Sends a failed or invalid document again, once it is fixed. */
    retryEta(kind: EtaKind, documentId: number): void;
    /** The API credentials, for the PC that talks to the ETA; not for screens. */
    etaCredentials(): EtaCredentials;
    /**
     * The queue as the sender works it, on the PC that holds the file, whether or not anyone is
     * signed in, like the daily backup. Outcomes go to the audit log as the system's.
     */
    etaBooks(): EtaBooks;
    /** E-receipts for till sales: on when e-invoicing is on and the POS is registered. */
    etaReceiptSettings(): EtaReceiptSettings;
    /** Saves the POS registration. The PC seals the client secret and pre-shared key before they get here. */
    setEtaReceiptSettings(input: EtaReceiptSettingsInput): void;
    /** E-receipts in the order the till issued them, with their status, UUID and why one failed. */
    etaReceipts(): EtaReceiptRow[];
    /** Sends a failed or invalid e-receipt again, once fixed. */
    retryEtaReceipt(kind: EtaReceiptKind, id: number): void;
    /** What the printed receipt's QR code holds, once the ETA has the receipt; null otherwise. */
    etaReceiptQr(kind: EtaReceiptKind, number: number): string | null;
    /** The POS credentials, for the PC that talks to the ETA; not for screens. */
    etaReceiptCredentials(): EtaReceiptCredentials;
    /** The e-receipt chain as the sender works it, on the PC that holds the file, signed in or not. */
    etaReceiptBooks(): EtaReceiptBooks;
    close(): void;
}
