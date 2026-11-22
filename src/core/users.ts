import type Database from "better-sqlite3";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { BusinessError } from "./errors";

export type Role = "manager" | "accountant" | "cashier" | "storekeeper";
export const ROLES: readonly Role[] = ["manager", "accountant", "cashier", "storekeeper"];

export type User = { id: number; name: string; role: Role; active: boolean };
export type NewUser = { name: string; role: Role; password: string };
export type UserChanges = { name?: string; role?: Role };
export type Credentials = { name: string; password: string };

export type AuditEntry = {
  id: number;
  /** When, as an ISO timestamp in UTC. */
  at: string;
  userId: number;
  userName: string;
  action: string;
  entityId: number | null;
  detail: string;
};

const MIN_PASSWORD = 6;
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 32;

/** A salted scrypt hash, stored as "scrypt$<salt hex>$<hash hex>". */
function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize("NFC"), salt, KEY_LENGTH, SCRYPT);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function passwordMatches(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password.normalize("NFC"), Buffer.from(saltHex, "hex"), expected.length, SCRYPT);
  return timingSafeEqual(actual, expected);
}

function cleanName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw new BusinessError("user_name_required", "A user needs a name");
  return trimmed;
}

function assertPassword(password: string): void {
  if ([...password].length < MIN_PASSWORD) {
    throw new BusinessError("password_too_short", `A password needs at least ${MIN_PASSWORD} characters`);
  }
}

function assertRole(role: string): asserts role is Role {
  if (!ROLES.includes(role as Role)) throw new BusinessError("role_invalid", `Unknown role ${role}`);
}

type UserRow = { id: number; name: string; role: Role; active: number };
const toUser = (r: UserRow): User => ({ id: r.id, name: r.name, role: r.role, active: r.active === 1 });

export function listUsers(db: Database.Database): User[] {
  return (db.prepare("SELECT id, name, role, active FROM users ORDER BY id").all() as UserRow[]).map(toUser);
}

export function findUser(db: Database.Database, id: number): User {
  const row = db.prepare("SELECT id, name, role, active FROM users WHERE id = ?").get(id) as UserRow | undefined;
  if (!row) throw new BusinessError("user_not_found", `No user with id ${id}`);
  return toUser(row);
}

function assertNameFree(db: Database.Database, name: string, exceptId: number | null): void {
  const owner = db.prepare("SELECT id FROM users WHERE name = ?").get(name) as { id: number } | undefined;
  if (owner && owner.id !== exceptId) throw new BusinessError("user_name_taken", `A user called ${name} exists`);
}

export function addUser(db: Database.Database, input: NewUser): number {
  const name = cleanName(input.name);
  assertRole(input.role);
  assertPassword(input.password);
  assertNameFree(db, name, null);
  return Number(
    db
      .prepare("INSERT INTO users (name, role, password_hash) VALUES (?, ?, ?)")
      .run(name, input.role, hashPassword(input.password)).lastInsertRowid,
  );
}

function otherActiveManagers(db: Database.Database, id: number): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'manager' AND active = 1 AND id <> ?").get(id);
  return (row as { n: number }).n;
}

function assertNotLastManager(db: Database.Database, user: User): void {
  if (user.role === "manager" && user.active && otherActiveManagers(db, user.id) === 0) {
    throw new BusinessError("last_manager", "The business needs at least one active manager");
  }
}

export function updateUser(db: Database.Database, id: number, changes: UserChanges): void {
  const user = findUser(db, id);
  const name = changes.name === undefined ? user.name : cleanName(changes.name);
  const role = changes.role ?? user.role;
  assertRole(role);
  assertNameFree(db, name, id);
  if (role !== "manager") assertNotLastManager(db, user);
  db.prepare("UPDATE users SET name = ?, role = ? WHERE id = ?").run(name, role, id);
}

export function setUserActive(db: Database.Database, id: number, active: boolean): void {
  const user = findUser(db, id);
  if (!active) assertNotLastManager(db, user);
  db.prepare("UPDATE users SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
}

export function setPassword(db: Database.Database, id: number, password: string): void {
  findUser(db, id);
  assertPassword(password);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(password), id);
}

/** The active user with this name and password; the same refusal whatever was wrong. */
export function authenticate(db: Database.Database, credentials: Credentials): User {
  const row = db
    .prepare("SELECT id, name, role, active, password_hash FROM users WHERE name = ? AND active = 1")
    .get(credentials.name.trim()) as (UserRow & { password_hash: string }) | undefined;
  if (!row || !passwordMatches(credentials.password, row.password_hash)) {
    throw new BusinessError("sign_in_failed", "Wrong name or password");
  }
  return toUser(row);
}

export function writeAudit(
  db: Database.Database,
  entry: { userId: number; action: string; entityId: number | null; detail: string },
): void {
  db.prepare("INSERT INTO audit_log (at, user_id, action, entity_id, detail) VALUES (?, ?, ?, ?, ?)").run(
    new Date().toISOString(),
    entry.userId,
    entry.action,
    entry.entityId,
    entry.detail,
  );
}

export function readAuditLog(db: Database.Database, limit = 500): AuditEntry[] {
  return db
    .prepare(
      `SELECT l.id, l.at, l.user_id AS userId, u.name AS userName, l.action, l.entity_id AS entityId, l.detail
         FROM audit_log l JOIN users u ON u.id = l.user_id
        ORDER BY l.id DESC LIMIT ?`,
    )
    .all(limit) as AuditEntry[];
}

/** Which roles may call each facade method. Anything not listed is manager-only. */
export const PERMISSIONS: Record<string, readonly Role[]> = {
  // Cashiers pick the account for cash paid in or out of the drawer.
  accounts: ["manager", "accountant", "cashier"],
  addAccount: ["manager", "accountant"],
  updateAccount: ["manager", "accountant"],
  deactivateAccount: ["manager", "accountant"],
  reactivateAccount: ["manager", "accountant"],
  deleteAccount: ["manager", "accountant"],
  postJournalEntry: ["manager", "accountant"],
  postOpeningBalances: ["manager", "accountant"],
  trialBalance: ["manager", "accountant"],
  taxCodes: ROLES,
  addTaxRate: ["manager", "accountant"],
  vatRate: ROLES,
  withholdingCategories: ROLES,
  moneyAccounts: ["manager", "accountant"],
  profitAndLoss: ["manager", "accountant"],
  balanceSheet: ["manager", "accountant"],
  generalLedger: ["manager", "accountant"],
  journalEntry: ["manager", "accountant"],
  salesByItem: ["manager", "accountant"],
  salesByDay: ["manager", "accountant"],
  salesByPaymentMethod: ["manager", "accountant"],
  salesDocuments: ["manager", "accountant"],
  stockAt: ["manager", "accountant"],
  vatReturn: ["manager", "accountant"],
  dashboard: ["manager", "accountant"],
  postStockCount: ["manager", "storekeeper"],
  stockCounts: ["manager", "accountant", "storekeeper"],
  writeOffStock: ["manager", "storekeeper"],
  writeOffs: ["manager", "accountant", "storekeeper"],
  setItemMinimum: ["manager", "storekeeper"],
  lowStock: ROLES,
  itemMovements: ["manager", "accountant", "storekeeper"],
  recordExpense: ["manager", "accountant"],
  expenses: ["manager", "accountant"],
  transferMoney: ["manager", "accountant"],
  moneyTransfers: ["manager", "accountant"],
  accountLines: ["manager", "accountant"],
  setCleared: ["manager", "accountant"],
  reconciliation: ["manager", "accountant"],
  lockDate: ROLES,
  setLockDate: ["manager", "accountant"],
  voidEntry: ["manager", "accountant"],
  addWithholdingRate: ["manager", "accountant"],
  withholdingTax: ["manager", "accountant"],
  withholdingReport: ["manager", "accountant"],
  items: ROLES,
  addItem: ["manager", "accountant", "storekeeper"],
  updateItem: ["manager", "accountant", "storekeeper"],
  deactivateItem: ["manager", "accountant", "storekeeper"],
  reactivateItem: ["manager", "accountant", "storekeeper"],
  findByBarcode: ROLES,
  changeOwnPassword: ROLES,
  auditLog: ["manager", "accountant"],
  warehouses: ROLES,
  addWarehouse: ["manager", "storekeeper"],
  renameWarehouse: ["manager", "storekeeper"],
  deactivateWarehouse: ["manager", "storekeeper"],
  reactivateWarehouse: ["manager", "storekeeper"],
  stockOnHand: ROLES,
  postOpeningStock: ["manager", "accountant"],
  importData: ["manager"],
  backupStatus: ["manager"],
  setBackupFolder: ["manager"],
  backupNow: ["manager"],
  restoreBackup: ["manager"],
  etaSettings: ["manager", "accountant"],
  setEtaSettings: ["manager"],
  etaDocuments: ["manager", "accountant"],
  etaState: ["manager", "accountant"],
  retryEta: ["manager", "accountant"],
  transferStock: ["manager", "storekeeper"],
  transfers: ["manager", "accountant", "storekeeper"],
  averageCost: ["manager", "accountant", "storekeeper"],
  suppliers: ["manager", "accountant", "storekeeper"],
  addSupplier: ["manager", "accountant", "storekeeper"],
  updateSupplier: ["manager", "accountant", "storekeeper"],
  deactivateSupplier: ["manager", "accountant"],
  reactivateSupplier: ["manager", "accountant"],
  supplierBalance: ["manager", "accountant"],
  supplierAccount: ["manager", "accountant"],
  stockValue: ["manager", "accountant", "storekeeper"],
  openShift: ["manager", "cashier"],
  currentShift: ["manager", "cashier"],
  cashInOut: ["manager", "cashier"],
  closeShift: ["manager", "cashier"],
  zReport: ["manager", "accountant", "cashier"],
  shifts: ["manager", "accountant", "cashier"],
  priceSale: ["manager", "accountant", "cashier"],
  postCashSale: ["manager", "cashier"],
  postSale: ["manager", "cashier"],
  holdSale: ["manager", "cashier"],
  findReceipt: ["manager", "accountant", "cashier"],
  returnSale: ["manager", "cashier"],
  findReturn: ["manager", "accountant", "cashier"],
  heldSales: ["manager", "cashier"],
  recallSale: ["manager", "cashier"],
  customers: ["manager", "accountant", "cashier"],
  addCustomer: ["manager", "accountant", "cashier"],
  updateCustomer: ["manager", "accountant"],
  deactivateCustomer: ["manager", "accountant"],
  reactivateCustomer: ["manager", "accountant"],
  customerBalance: ["manager", "accountant", "cashier"],
  receipts: ["manager", "accountant", "cashier"],
  pricePurchase: ["manager", "accountant", "storekeeper"],
  postPurchaseInvoice: ["manager", "accountant", "storekeeper"],
  purchaseInvoices: ["manager", "accountant", "storekeeper"],
  postDebitNote: ["manager", "accountant", "storekeeper"],
  postImportShipment: ["manager", "accountant"],
  saveQuotation: ["manager", "accountant"],
  quotations: ["manager", "accountant"],
  findQuotation: ["manager", "accountant"],
  listPrice: ROLES,
  importShipments: ["manager", "accountant"],
  debitNotes: ["manager", "accountant", "storekeeper"],
  priceInvoice: ["manager", "accountant"],
  postSalesInvoice: ["manager", "accountant"],
  salesInvoices: ["manager", "accountant"],
  findSalesInvoice: ["manager", "accountant"],
  postCreditNote: ["manager", "accountant"],
  findCreditNote: ["manager", "accountant"],
  receiveCustomerPayment: ["manager", "accountant"],
  paySupplier: ["manager", "accountant"],
  openDocuments: ["manager", "accountant"],
  statement: ["manager", "accountant"],
  aging: ["manager", "accountant"],
  setItemSerials: ["manager", "accountant", "storekeeper"],
  findSerial: ROLES,
};
