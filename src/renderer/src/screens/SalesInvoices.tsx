import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Customer } from "../../../core/customers";
import type { InvoiceLineInput, PricedInvoice, SalesInvoice, SalesInvoiceInput } from "../../../core/invoices";
import type { Quotation } from "../../../core/quotations";
import type { EtaDocumentRow } from "../../../core/eta/store";
import type { Item } from "../../../core/items";
import type { Warehouse } from "../../../core/stock";
import { formatMoney, parseMoney } from "../../../shared/money";
import { formatQuantity, parseQuantity } from "../../../shared/quantity";
import { business, errorText, today } from "../api";
import { ar } from "../strings";
import { SerialsField, splitSerials } from "./Serials";
import { APPROVAL_ERRORS, CreditApprovalPrompt } from "./CreditApproval";
import { useA4 } from "./Parties";

type Tab = "invoice" | "invoices" | "quotation" | "quotations" | "eta";
const TABS: Tab[] = ["invoice", "invoices", "quotation", "quotations"];

/** A4 tax invoices to customers on account, and credit notes against them. */
export function SalesInvoices() {
  const [tab, setTab] = useState<Tab>("invoice");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [from, setFrom] = useState<Quotation | null>(null);
  const [eta, setEta] = useState(false);

  useEffect(() => {
    void business.customers().then((r) => r.ok && setCustomers(r.value));
    void business.etaSettings().then((r) => r.ok && setEta(r.value.enabled));
  }, []);

  return (
    <>
      <header className="screen-head">
        <div>
          <h1>{ar.invoices.title}</h1>
          <span className="muted">{ar.invoices.hint}</span>
        </div>
      </header>
      <div role="tablist" aria-label={ar.invoices.title} className="pills">
        {(eta ? [...TABS, "eta" as const] : TABS).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={t === tab}
            className="pill"
            onClick={() => {
              setFrom(null);
              setTab(t);
            }}
          >
            {t === "eta" ? ar.eta.tab : ar.invoices.tabs[t]}
          </button>
        ))}
      </div>
      {tab === "invoice" && (
        <InvoiceForm key={from?.id ?? "new"} customers={customers.filter((c) => c.active)} from={from} onPosted={() => setTab("invoices")} />
      )}
      {tab === "invoices" && <InvoiceList />}
      {tab === "eta" && <EtaList />}
      {tab === "quotation" && <InvoiceForm kind="quotation" customers={customers.filter((c) => c.active)} onPosted={() => setTab("quotations")} />}
      {tab === "quotations" && (
        <QuotationList
          onConvert={(q) => {
            setFrom(q);
            setTab("invoice");
          }}
        />
      )}
    </>
  );
}

type DraftLine = { itemId: number | ""; unit: "base" | "pack"; quantity: string; unitPrice: string; discount: string; serials: string };
const emptyLine = (): DraftLine => ({ itemId: "", unit: "base", quantity: "", unitPrice: "", discount: "", serials: "" });

/** A draft line as the core takes it, or null while it is incomplete; "bad" when something typed is not a number. */
function toLine(l: DraftLine): InvoiceLineInput | null | "bad" {
  const blank = l.itemId === "" && l.quantity.trim() === "" && l.unitPrice.trim() === "";
  if (blank) return null;
  const quantity = parseQuantity(l.quantity);
  const unitPrice = parseMoney(l.unitPrice);
  const discount = l.discount.trim() === "" ? 0 : parseMoney(l.discount);
  if (l.itemId === "" || quantity === null || quantity === 0 || unitPrice === null || discount === null) return "bad";
  const serials = splitSerials(l.serials);
  return { itemId: l.itemId, unit: l.unit, quantity, unitPrice, discount, ...(serials.length > 0 ? { serials } : {}) };
}

const draftOf = (q: Quotation): DraftLine[] =>
  q.lines.map((l) => ({
    itemId: l.itemId,
    unit: l.unit,
    quantity: formatQuantity(l.quantity),
    unitPrice: formatMoney(l.unitPrice).replace(/,/g, ""),
    discount: l.discount > 0 ? formatMoney(l.discount).replace(/,/g, "") : "",
    serials: "",
  }));
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toLocaleDateString("en-CA");

/**
 * The invoice form, also used for quotations. A quotation has a validity date instead of a
 * warehouse and no serials; an invoice can start from a quotation's lines.
 */
function InvoiceForm({
  customers,
  onPosted,
  kind = "invoice",
  from = null,
}: {
  customers: Customer[];
  onPosted: () => void;
  kind?: "invoice" | "quotation";
  from?: Quotation | null;
}) {
  const quotation = kind === "quotation";
  const [items, setItems] = useState<Item[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [customerId, setCustomerId] = useState<number | "">(from?.customerId ?? "");
  const [warehouseId, setWarehouseId] = useState<number | "">("");
  const [date, setDate] = useState(today());
  const [validUntil, setValidUntil] = useState(inDays(14));
  const [reference, setReference] = useState(from?.reference ?? "");
  const [notes, setNotes] = useState(from?.notes ?? "");
  const [quotationId, setQuotationId] = useState<number | null>(from?.id ?? null);
  const [lines, setLines] = useState<DraftLine[]>(from ? draftOf(from) : [emptyLine()]);
  const [priced, setPriced] = useState<{ rows: Record<number, PricedInvoice["lines"][number]>; totals: PricedInvoice } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ invoice: SalesInvoiceInput; over: number } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    void business.items().then((r) => r.ok && setItems(r.value.filter((i) => i.active)));
    void business.warehouses().then((r) => {
      if (!r.ok) return;
      const active = r.value.filter((w) => w.active);
      setWarehouses(active);
      setWarehouseId((current) => (current === "" ? (active[0]?.id ?? "") : current));
    });
  }, []);

  // Net, VAT and totals come from the core, never from the screen.
  useEffect(() => {
    const complete: { index: number; line: InvoiceLineInput }[] = [];
    lines.forEach((l, index) => {
      const line = toLine(l);
      if (line && line !== "bad") complete.push({ index, line });
    });
    if (complete.length === 0) {
      setPriced(null);
      return;
    }
    let stale = false;
    void business.priceInvoice(date, complete.map((c) => c.line)).then((r) => {
      if (stale) return;
      if (!r.ok) {
        setPriced(null);
        return;
      }
      const rows: Record<number, PricedInvoice["lines"][number]> = {};
      r.value.lines.forEach((l, i) => {
        rows[complete[i]!.index] = l;
      });
      setPriced({ rows, totals: r.value });
    });
    return () => {
      stale = true;
    };
  }, [date, lines]);

  function setLine(index: number, change: Partial<DraftLine>) {
    setLines((current) => current.map((l, i) => (i === index ? { ...l, ...change } : l)));
  }

  /** Fills the price from the customer's price level when an item or unit is picked. */
  async function pick(index: number, change: Pick<DraftLine, "itemId" | "unit">) {
    setLine(index, change);
    if (change.itemId === "") return;
    const r = await business.listPrice(customerId === "" ? null : customerId, change.itemId, change.unit, date);
    if (r.ok) setLine(index, { unitPrice: formatMoney(r.value).replace(/,/g, "") });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setDone(null);
    const out: InvoiceLineInput[] = [];
    for (const l of lines) {
      const line = toLine(l);
      if (line === "bad") {
        setError(ar.errors["quantity_invalid"]!);
        return;
      }
      if (line) out.push(line);
    }
    if (customerId === "") {
      setError(ar.errors["customer_not_found"]!);
      return;
    }
    if (quotation) {
      const saved = await business.saveQuotation({ date, validUntil, customerId, reference, notes, lines: out.map((l) => ({ itemId: l.itemId, unit: l.unit, quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount ?? 0 })) });
      setError(errorText(saved));
      if (saved.ok) {
        setDone(ar.quotations.saved(saved.value.number));
        setLines([emptyLine()]);
        setReference("");
        setNotes("");
      }
      return;
    }
    await post({
      date,
      customerId,
      warehouseId: warehouseId === "" ? 0 : warehouseId,
      reference,
      notes,
      lines: out,
      ...(quotationId === null ? {} : { quotationId }),
    });
  }

  async function post(invoice: SalesInvoiceInput) {
    const result = await business.postSalesInvoice(invoice);
    const over = !result.ok && result.code === "credit_limit_exceeded" ? (result.amount ?? 0) : null;
    // A wrong manager sign-in keeps the prompt open with the error under it.
    if (!(pending && !result.ok && APPROVAL_ERRORS.includes(result.code))) setPending(over === null ? null : { invoice, over });
    setError(over === null ? errorText(result) : null);
    if (result.ok) {
      setQuotationId(null);
      setDone(`${ar.invoices.posted(result.value.number, formatMoney(result.value.total))}${result.value.belowZero.length > 0 ? ` · ${ar.invoices.belowZero}` : ""}`);
      setLines([emptyLine()]);
      setReference("");
      setNotes("");
    }
  }

  return (
    <form className="card" onSubmit={submit} aria-label={quotation ? ar.quotations.new : ar.invoices.tabs.invoice}>
      {quotationId !== null && from && <p className="muted small">{ar.quotations.fromQuotation(from.number)}</p>}
      {pending && (
        <CreditApprovalPrompt
          over={pending.over}
          onApprove={(creditApproval) => void post({ ...pending.invoice, creditApproval })}
          onCancel={() => setPending(null)}
        />
      )}
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      {done && (
        <div role="status" className="ok">
          {done}{" "}
          <button type="button" className="link" onClick={onPosted}>
            {quotation ? ar.invoices.tabs.quotations : ar.invoices.tabs.invoices}
          </button>
        </div>
      )}
      <div className="row">
        <label className="field">
          {ar.invoices.customer}
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value === "" ? "" : Number(e.target.value))}>
            <option value="">{ar.invoices.pickCustomer}</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        {quotation ? (
          <label className="field narrow">
            {ar.quotations.validUntil}
            <input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
          </label>
        ) : (
          <label className="field narrow">
            {ar.invoices.warehouse}
            <select value={warehouseId} onChange={(e) => setWarehouseId(Number(e.target.value))}>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field narrow">
          {ar.invoices.date}
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field narrow">
          {ar.invoices.reference}
          <input dir="ltr" value={reference} onChange={(e) => setReference(e.target.value)} />
        </label>
      </div>
      <table className="lines">
        <thead>
          <tr>
            <th>{ar.invoices.item}</th>
            <th className="col-type">{ar.invoices.unit}</th>
            <th className="col-money">{ar.invoices.quantity}</th>
            <th className="col-money">{ar.invoices.unitPrice}</th>
            <th className="col-money">{ar.invoices.discount}</th>
            <th className="col-money">{ar.invoices.net}</th>
            <th className="col-money">{ar.invoices.vat}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const item = items.find((it) => it.id === l.itemId);
            const row = priced?.rows[i];
            return [
              <tr key={i}>
                <td>
                  <select
                    aria-label={ar.invoices.item}
                    value={l.itemId}
                    onChange={(e) => void pick(i, { itemId: e.target.value === "" ? "" : Number(e.target.value), unit: "base" })}
                  >
                    <option value="">{ar.invoices.pickItem}</option>
                    {items.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.nameAr}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select aria-label={ar.invoices.unit} value={l.unit} onChange={(e) => void pick(i, { itemId: l.itemId, unit: e.target.value as "base" | "pack" })}>
                    <option value="base">{item?.baseUnit ?? "—"}</option>
                    {item?.pack && (
                      <option value="pack">
                        {item.pack.name} ({formatQuantity(item.pack.size)})
                      </option>
                    )}
                  </select>
                </td>
                <td>
                  <input aria-label={ar.invoices.quantity} dir="ltr" inputMode="decimal" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
                </td>
                <td>
                  <input aria-label={ar.invoices.unitPrice} dir="ltr" inputMode="decimal" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} />
                </td>
                <td>
                  <input aria-label={ar.invoices.discount} dir="ltr" inputMode="decimal" value={l.discount} onChange={(e) => setLine(i, { discount: e.target.value })} />
                </td>
                <td className="num">{row && formatMoney(row.net)}</td>
                <td className="num muted">{row && formatMoney(row.vat)}</td>
              </tr>,
              !quotation && item?.serialised && (
                <tr key={`${i}-serials`}>
                  <td colSpan={7}>
                    <SerialsField name={item.nameAr} value={l.serials} onChange={(serials, count) => setLine(i, { serials, unit: "base", quantity: String(count) })} />
                  </td>
                </tr>
              ),
            ];
          })}
        </tbody>
        {priced && (
          <tfoot>
            <tr>
              <td colSpan={5}>{ar.invoices.totals}</td>
              <td className="num">{formatMoney(priced.totals.net)}</td>
              <td className="num">{formatMoney(priced.totals.vat)}</td>
            </tr>
            <tr>
              <td colSpan={5}>
                <strong>{ar.invoices.totalWithVat}</strong>
              </td>
              <td colSpan={2} className="num">
                <strong>{formatMoney(priced.totals.total)}</strong>
              </td>
            </tr>
          </tfoot>
        )}
      </table>
      <div className="row">
        <button type="button" className="btn btn-small" onClick={() => setLines([...lines, emptyLine()])}>
          {ar.invoices.addLine}
        </button>
      </div>
      <label className="field">
        {ar.invoices.notes}
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <div className="row">
        <button type="submit" className="btn btn-primary">
          {quotation ? ar.quotations.save : ar.invoices.post}
        </button>
      </div>
    </form>
  );
}

function InvoiceList() {
  const [invoices, setInvoices] = useState<SalesInvoice[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const a4 = useA4();

  const reload = useCallback(async () => {
    const r = await business.salesInvoices();
    if (r.ok) setInvoices(r.value);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <>
      {a4.message && (
        <div role={a4.message.ok ? "status" : "alert"} className={a4.message.ok ? "ok" : "error"}>
          {a4.message.text}
        </div>
      )}
      <section className="table-card" aria-label={ar.invoices.tabs.invoices}>
        {invoices.length === 0 ? (
          <p className="muted empty">{ar.invoices.none}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th className="col-type">{ar.invoices.number}</th>
                <th className="col-type">{ar.invoices.date}</th>
                <th>{ar.invoices.customer}</th>
                <th className="col-money">{ar.invoices.total}</th>
                <th className="col-money">{ar.invoices.credited}</th>
                <th className="col-actions" />
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <InvoiceRow key={inv.id} invoice={inv} open={open === inv.id} onToggle={() => setOpen(open === inv.id ? null : inv.id)} onChange={reload} send={a4.send} />
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function InvoiceRow({
  invoice,
  open,
  onToggle,
  onChange,
  send,
}: {
  invoice: SalesInvoice;
  open: boolean;
  onToggle: () => void;
  onChange: () => Promise<void>;
  send: ReturnType<typeof useA4>["send"];
}) {
  return (
    <>
      <tr>
        <td>{invoice.number}</td>
        <td className="muted">{invoice.date}</td>
        <td>{invoice.customerName}</td>
        <td className="num">{formatMoney(invoice.total)}</td>
        <td className="num muted">{invoice.credited > 0 && formatMoney(invoice.credited)}</td>
        <td>
          <div className="actions">
            <button type="button" className="btn btn-small" onClick={() => void send({ kind: "invoice", number: invoice.number, output: "print" })}>
              {ar.parties.print}
            </button>
            <button type="button" className="btn btn-small" onClick={() => void send({ kind: "invoice", number: invoice.number, output: "pdf" })}>
              {ar.parties.pdf}
            </button>
            <button type="button" className="btn btn-small" onClick={() => void send({ kind: "deliveryNote", number: invoice.number, output: "print" })}>
              {ar.quotations.deliveryNote}
            </button>
            <button type="button" className="btn btn-small" aria-expanded={open} onClick={onToggle}>
              {open ? ar.invoices.hide : ar.invoices.details}
            </button>
          </div>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6}>
            <CreditNoteForm invoice={invoice} onChange={onChange} send={send} />
          </td>
        </tr>
      )}
    </>
  );
}

function CreditNoteForm({ invoice, onChange, send }: { invoice: SalesInvoice; onChange: () => Promise<void>; send: ReturnType<typeof useA4>["send"] }) {
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [reason, setReason] = useState("");
  const [date, setDate] = useState(today());
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const lines: { lineId: number; quantity: number; serials?: string[] }[] = [];
    for (const l of invoice.lines) {
      const text = quantities[l.lineId]?.trim() ?? "";
      if (text === "") continue;
      const serials = l.serials.length > 0 ? splitSerials(text) : [];
      const quantity = serials.length > 0 ? serials.length * 1000 : parseQuantity(text);
      if (quantity === null) {
        setError(ar.errors["quantity_invalid"]!);
        return;
      }
      if (quantity > 0) lines.push({ lineId: l.lineId, quantity, ...(serials.length > 0 ? { serials } : {}) });
    }
    const result = await business.postCreditNote({ date, invoiceId: invoice.id, reason, lines });
    setError(errorText(result));
    if (result.ok) {
      setDone(ar.invoices.creditDone(result.value.number, formatMoney(result.value.total)));
      setQuantities({});
      setReason("");
      await onChange();
    }
  }

  return (
    <form className="stack" onSubmit={submit} aria-label={ar.invoices.creditNote}>
      <table className="lines">
        <thead>
          <tr>
            <th>{ar.invoices.item}</th>
            <th className="col-type">{ar.invoices.unit}</th>
            <th className="col-money">{ar.invoices.quantity}</th>
            <th className="col-money">{ar.invoices.unitPrice}</th>
            <th className="col-money">{ar.invoices.net}</th>
            <th className="col-money">{ar.invoices.alreadyCredited}</th>
            <th className="col-money">{ar.invoices.returning}</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((l) => (
            <tr key={l.lineId}>
              <td>
                {l.nameAr}
                {l.serials.length > 0 && (
                  <div className="muted small" dir="ltr">
                    {l.serials.join(ar.list)}
                  </div>
                )}
              </td>
              <td className="muted">{l.unitName}</td>
              <td className="num">{formatQuantity(l.quantity)}</td>
              <td className="num">{formatMoney(l.unitPrice)}</td>
              <td className="num">{formatMoney(l.net)}</td>
              <td className="num muted">{l.credited > 0 && formatQuantity(l.credited)}</td>
              <td>
                {l.serials.length > 0 ? (
                  <textarea
                    aria-label={ar.invoices.creditQuantity(l.nameAr)}
                    dir="ltr"
                    rows={2}
                    placeholder={ar.serials.label}
                    disabled={l.credited >= l.quantity}
                    value={quantities[l.lineId] ?? ""}
                    onChange={(e) => setQuantities({ ...quantities, [l.lineId]: e.target.value })}
                  />
                ) : (
                  <input
                    aria-label={ar.invoices.creditQuantity(l.nameAr)}
                    dir="ltr"
                    inputMode="decimal"
                    disabled={l.credited >= l.quantity}
                    value={quantities[l.lineId] ?? ""}
                    onChange={(e) => setQuantities({ ...quantities, [l.lineId]: e.target.value })}
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      {done && (
        <div role="status" className="ok">
          {done}
        </div>
      )}
      <div className="row">
        <label className="field">
          {ar.invoices.reason}
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <label className="field narrow">
          {ar.invoices.date}
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <button type="submit" className="btn btn-primary">
          {ar.invoices.postCreditNote}
        </button>
      </div>
      {invoice.creditNotes.length > 0 && (
        <div className="row">
          {invoice.creditNotes.map((n) => (
            <button key={n.number} type="button" className="btn btn-small" onClick={() => void send({ kind: "creditNote", number: n.number, output: "print" })}>
              {ar.invoices.printNote(n.number)}
            </button>
          ))}
        </div>
      )}
    </form>
  );
}

/** Quotations with their status; an open one can be printed or turned into an invoice. */
function QuotationList({ onConvert }: { onConvert: (q: Quotation) => void }) {
  const [quotations, setQuotations] = useState<Quotation[]>([]);
  const { send, message } = useA4();

  useEffect(() => {
    void business.quotations(today()).then((r) => r.ok && setQuotations(r.value));
  }, []);

  return (
    <section className="table-card" aria-label={ar.invoices.tabs.quotations}>
      {message && (
        <div role={message.ok ? "status" : "alert"} className={message.ok ? "ok" : "error"}>
          {message.text}
        </div>
      )}
      {quotations.length === 0 ? (
        <p className="muted empty">{ar.quotations.none}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th className="col-type">{ar.quotations.number}</th>
              <th className="col-type">{ar.invoices.date}</th>
              <th>{ar.invoices.customer}</th>
              <th className="col-type">{ar.quotations.validUntil}</th>
              <th className="col-money">{ar.invoices.totalWithVat}</th>
              <th className="col-type">{ar.quotations.status}</th>
              <th className="col-actions" />
            </tr>
          </thead>
          <tbody>
            {quotations.map((q) => (
              <tr key={q.id}>
                <td>{q.number}</td>
                <td className="muted">{q.date}</td>
                <td>{q.customerName}</td>
                <td className="muted">{q.validUntil}</td>
                <td className="num">{formatMoney(q.total)}</td>
                <td>
                  <span className={`chip${q.status === "open" ? "" : " chip-warn"}`}>
                    {q.status === "converted" && q.invoiceNumber !== null ? ar.quotations.convertedTo(q.invoiceNumber) : ar.quotations.statuses[q.status]}
                  </span>
                </td>
                <td>
                  <div className="actions">
                    <button type="button" className="btn btn-small" onClick={() => void send({ kind: "quotation", number: q.number, output: "print" })}>
                      {ar.parties.print}
                    </button>
                    <button type="button" className="btn btn-small" onClick={() => void send({ kind: "quotation", number: q.number, output: "pdf" })}>
                      {ar.parties.pdf}
                    </button>
                    {q.status !== "converted" && (
                      <button type="button" className="btn btn-small btn-primary" onClick={() => onConvert(q)}>
                        {ar.quotations.convert}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** The ETA's message for a failed document: "code" or "code: detail", worded in the screen language. */
function etaProblem(error: string): string {
  if (error === "") return "";
  const at = error.indexOf(": ");
  const code = at === -1 ? error : error.slice(0, at);
  const detail = at === -1 ? "" : error.slice(at + 2);
  const text = ar.errors[code];
  if (!text) return error;
  return detail ? `${text} (${detail})` : text;
}

/** Invoices and credit notes sent, or waiting to be sent, to the ETA: status, UUID, why one failed, retry and cancel. */
function EtaList() {
  const [rows, setRows] = useState<EtaDocumentRow[]>([]);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [cancelling, setCancelling] = useState<{ row: EtaDocumentRow; reason: string } | null>(null);
  const load = useCallback(async () => {
    const r = await business.etaDocuments();
    if (r.ok) setRows(r.value);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function retry(row: EtaDocumentRow) {
    const result = await business.retryEta(row.kind, row.documentId);
    setMessage(result.ok ? null : { ok: false, text: errorText(result)! });
    const sent = await window.api.sendEtaNow();
    if (!sent.ok && sent.code !== "restore_needs_manager") setMessage({ ok: false, text: errorText(sent)! });
    await load();
  }

  async function cancel(event: FormEvent) {
    event.preventDefault();
    if (!cancelling) return;
    const result = await window.api.cancelEta(cancelling.row.kind, cancelling.row.documentId, cancelling.reason);
    setMessage(result.ok ? null : { ok: false, text: errorText(result)! });
    if (result.ok) setCancelling(null);
    await load();
  }

  return (
    <section className="table-card" aria-label={ar.eta.tab}>
      {message && (
        <div role={message.ok ? "status" : "alert"} className={message.ok ? "ok" : "error"}>
          {message.text}
        </div>
      )}
      {cancelling && (
        <form className="row" onSubmit={cancel}>
          <label className="field">
            {ar.eta.cancelReason}
            <input autoFocus value={cancelling.reason} onChange={(e) => setCancelling({ ...cancelling, reason: e.target.value })} />
          </label>
          <button type="submit" className="btn btn-primary" disabled={cancelling.reason.trim() === ""}>
            {ar.eta.cancel}
          </button>
          <button type="button" className="btn" onClick={() => setCancelling(null)}>
            {ar.cancel}
          </button>
        </form>
      )}
      {rows.length === 0 ? (
        <p className="muted">{ar.eta.empty}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{ar.eta.document}</th>
              <th>{ar.invoices.date}</th>
              <th>{ar.invoices.customer}</th>
              <th className="col-money">{ar.invoices.total}</th>
              <th>{ar.eta.status}</th>
              <th>{ar.eta.uuid}</th>
              <th>{ar.eta.problem}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.kind}-${r.documentId}`}>
                <td>
                  {ar.eta.kinds[r.kind]} {r.number}
                </td>
                <td>{r.date}</td>
                <td>{r.customerName}</td>
                <td className="num">{formatMoney(r.total)}</td>
                <td>
                  <span className={r.status === "valid" ? "badge" : r.status === "failed" || r.status === "invalid" ? "badge warn" : "badge muted"}>
                    {ar.eta.statuses[r.status]}
                  </span>
                </td>
                <td dir="ltr" className="small">
                  {r.uuid}
                </td>
                <td className="small">{etaProblem(r.error)}</td>
                <td>
                  {(r.status === "failed" || r.status === "invalid") && (
                    <button type="button" className="link" onClick={() => void retry(r)}>
                      {ar.eta.retry}
                    </button>
                  )}
                  {(r.status === "valid" || r.status === "submitted") && (
                    <button type="button" className="link" onClick={() => setCancelling({ row: r, reason: "" })}>
                      {ar.eta.cancel}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
