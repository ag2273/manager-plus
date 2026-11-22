import type Database from "better-sqlite3";
import { BusinessError } from "../errors";
import { type EtaAddress, type EtaLineInput, type EtaTaxKind, canonical, etaDocument } from "./document";

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
export type EtaCredentials = { environment: EtaEnvironment; clientId: string; clientSecret: string; certificate: string };

export type EtaKind = "invoice" | "credit_note";
/**
 * pending: waiting to be sent. failed: not sent, or refused at submission; fix and retry.
 * submitted: accepted for validation. valid / invalid: the ETA's verdict. cancelled.
 */
export type EtaStatus = "pending" | "failed" | "submitted" | "valid" | "invalid" | "cancelled";
export type EtaState = { status: EtaStatus; uuid: string; error: string };
export type EtaDocumentRow = EtaState & {
  kind: EtaKind;
  documentId: number;
  number: number;
  date: string;
  customerName: string;
  total: number;
  updatedAt: string;
};
export type EtaOutcome = { status: EtaStatus; uuid?: string; error?: string };

type SettingsRow = {
  enabled: number;
  environment: EtaEnvironment;
  client_id: string;
  client_secret: string;
  activity_code: string;
  governate: string;
  region_city: string;
  street: string;
  building_number: string;
  certificate: string;
};

function settingsRow(db: Database.Database): SettingsRow {
  return db.prepare("SELECT * FROM eta_settings WHERE id = 1").get() as SettingsRow;
}

export function etaSettings(db: Database.Database): EtaSettings {
  const r = settingsRow(db);
  return {
    enabled: r.enabled === 1,
    environment: r.environment,
    clientId: r.client_id,
    hasSecret: r.client_secret !== "",
    activityCode: r.activity_code,
    address: { governate: r.governate, regionCity: r.region_city, street: r.street, buildingNumber: r.building_number },
    certificate: r.certificate,
  };
}

export function etaEnabled(db: Database.Database): boolean {
  return settingsRow(db).enabled === 1;
}

export function setEtaSettings(db: Database.Database, input: EtaSettingsInput): void {
  const current = settingsRow(db);
  const trim = (s: string) => s.trim();
  const clean = {
    environment: input.environment === "production" ? "production" : "preprod",
    clientId: trim(input.clientId),
    clientSecret: input.clientSecret === undefined ? current.client_secret : input.clientSecret,
    activityCode: trim(input.activityCode),
    governate: trim(input.address.governate),
    regionCity: trim(input.address.regionCity),
    street: trim(input.address.street),
    buildingNumber: trim(input.address.buildingNumber),
    certificate: trim(input.certificate),
  };
  if (input.enabled) {
    const { tax_registration_number: rin } = db.prepare("SELECT tax_registration_number FROM business_settings WHERE id = 1").get() as {
      tax_registration_number: string;
    };
    if (!/^\d{9}$/.test(rin)) throw new BusinessError("tax_registration_number_invalid", "The business needs its 9-digit tax registration number");
    if (!/^\d{4}$/.test(clean.activityCode)) throw new BusinessError("activity_code_invalid", "The activity code is 4 digits");
    const missing = [
      clean.clientId,
      clean.clientSecret,
      clean.governate,
      clean.regionCity,
      clean.street,
      clean.buildingNumber,
      clean.certificate,
    ].some((v) => v === "");
    if (missing) throw new BusinessError("eta_settings_incomplete", "Fill in every e-invoice setting");
  }
  db.prepare(
    `UPDATE eta_settings SET enabled = ?, environment = ?, client_id = ?, client_secret = ?, activity_code = ?, governate = ?, region_city = ?,
            street = ?, building_number = ?, certificate = ? WHERE id = 1`,
  ).run(
    input.enabled ? 1 : 0,
    clean.environment,
    clean.clientId,
    clean.clientSecret,
    clean.activityCode,
    clean.governate,
    clean.regionCity,
    clean.street,
    clean.buildingNumber,
    clean.certificate,
  );
}

export function etaCredentials(db: Database.Database): EtaCredentials {
  const r = settingsRow(db);
  if (r.enabled !== 1) throw new BusinessError("eta_not_enabled", "E-invoicing is off");
  return { environment: r.environment, clientId: r.client_id, clientSecret: r.client_secret, certificate: r.certificate };
}

/** Puts a just-posted document in the queue for the ETA, when e-invoicing is on. Part of the posting's transaction. */
export function queueEtaDocument(db: Database.Database, kind: EtaKind, documentId: number, now: Date): void {
  if (!etaEnabled(db)) return;
  db.prepare("INSERT INTO eta_documents (kind, document_id, status, updated_at) VALUES (?, ?, 'pending', ?)").run(
    kind,
    documentId,
    now.toISOString(),
  );
}

const DOCUMENTS = `
  SELECT e.kind, e.document_id AS documentId, e.status, e.uuid, e.error, e.updated_at AS updatedAt,
         COALESCE(s.number, n.number) AS number, COALESCE(s.date, n.date) AS date, c.name AS customerName,
         CASE e.kind WHEN 'invoice' THEN (SELECT SUM(net + vat) FROM sales_invoice_lines WHERE invoice_id = e.document_id)
                     ELSE (SELECT SUM(net + vat) FROM credit_note_lines WHERE note_id = e.document_id) END AS total
    FROM eta_documents e
    LEFT JOIN sales_invoices s ON e.kind = 'invoice' AND s.id = e.document_id
    LEFT JOIN credit_notes n ON e.kind = 'credit_note' AND n.id = e.document_id
    LEFT JOIN sales_invoices o ON o.id = n.invoice_id
    JOIN customers c ON c.id = COALESCE(s.customer_id, o.customer_id)`;

/** Every document sent or waiting to be sent, newest first; or only those in the given states. */
export function etaDocuments(db: Database.Database, statuses?: EtaStatus[]): EtaDocumentRow[] {
  const where = statuses ? ` WHERE e.status IN (${statuses.map(() => "?").join(", ")})` : "";
  return db.prepare(`${DOCUMENTS}${where} ORDER BY e.id DESC`).all(...(statuses ?? [])) as EtaDocumentRow[];
}

/** A document's ETA state by its printed number, or null when it was never queued. */
export function etaStateOf(db: Database.Database, kind: EtaKind, number: number): EtaState | null {
  const table = kind === "invoice" ? "sales_invoices" : "credit_notes";
  const row = db
    .prepare(`SELECT e.status, e.uuid, e.error FROM eta_documents e JOIN ${table} d ON d.id = e.document_id WHERE e.kind = ? AND d.number = ?`)
    .get(kind, number) as EtaState | undefined;
  return row ?? null;
}

function documentRow(db: Database.Database, kind: EtaKind, documentId: number): { status: EtaStatus; uuid: string; issued_at: string | null } {
  const row = db.prepare("SELECT status, uuid, issued_at FROM eta_documents WHERE kind = ? AND document_id = ?").get(kind, documentId) as
    | { status: EtaStatus; uuid: string; issued_at: string | null }
    | undefined;
  if (!row) throw new BusinessError("eta_document_not_found", `No e-invoice record for ${kind} ${documentId}`);
  return row;
}

/** Puts a failed or invalid document back in the queue. */
export function retryEtaDocument(db: Database.Database, kind: EtaKind, documentId: number, now: Date): void {
  const row = documentRow(db, kind, documentId);
  if (row.status !== "failed" && row.status !== "invalid")
    throw new BusinessError("eta_not_retryable", "Only failed or invalid documents are sent again");
  db.prepare("UPDATE eta_documents SET status = 'pending', error = '', updated_at = ? WHERE kind = ? AND document_id = ?").run(
    now.toISOString(),
    kind,
    documentId,
  );
}

export function recordEtaOutcome(db: Database.Database, kind: EtaKind, documentId: number, outcome: EtaOutcome, now: Date): void {
  const row = documentRow(db, kind, documentId);
  db.prepare("UPDATE eta_documents SET status = ?, uuid = ?, error = ?, updated_at = ? WHERE kind = ? AND document_id = ?").run(
    outcome.status,
    outcome.uuid ?? row.uuid,
    outcome.error ?? "",
    now.toISOString(),
    kind,
    documentId,
  );
}

type LineRow = {
  nameAr: string;
  code: string | null;
  egsCode: string;
  unit: "base" | "pack";
  unitName: string;
  quantity: number;
  discount: number;
  net: number;
  vatRate: number;
  vat: number;
  taxKind: EtaTaxKind;
};

const LINE_COLUMNS = `i.name_ar AS nameAr, i.code, i.egs_code AS egsCode, l.unit, u.name AS unitName,
  CASE WHEN l.vat_rate > 0 THEN 'standard' ELSE t.kind END AS taxKind`;
const LINE_JOINS = `JOIN items i ON i.id = l.item_id JOIN tax_codes t ON t.id = i.tax_code_id
  JOIN item_units u ON u.item_id = l.item_id AND u.kind = l.unit`;

/**
 * When a document counts as issued: the stored time if it was prepared before, else its date
 * at 10:00 in Cairo (08:00 UTC), but never later than now; the ETA refuses times in the future.
 */
function issuedAt(stored: string | null, date: string, now: Date): Date {
  if (stored) return new Date(stored);
  const morning = new Date(`${date}T08:00:00Z`);
  return new Date(Math.floor(Math.min(morning.getTime(), now.getTime()) / 1000) * 1000);
}

/**
 * The unsigned ETA document for a queued sales invoice or credit note, and the canonical text its
 * signature covers. Throws, naming what is missing, when the document can't be sent yet.
 */
export function prepareEtaDocument(
  db: Database.Database,
  kind: EtaKind,
  documentId: number,
  now: Date,
): { document: Record<string, unknown>; canonical: string } {
  const queued = documentRow(db, kind, documentId);
  const settings = settingsRow(db);
  const business = db.prepare("SELECT name, tax_registration_number AS rin FROM business_settings WHERE id = 1").get() as {
    name: string;
    rin: string;
  };
  const head = (
    kind === "invoice"
      ? db.prepare("SELECT number, date, customer_id AS customerId, NULL AS invoiceId FROM sales_invoices WHERE id = ?").get(documentId)
      : db
          .prepare(
            "SELECT n.number, n.date, s.customer_id AS customerId, s.id AS invoiceId FROM credit_notes n JOIN sales_invoices s ON s.id = n.invoice_id WHERE n.id = ?",
          )
          .get(documentId)
  ) as { number: number; date: string; customerId: number; invoiceId: number | null };
  const customer = db
    .prepare(
      "SELECT name, tax_registration_number AS rin, address, governate, region_city AS regionCity, building_number AS buildingNumber FROM customers WHERE id = ?",
    )
    .get(head.customerId) as { name: string; rin: string; address: string; governate: string; regionCity: string; buildingNumber: string };
  if (!/^\d{9}$/.test(customer.rin)) {
    throw new BusinessError(
      "eta_customer_tax_number_required",
      `${customer.name} needs a 9-digit tax registration number for e-invoices`,
      undefined,
      customer.name,
    );
  }
  if ([customer.address, customer.governate, customer.regionCity, customer.buildingNumber].some((v) => v.trim() === "")) {
    throw new BusinessError(
      "eta_customer_address_required",
      `${customer.name} needs a governorate, city, street and building number for e-invoices`,
      undefined,
      customer.name,
    );
  }
  const rows = (
    kind === "invoice"
      ? db
          .prepare(
            `SELECT ${LINE_COLUMNS}, l.quantity, l.discount, l.net, l.vat_rate AS vatRate, l.vat
               FROM sales_invoice_lines l ${LINE_JOINS} WHERE l.invoice_id = ? ORDER BY l.id`,
          )
          .all(documentId)
      : db
          .prepare(
            `SELECT ${LINE_COLUMNS}, x.quantity, 0 AS discount, x.net, l.vat_rate AS vatRate, x.vat
               FROM credit_note_lines x JOIN sales_invoice_lines l ON l.id = x.invoice_line_id ${LINE_JOINS} WHERE x.note_id = ? ORDER BY x.id`,
          )
          .all(documentId)
  ) as LineRow[];
  const uncoded = rows.find((r) => r.egsCode.trim() === "");
  if (uncoded)
    throw new BusinessError("eta_item_code_required", `${uncoded.nameAr} needs an EGS or GS1 code for e-invoices`, undefined, uncoded.nameAr);
  let references: string[] | undefined;
  if (kind === "credit_note") {
    const original = db.prepare("SELECT status, uuid FROM eta_documents WHERE kind = 'invoice' AND document_id = ?").get(head.invoiceId) as
      | { status: EtaStatus; uuid: string }
      | undefined;
    if (!original || original.status !== "valid") {
      throw new BusinessError("eta_invoice_not_valid", "A credit note goes to the ETA after its invoice is accepted as valid");
    }
    references = [original.uuid];
  }
  const at = issuedAt(queued.issued_at, head.date, now);
  db.prepare("UPDATE eta_documents SET issued_at = ? WHERE kind = ? AND document_id = ?").run(at.toISOString(), kind, documentId);
  const lines: EtaLineInput[] = rows.map((r) => ({
    description: r.unit === "pack" ? `${r.nameAr} (${r.unitName})` : r.nameAr,
    itemCode: r.egsCode.trim(),
    internalCode: r.code ?? "",
    unitType: "EA",
    quantity: r.quantity,
    salesTotal: r.net + r.discount,
    discount: r.discount,
    net: r.net,
    vat: r.vat,
    vatRate: r.vatRate,
    taxKind: r.taxKind,
  }));
  const document = etaDocument({
    type: kind === "invoice" ? "I" : "C",
    issuer: {
      rin: business.rin,
      name: business.name,
      activityCode: settings.activity_code,
      address: { governate: settings.governate, regionCity: settings.region_city, street: settings.street, buildingNumber: settings.building_number },
    },
    receiver: {
      rin: customer.rin,
      name: customer.name,
      address: { governate: customer.governate, regionCity: customer.regionCity, street: customer.address, buildingNumber: customer.buildingNumber },
    },
    internalId: `${kind === "invoice" ? "INV" : "CN"}-${head.number}`,
    issuedAt: at,
    lines,
    ...(references ? { references } : {}),
  });
  return { document, canonical: canonical(document) };
}
