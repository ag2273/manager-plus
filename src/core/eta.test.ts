import { createHash, verify } from "node:crypto";
import { describe, expect, test } from "vitest";
import { Business } from "./business";
import { children, read } from "./eta/der";
import { canonical } from "./eta/document";
import { type EtaClient, type EtaVerdict, cancelDocument, refreshStatuses, sendPending } from "./eta/sender";
import { testSigner } from "./eta/test-signer";

const manager = { name: "أيمن", password: "كلمة سر قوية" };
const shop = { name: "شركة النور للكمبيوتر", address: "", taxRegistrationNumber: "123456789", vatRegistered: true, fiscalYearStartMonth: 1 };
const settings = {
  enabled: true,
  environment: "preprod" as const,
  clientId: "client-id",
  clientSecret: "sealed-secret",
  activityCode: "4741",
  address: { governate: "الجيزة", regionCity: "الدقي", street: "شارع التحرير", buildingNumber: "12" },
  certificate: "AB12CD",
};

/** An ETA that accepts what it is sent, unless told to refuse an internal ID, and answers with set verdicts. */
function fakeEta(options: { refuse?: Record<string, string>; down?: boolean } = {}) {
  const received: Record<string, unknown>[] = [];
  const verdicts = new Map<string, EtaVerdict>();
  const cancelled: string[] = [];
  const client: EtaClient = {
    async submit(documents) {
      if (options.down) throw new Error("ECONNREFUSED");
      received.push(...documents);
      const accepted = [];
      const rejected = [];
      for (const d of documents) {
        const internalId = String(d["internalID"]);
        if (options.refuse?.[internalId]) rejected.push({ internalId, error: options.refuse[internalId]! });
        else accepted.push({ internalId, uuid: `UUID-${internalId}` });
      }
      return { accepted, rejected };
    },
    async status(uuid) {
      return verdicts.get(uuid) ?? { status: "submitted" };
    },
    async cancel(uuid) {
      cancelled.push(uuid);
    },
  };
  return { client, received, verdicts, cancelled };
}

function sample() {
  const business = Business.create(":memory:", shop, manager);
  const main = business.warehouses()[0]!.id;
  const code = (kind: string) => business.taxCodes().find((c) => c.kind === kind)!.id;
  const router = business.addItem({
    nameAr: "راوتر واي فاي 6",
    baseUnit: "قطعة",
    salePrice: 150_000,
    taxCodeId: code("standard"),
    egsCode: "EG-123456789-1001",
  });
  const card = business.addItem({ nameAr: "كارت شحن", baseUnit: "كارت", salePrice: 10_000, taxCodeId: code("exempt"), egsCode: "6221000000011" });
  const company = business.addCustomer({
    name: "شركة الأمل للتجارة",
    phone: "",
    taxRegistrationNumber: "987654321",
    address: "شارع عباس العقاد",
    governate: "القاهرة",
    regionCity: "مدينة نصر",
    buildingNumber: "5",
  });
  const invoice = (
    customerId = company,
    lines = [{ itemId: router, unit: "base" as const, quantity: 2_000, unitPrice: 120_000, discount: 10_000 }],
  ) => business.postSalesInvoice({ date: "2026-11-20", customerId, warehouseId: main, reference: "", notes: "", lines });
  return { business, router, card, company, invoice };
}

/** The signed attributes and RSA signature inside a CMS SignedData, and the certificate it carries. */
function signatureParts(base64: string) {
  const cms = new Uint8Array(Buffer.from(base64, "base64"));
  const signedData = children(children(children(read(cms))[1]!)[0]!);
  const signerInfo = children(children(signedData.at(-1)!)[0]!);
  const attributes = signerInfo[3]!;
  // The signature covers the attributes encoded as a SET.
  const asSet = Uint8Array.from([0x31, ...attributes.whole.subarray(1)]);
  const digest = children(attributes)
    .map((a) => children(a))
    .find(([type]) => Buffer.from(type!.whole).toString("hex") === "06092a864886f70d010904")!;
  return { asSet, signature: signerInfo[5]!.content, messageDigest: children(digest[1]!)[0]!.content };
}

describe("e-invoicing is optional", () => {
  test("it is off by default: posting queues nothing and the app works without it", () => {
    const { business, invoice } = sample();
    expect(business.etaSettings()).toMatchObject({ enabled: false, hasSecret: false });
    invoice();
    expect(business.etaDocuments()).toEqual([]);
    expect(business.etaState("invoice", 1)).toBeNull();
  });

  test("turning it on needs every setting, a 4-digit activity code and the business's tax number", () => {
    const { business } = sample();
    expect(() => business.setEtaSettings({ ...settings, activityCode: "47" })).toThrow(expect.objectContaining({ code: "activity_code_invalid" }));
    expect(() => business.setEtaSettings({ ...settings, certificate: "" })).toThrow(expect.objectContaining({ code: "eta_settings_incomplete" }));
    business.setEtaSettings(settings);
    expect(business.etaSettings()).toMatchObject({ enabled: true, hasSecret: true, activityCode: "4741" });
    expect(business.etaCredentials()).toEqual({
      environment: "preprod",
      clientId: "client-id",
      clientSecret: "sealed-secret",
      certificate: "AB12CD",
    });
    // Saving again without a secret keeps the sealed one; the audit log never holds it.
    business.setEtaSettings({
      enabled: true,
      environment: "preprod",
      clientId: "client-id",
      activityCode: "4741",
      address: settings.address,
      certificate: "AB12CD",
    });
    expect(business.etaCredentials().clientSecret).toBe("sealed-secret");
    expect(JSON.stringify(business.auditLog())).not.toContain("sealed-secret");
    // Only a manager changes them.
    business.addUser({ name: "منى", password: "كلمة سر 2", role: "accountant" });
    const accountant = business.signIn("منى", "كلمة سر 2");
    expect(accountant.etaSettings().enabled).toBe(true);
    expect(() => accountant.setEtaSettings(settings)).toThrow(expect.objectContaining({ code: "not_allowed" }));
  });
});

describe("sending to the ETA", () => {
  test("an invoice is serialised, signed with the token's certificate and submitted, then reported valid", async () => {
    const { business, invoice } = sample();
    business.setEtaSettings(settings);
    invoice();
    expect(business.etaState("invoice", 1)).toEqual({ status: "pending", uuid: "", error: "" });

    const eta = fakeEta();
    const signer = testSigner();
    const now = new Date("2026-11-21T09:00:00Z");
    expect(await sendPending(business.etaBooks(), signer, eta.client, now)).toBe(1);

    const sent = eta.received[0]!;
    expect(sent).toMatchObject({
      issuer: { type: "B", id: "123456789", address: { branchID: "0", country: "EG", governate: "الجيزة" } },
      receiver: { type: "B", id: "987654321", name: "شركة الأمل للتجارة", address: { regionCity: "مدينة نصر", street: "شارع عباس العقاد" } },
      documentType: "I",
      dateTimeIssued: "2026-11-20T08:00:00Z",
      taxpayerActivityCode: "4741",
      internalID: "INV-1",
      totalSalesAmount: 2400,
      totalDiscountAmount: 100,
      netAmount: 2300,
      taxTotals: [{ taxType: "T1", amount: 322 }],
      totalAmount: 2622,
    });
    expect((sent["invoiceLines"] as unknown[])[0]).toMatchObject({
      itemType: "EGS",
      itemCode: "EG-123456789-1001",
      quantity: 2,
      unitValue: { currencySold: "EGP", amountEGP: 1200 },
      salesTotal: 2400,
      discount: { amount: 100 },
      netTotal: 2300,
      taxableItems: [{ taxType: "T1", amount: 322, subType: "V009", rate: 14 }],
      total: 2622,
    });

    // The signature covers the canonical text of the document without its signatures.
    const { signatures, ...unsigned } = sent as { signatures: { signatureType: string; value: string }[] };
    expect(signatures[0]!.signatureType).toBe("I");
    const parts = signatureParts(signatures[0]!.value);
    expect(Buffer.from(parts.messageDigest).toString("hex")).toBe(createHash("sha256").update(canonical(unsigned)).digest("hex"));
    expect(verify("sha256", parts.asSet, signer.publicKeyPem, parts.signature)).toBe(true);

    expect(business.etaState("invoice", 1)).toEqual({ status: "submitted", uuid: "UUID-INV-1", error: "" });
    eta.verdicts.set("UUID-INV-1", { status: "valid" });
    await refreshStatuses(business.etaBooks(), eta.client);
    expect(business.etaState("invoice", 1)).toMatchObject({ status: "valid", uuid: "UUID-INV-1" });
  });

  test("a credit note follows its valid invoice and refers to it", async () => {
    const { business, invoice } = sample();
    business.setEtaSettings(settings);
    const posted = invoice();
    const lineId = business.findSalesInvoice(1).lines[0]!.lineId;
    business.postCreditNote({ date: "2026-11-21", invoiceId: posted.id, reason: "عيب", lines: [{ lineId, quantity: 1_000 }] });
    const eta = fakeEta();
    const signer = testSigner();

    await sendPending(business.etaBooks(), signer, eta.client);
    expect(business.etaState("credit_note", 1)).toMatchObject({ status: "failed", error: "eta_invoice_not_valid" });

    eta.verdicts.set("UUID-INV-1", { status: "valid" });
    await refreshStatuses(business.etaBooks(), eta.client);
    business.retryEta("credit_note", business.etaDocuments().find((d) => d.kind === "credit_note")!.documentId);
    await sendPending(business.etaBooks(), signer, eta.client);
    const note = eta.received.find((d) => d["documentType"] === "C")!;
    expect(note).toMatchObject({ internalID: "CN-1", references: ["UUID-INV-1"], netAmount: 1150, taxTotals: [{ amount: 161 }], totalAmount: 1311 });
    expect(business.etaState("credit_note", 1)!.status).toBe("submitted");
  });

  test("missing codes, tax numbers and addresses are named, and the document goes once fixed", async () => {
    const { business, router, card, company, invoice } = sample();
    business.setEtaSettings(settings);
    business.updateItem(router, { egsCode: "" });
    invoice();
    const walkIn = business.addCustomer({ name: "عميل نقدي", phone: "", taxRegistrationNumber: "" });
    invoice(walkIn, [{ itemId: card, unit: "base", quantity: 1_000, unitPrice: 10_000, discount: 0 }]);
    const eta = fakeEta();

    await sendPending(business.etaBooks(), testSigner(), eta.client);
    expect(business.etaState("invoice", 1)).toMatchObject({ status: "failed", error: "eta_item_code_required: راوتر واي فاي 6" });
    expect(business.etaState("invoice", 2)).toMatchObject({ status: "failed", error: "eta_customer_tax_number_required: عميل نقدي" });
    expect(eta.received).toEqual([]);

    business.updateItem(router, { egsCode: "EG-123456789-1001" });
    business.updateCustomer(company, { address: "" });
    const first = business.etaDocuments().find((d) => d.number === 1)!;
    business.retryEta("invoice", first.documentId);
    await sendPending(business.etaBooks(), testSigner(), eta.client);
    expect(business.etaState("invoice", 1)!.error).toBe("eta_customer_address_required: شركة الأمل للتجارة");

    business.updateCustomer(company, { address: "شارع عباس العقاد" });
    business.retryEta("invoice", first.documentId);
    await sendPending(business.etaBooks(), testSigner(), eta.client);
    expect(business.etaState("invoice", 1)!.status).toBe("submitted");
    expect(() => business.retryEta("invoice", first.documentId)).toThrow(expect.objectContaining({ code: "eta_not_retryable" }));
  });

  test("posting never waits on the ETA: when it is down the documents stay pending", async () => {
    const { business, invoice } = sample();
    business.setEtaSettings(settings);
    invoice();
    await expect(sendPending(business.etaBooks(), testSigner(), fakeEta({ down: true }).client)).rejects.toMatchObject({ code: "eta_unreachable" });
    expect(business.etaState("invoice", 1)!.status).toBe("pending");
    expect(business.findSalesInvoice(1).total).toBe(262_200);
  });

  test("a refused or invalid document is listed with the ETA's reason for retry, and an accepted one can be cancelled", async () => {
    const { business, invoice } = sample();
    business.setEtaSettings(settings);
    invoice();
    invoice();
    const eta = fakeEta({ refuse: { "INV-2": "Receiver tax number not registered" } });
    expect(await sendPending(business.etaBooks(), testSigner(), eta.client)).toBe(1);
    expect(business.etaState("invoice", 2)).toMatchObject({ status: "failed", error: "eta_rejected: Receiver tax number not registered" });

    eta.verdicts.set("UUID-INV-1", { status: "invalid", error: "Total amount mismatch" });
    await refreshStatuses(business.etaBooks(), eta.client);
    expect(business.etaState("invoice", 1)).toMatchObject({ status: "invalid", error: "eta_rejected: Total amount mismatch" });
    expect(business.etaDocuments().map((d) => [d.number, d.status])).toEqual([
      [2, "failed"],
      [1, "invalid"],
    ]);

    const first = business.etaDocuments().find((d) => d.number === 1)!;
    business.retryEta("invoice", first.documentId);
    await sendPending(business.etaBooks(), testSigner(), fakeEta().client);
    eta.verdicts.set("UUID-INV-1", { status: "valid" });
    await refreshStatuses(business.etaBooks(), eta.client);
    await cancelDocument(business.etaBooks(), eta.client, "invoice", first.documentId, "خطأ في السعر");
    expect(eta.cancelled).toEqual(["UUID-INV-1"]);
    expect(business.etaState("invoice", 1)!.status).toBe("cancelled");
    await expect(cancelDocument(business.etaBooks(), eta.client, "invoice", first.documentId, "")).rejects.toMatchObject({
      code: "eta_not_cancellable",
    });
  });
});

describe("the canonical form", () => {
  test("names in capitals, values in quotes, array elements under their name", () => {
    expect(canonical({ issuer: { id: "123", type: "B" }, invoiceLines: [{ quantity: 2 }, { quantity: 1.5 }], taxTotals: [] })).toBe(
      '"ISSUER""ID""123""TYPE""B""INVOICELINES""INVOICELINES""QUANTITY""2""INVOICELINES""QUANTITY""1.5""TAXTOTALS"',
    );
  });
});
