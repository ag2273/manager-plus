import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Customer } from "../../../core/customers";
import type { InvoiceLineInput, PricedInvoice, SalesInvoice } from "../../../core/invoices";
import type { Item } from "../../../core/items";
import type { Warehouse } from "../../../core/stock";
import { formatMoney, parseMoney } from "../../../shared/money";
import { formatQuantity, parseQuantity } from "../../../shared/quantity";
import { business, errorText, today } from "../api";
import { ar } from "../strings";
import { useA4 } from "./Parties";

type Tab = "invoice" | "invoices";
const TABS: Tab[] = ["invoice", "invoices"];

/** A4 tax invoices to customers on account, and credit notes against them. */
export function SalesInvoices() {
  const [tab, setTab] = useState<Tab>("invoice");
  const [customers, setCustomers] = useState<Customer[]>([]);

  useEffect(() => {
    void business.customers().then((r) => r.ok && setCustomers(r.value));
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
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={t === tab} className="pill" onClick={() => setTab(t)}>
            {ar.invoices.tabs[t]}
          </button>
        ))}
      </div>
      {tab === "invoice" && <InvoiceForm customers={customers.filter((c) => c.active)} onPosted={() => setTab("invoices")} />}
      {tab === "invoices" && <InvoiceList />}
    </>
  );
}

type DraftLine = { itemId: number | ""; unit: "base" | "pack"; quantity: string; unitPrice: string; discount: string };
const emptyLine = (): DraftLine => ({ itemId: "", unit: "base", quantity: "", unitPrice: "", discount: "" });

/** A draft line as the core takes it, or null while it is incomplete; "bad" when something typed is not a number. */
function toLine(l: DraftLine): InvoiceLineInput | null | "bad" {
  const blank = l.itemId === "" && l.quantity.trim() === "" && l.unitPrice.trim() === "";
  if (blank) return null;
  const quantity = parseQuantity(l.quantity);
  const unitPrice = parseMoney(l.unitPrice);
  const discount = l.discount.trim() === "" ? 0 : parseMoney(l.discount);
  if (l.itemId === "" || quantity === null || quantity === 0 || unitPrice === null || discount === null) return "bad";
  return { itemId: l.itemId, unit: l.unit, quantity, unitPrice, discount };
}

function InvoiceForm({ customers, onPosted }: { customers: Customer[]; onPosted: () => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [customerId, setCustomerId] = useState<number | "">("");
  const [warehouseId, setWarehouseId] = useState<number | "">("");
  const [date, setDate] = useState(today());
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [priced, setPriced] = useState<{ rows: Record<number, PricedInvoice["lines"][number]>; totals: PricedInvoice } | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    setLines(lines.map((l, i) => (i === index ? { ...l, ...change } : l)));
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
    const result = await business.postSalesInvoice({ date, customerId, warehouseId: warehouseId === "" ? 0 : warehouseId, reference, notes, lines: out });
    setError(errorText(result));
    if (result.ok) {
      setDone(`${ar.invoices.posted(result.value.number, formatMoney(result.value.total))}${result.value.belowZero.length > 0 ? ` · ${ar.invoices.belowZero}` : ""}`);
      setLines([emptyLine()]);
      setReference("");
      setNotes("");
    }
  }

  return (
    <form className="card" onSubmit={submit} aria-label={ar.invoices.tabs.invoice}>
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      {done && (
        <div role="status" className="ok">
          {done}{" "}
          <button type="button" className="link" onClick={onPosted}>
            {ar.invoices.tabs.invoices}
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
            return (
              <tr key={i}>
                <td>
                  <select
                    aria-label={ar.invoices.item}
                    value={l.itemId}
                    onChange={(e) => setLine(i, { itemId: e.target.value === "" ? "" : Number(e.target.value), unit: "base" })}
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
                  <select aria-label={ar.invoices.unit} value={l.unit} onChange={(e) => setLine(i, { unit: e.target.value as "base" | "pack" })}>
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
              </tr>
            );
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
          {ar.invoices.post}
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
    const lines: { lineId: number; quantity: number }[] = [];
    for (const l of invoice.lines) {
      const text = quantities[l.lineId]?.trim() ?? "";
      if (text === "") continue;
      const quantity = parseQuantity(text);
      if (quantity === null) {
        setError(ar.errors["quantity_invalid"]!);
        return;
      }
      if (quantity > 0) lines.push({ lineId: l.lineId, quantity });
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
              <td>{l.nameAr}</td>
              <td className="muted">{l.unitName}</td>
              <td className="num">{formatQuantity(l.quantity)}</td>
              <td className="num">{formatMoney(l.unitPrice)}</td>
              <td className="num">{formatMoney(l.net)}</td>
              <td className="num muted">{l.credited > 0 && formatQuantity(l.credited)}</td>
              <td>
                <input
                  aria-label={ar.invoices.creditQuantity(l.nameAr)}
                  dir="ltr"
                  inputMode="decimal"
                  disabled={l.credited >= l.quantity}
                  value={quantities[l.lineId] ?? ""}
                  onChange={(e) => setQuantities({ ...quantities, [l.lineId]: e.target.value })}
                />
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
