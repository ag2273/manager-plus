import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Item } from "../../../core/items";
import { CURRENCIES, type Currency, type PricedPurchase, type PurchaseInvoice, type PurchaseLineInput, type Supplier, type SupplierAccount } from "../../../core/purchases";
import type { Warehouse } from "../../../core/stock";
import type { Result } from "../../../shared/api";
import { formatMoney, parseMoney } from "../../../shared/money";
import { formatQuantity, parseQuantity } from "../../../shared/quantity";
import { business, errorText, today } from "../api";
import { ar } from "../strings";
import { WithholdingSelect, useWithholdingCategories } from "./Withholding";
import { AgingView, PaymentForm, StatementView } from "./Parties";
import { SerialsField, splitSerials } from "./Serials";
import { Shipments } from "./Shipments";
import { formatRate, parseRate } from "../../../shared/rate";

type Tab = "invoice" | "invoices" | "shipments" | "suppliers" | "payment" | "statement" | "aging";

/** Supplier invoices into a warehouse, past invoices, and the supplier list. */
export function Purchases({ canSeeBalances }: { canSeeBalances: boolean }) {
  const [tab, setTab] = useState<Tab>("invoice");
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const tabs: Tab[] = canSeeBalances ? ["invoice", "invoices", "shipments", "suppliers", "payment", "statement", "aging"] : ["invoice", "invoices", "suppliers"];

  const reload = useCallback(async () => {
    const result = await business.suppliers();
    if (result.ok) setSuppliers(result.value);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <>
      <header className="screen-head">
        <div>
          <h1>{ar.purchases.title}</h1>
          <span className="muted">{ar.purchases.hint}</span>
        </div>
      </header>
      <div role="tablist" aria-label={ar.purchases.title} className="pills">
        {tabs.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={t === tab} className="pill" onClick={() => setTab(t)}>
            {ar.purchases.tabs[t]}
          </button>
        ))}
      </div>
      {tab === "invoice" && <InvoiceForm suppliers={suppliers.filter((s) => s.active)} />}
      {tab === "invoices" && <InvoiceList suppliers={suppliers} />}
      {tab === "shipments" && <Shipments suppliers={suppliers} />}
      {tab === "suppliers" && <SupplierList suppliers={suppliers} onChange={reload} canSeeBalances={canSeeBalances} />}
      {tab === "payment" && <PaymentForm kind="supplier" parties={suppliers} />}
      {tab === "statement" && <StatementView kind="supplier" parties={suppliers} />}
      {tab === "aging" && <AgingView kind="supplier" />}
    </>
  );
}

type DraftLine = { itemId: number | ""; unit: "base" | "pack"; quantity: string; unitPrice: string; serials: string };
const emptyLine = (): DraftLine => ({ itemId: "", unit: "base", quantity: "", unitPrice: "", serials: "" });
const withSerials = (l: DraftLine) => (splitSerials(l.serials).length > 0 ? { serials: splitSerials(l.serials) } : {});

/** The lines that are filled in completely, with the index of the draft row each came from. */
function completeLines(lines: DraftLine[]): { index: number; line: PurchaseLineInput }[] {
  const out: { index: number; line: PurchaseLineInput }[] = [];
  lines.forEach((l, index) => {
    const quantity = parseQuantity(l.quantity);
    const unitPrice = parseMoney(l.unitPrice);
    if (l.itemId !== "" && quantity !== null && quantity > 0 && unitPrice !== null) {
      out.push({ index, line: { itemId: l.itemId, unit: l.unit, quantity, unitPrice, ...withSerials(l) } });
    }
  });
  return out;
}

function InvoiceForm({ suppliers }: { suppliers: Supplier[] }) {
  const [items, setItems] = useState<Item[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [supplierId, setSupplierId] = useState<number | "">("");
  const [warehouseId, setWarehouseId] = useState<number | "">("");
  const [date, setDate] = useState(today());
  const [reference, setReference] = useState("");
  const [rateText, setRateText] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const supplier = suppliers.find((s) => s.id === supplierId);
  const foreign = supplier !== undefined && supplier.currency !== "EGP";
  const rate = foreign ? parseRate(rateText) : null;
  const [priced, setPriced] = useState<{ rows: Record<number, PricedPurchase["lines"][number]>; totals: PricedPurchase } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    void business.items().then((r) => r.ok && setItems(r.value));
    void business.warehouses().then((r) => {
      if (!r.ok) return;
      const active = r.value.filter((w) => w.active);
      setWarehouses(active);
      setWarehouseId((current) => (current === "" ? (active[0]?.id ?? "") : current));
    });
  }, []);

  // Net, VAT and totals come from the core, never from the screen.
  useEffect(() => {
    const complete = completeLines(lines);
    if (complete.length === 0) {
      setPriced(null);
      return;
    }
    if (foreign && rate === null) {
      setPriced(null);
      return;
    }
    let stale = false;
    const money = foreign && rate !== null ? { currency: supplier.currency, rate } : undefined;
    void business.pricePurchase(date, complete.map((c) => c.line), money).then((r) => {
      if (stale) return;
      if (!r.ok) {
        setPriced(null);
        return;
      }
      const rows: Record<number, PricedPurchase["lines"][number]> = {};
      r.value.lines.forEach((l, i) => {
        rows[complete[i]!.index] = l;
      });
      setPriced({ rows, totals: r.value });
    });
    return () => {
      stale = true;
    };
  }, [date, lines, foreign, rate, supplier?.currency]);

  function setLine(index: number, change: Partial<DraftLine>) {
    setLines(lines.map((l, i) => (i === index ? { ...l, ...change } : l)));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setDone(null);
    const out: PurchaseLineInput[] = [];
    for (const l of lines) {
      if (l.itemId === "" && l.quantity.trim() === "" && l.unitPrice.trim() === "") continue;
      const quantity = parseQuantity(l.quantity);
      const unitPrice = parseMoney(l.unitPrice);
      if (l.itemId === "" || quantity === null || quantity === 0) {
        setError(ar.errors["quantity_invalid"]!);
        return;
      }
      if (unitPrice === null) {
        setError(ar.errors["price_invalid"]!);
        return;
      }
      out.push({ itemId: l.itemId, unit: l.unit, quantity, unitPrice, ...withSerials(l) });
    }
    if (supplierId === "") {
      setError(ar.errors["supplier_not_found"]!);
      return;
    }
    if (warehouseId === "") {
      setError(ar.errors["warehouse_not_found"]!);
      return;
    }
    if (foreign && rate === null) {
      setError(ar.errors["rate_invalid"]!);
      return;
    }
    const result: Result<number> = await business.postPurchaseInvoice({
      date,
      supplierId,
      warehouseId,
      reference,
      lines: out,
      ...(foreign && rate !== null ? { rate } : {}),
    });
    setError(errorText(result));
    if (result.ok) {
      setDone(ar.purchases.posted);
      setLines([emptyLine()]);
      setReference("");
    }
  }

  return (
    <form className="card" onSubmit={submit}>
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
          {ar.purchases.supplier}
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value === "" ? "" : Number(e.target.value))}>
            <option value="">{ar.purchases.pickSupplier}</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field narrow">
          {ar.purchases.warehouse}
          <select value={warehouseId} onChange={(e) => setWarehouseId(Number(e.target.value))}>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field narrow">
          {ar.purchases.date}
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field narrow">
          {ar.purchases.reference}
          <input dir="ltr" value={reference} onChange={(e) => setReference(e.target.value)} />
        </label>
        {foreign && (
          <label className="field narrow">
            {ar.purchases.rate(supplier.currency)}
            <input dir="ltr" inputMode="decimal" placeholder="48.50" value={rateText} onChange={(e) => setRateText(e.target.value)} />
          </label>
        )}
      </div>
      {foreign && (
        <p className="muted small">
          {ar.purchases.inCurrency(supplier.currency)} · {ar.purchases.noVatForeign}
        </p>
      )}
      <table className="lines">
        <thead>
          <tr>
            <th>{ar.purchases.item}</th>
            <th className="col-type">{ar.purchases.unit}</th>
            <th className="col-money">{ar.purchases.quantity}</th>
            <th className="col-money">{ar.purchases.unitPrice}</th>
            <th className="col-money">{ar.purchases.net}</th>
            <th className="col-money">{ar.purchases.vat}</th>
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
                    aria-label={ar.purchases.item}
                    value={l.itemId}
                    onChange={(e) => setLine(i, { itemId: e.target.value === "" ? "" : Number(e.target.value), unit: "base" })}
                  >
                    <option value="">{ar.purchases.pickItem}</option>
                    {items.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.nameAr}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select aria-label={ar.purchases.unit} value={l.unit} onChange={(e) => setLine(i, { unit: e.target.value as "base" | "pack" })}>
                    <option value="base">{item?.baseUnit ?? "—"}</option>
                    {item?.pack && (
                      <option value="pack">
                        {item.pack.name} ({formatQuantity(item.pack.size)})
                      </option>
                    )}
                  </select>
                </td>
                <td>
                  <input aria-label={ar.purchases.quantity} dir="ltr" inputMode="decimal" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
                </td>
                <td>
                  <input aria-label={ar.purchases.unitPrice} dir="ltr" inputMode="decimal" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} />
                </td>
                <td className="num">{row && formatMoney(row.net)}</td>
                <td className="num muted">{row && formatMoney(row.vat)}</td>
              </tr>,
              item?.serialised && (
                <tr key={`${i}-serials`}>
                  <td colSpan={6}>
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
              <td colSpan={4}>{ar.purchases.totals}</td>
              <td className="num">{formatMoney(priced.totals.net)}</td>
              <td className="num">{formatMoney(priced.totals.vat)}</td>
            </tr>
            <tr>
              <td colSpan={4}>
                <strong>{ar.purchases.totalWithVat}</strong>
              </td>
              <td colSpan={2} className="num">
                <strong>
                  {foreign && `${supplier.currency} `}
                  {formatMoney(priced.totals.total)}
                </strong>
              </td>
            </tr>
            {foreign && (
              <tr>
                <td colSpan={4}>{ar.purchases.totalInEgp}</td>
                <td colSpan={2} className="num">
                  {formatMoney(priced.totals.totalEgp)}
                </td>
              </tr>
            )}
          </tfoot>
        )}
      </table>
      <div className="row">
        <button type="button" className="btn btn-small" onClick={() => setLines([...lines, emptyLine()])}>
          {ar.purchases.addLine}
        </button>
      </div>
      <div className="row">
        <button type="submit" className="btn btn-primary">
          {ar.purchases.post}
        </button>
      </div>
    </form>
  );
}

function InvoiceList({ suppliers }: { suppliers: Supplier[] }) {
  const [invoices, setInvoices] = useState<PurchaseInvoice[]>([]);
  const [open, setOpen] = useState<number | null>(null);

  const reload = useCallback(async () => {
    const r = await business.purchaseInvoices();
    if (r.ok) setInvoices(r.value);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const name = (id: number) => suppliers.find((s) => s.id === id)?.name ?? "";

  return (
    <section className="table-card" aria-label={ar.purchases.tabs.invoices}>
      {invoices.length === 0 ? (
        <p className="muted empty">{ar.purchases.none}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th className="col-type">{ar.purchases.date}</th>
              <th>{ar.purchases.supplier}</th>
              <th className="col-type">{ar.purchases.reference}</th>
              <th className="col-type">{ar.purchases.lines}</th>
              <th className="col-money">{ar.purchases.net}</th>
              <th className="col-money">{ar.purchases.vat}</th>
              <th className="col-money">{ar.purchases.total}</th>
              <th className="col-type">{ar.purchases.postedBy}</th>
              <th className="col-actions" />
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv) => [
              <tr key={inv.id}>
                <td className="muted">{inv.date}</td>
                <td>{name(inv.supplierId)}</td>
                <td className="muted" dir="ltr">
                  {inv.reference}
                </td>
                <td>{inv.lines.length}</td>
                <td className="num">{formatMoney(inv.net)}</td>
                <td className="num">{formatMoney(inv.vat)}</td>
                <td className="num">
                  {inv.currency !== "EGP" && `${inv.currency} `}
                  {formatMoney(inv.total)}
                  {inv.currency !== "EGP" && (
                    <div className="muted small">
                      {formatMoney(inv.totalEgp)} @ {formatRate(inv.rate)}
                    </div>
                  )}
                </td>
                <td className="muted">{inv.postedBy}</td>
                <td>
                  <button type="button" className="btn btn-small" aria-expanded={open === inv.id} onClick={() => setOpen(open === inv.id ? null : inv.id)}>
                    {ar.purchases.returnToSupplier}
                  </button>
                </td>
              </tr>,
              open === inv.id && (
                <tr key={`${inv.id}-return`}>
                  <td colSpan={9}>
                    <DebitNoteForm invoice={inv} onChange={reload} />
                  </td>
                </tr>
              ),
            ])}
          </tbody>
        </table>
      )}
    </section>
  );
}

function DebitNoteForm({ invoice, onChange }: { invoice: PurchaseInvoice; onChange: () => Promise<void> }) {
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [serialised, setSerialised] = useState<Set<number>>(new Set());

  useEffect(() => {
    void business.items({ includeInactive: true }).then((r) => r.ok && setSerialised(new Set(r.value.filter((i) => i.serialised).map((i) => i.id))));
  }, []);
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
      const serials = serialised.has(l.itemId) ? splitSerials(text) : [];
      const quantity = serials.length > 0 ? serials.length * 1000 : parseQuantity(text);
      if (quantity === null) {
        setError(ar.errors["quantity_invalid"]!);
        return;
      }
      if (quantity > 0) lines.push({ lineId: l.lineId, quantity, ...(serials.length > 0 ? { serials } : {}) });
    }
    const result = await business.postDebitNote({ date, purchaseInvoiceId: invoice.id, reason, lines });
    setError(errorText(result));
    if (result.ok) {
      setDone(ar.purchases.debitNoteDone(result.value.number, formatMoney(result.value.total)));
      setQuantities({});
      setReason("");
      await onChange();
    }
  }

  return (
    <form className="stack" onSubmit={submit} aria-label={ar.purchases.debitNote}>
      <table className="lines">
        <thead>
          <tr>
            <th>{ar.purchases.item}</th>
            <th className="col-money">{ar.purchases.quantity}</th>
            <th className="col-money">{ar.purchases.unitPrice}</th>
            <th className="col-money">{ar.purchases.alreadyReturned}</th>
            <th className="col-money">{ar.purchases.returnToSupplier}</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((l) => (
            <tr key={l.lineId}>
              <td>{l.nameAr}</td>
              <td className="num">{formatQuantity(l.quantity)}</td>
              <td className="num">{formatMoney(l.unitPrice)}</td>
              <td className="num muted">{l.returned > 0 && formatQuantity(l.returned)}</td>
              <td>
                {serialised.has(l.itemId) ? (
                  <textarea
                    aria-label={ar.purchases.returnQuantity(l.nameAr)}
                    dir="ltr"
                    rows={2}
                    placeholder={ar.serials.label}
                    disabled={l.returned >= l.quantity}
                    value={quantities[l.lineId] ?? ""}
                    onChange={(e) => setQuantities({ ...quantities, [l.lineId]: e.target.value })}
                  />
                ) : (
                  <input
                    aria-label={ar.purchases.returnQuantity(l.nameAr)}
                    dir="ltr"
                    inputMode="decimal"
                    disabled={l.returned >= l.quantity}
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
          {ar.purchases.reason}
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <label className="field narrow">
          {ar.purchases.date}
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <button type="submit" className="btn btn-primary">
          {ar.purchases.postDebitNote}
        </button>
      </div>
    </form>
  );
}

type SupplierDraft = { name: string; phone: string; taxRegistrationNumber: string; currency: Currency; withholdingCategoryId: number | null };
const emptySupplier: SupplierDraft = { name: "", phone: "", taxRegistrationNumber: "", currency: "EGP", withholdingCategoryId: null };

function SupplierList({
  suppliers,
  onChange,
  canSeeBalances,
}: {
  suppliers: Supplier[];
  onChange: () => Promise<void>;
  canSeeBalances: boolean;
}) {
  const [draft, setDraft] = useState<SupplierDraft>(emptySupplier);
  const [editing, setEditing] = useState<(SupplierDraft & { id: number }) | null>(null);
  const [balances, setBalances] = useState<Record<number, SupplierAccount>>({});
  const [categories] = useWithholdingCategories();
  const categoryName = (id: number | null) => categories.find((c) => c.id === id)?.name ?? "";
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canSeeBalances) return;
    void Promise.all(suppliers.map((s) => business.supplierAccount(s.id))).then((results) => {
      const next: Record<number, SupplierAccount> = {};
      results.forEach((r, i) => {
        if (r.ok) next[suppliers[i]!.id] = r.value;
      });
      setBalances(next);
    });
  }, [suppliers, canSeeBalances]);

  async function run(work: Promise<Result<unknown>>): Promise<boolean> {
    const result = await work;
    setError(errorText(result));
    if (result.ok) await onChange();
    return result.ok;
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (await run(business.addSupplier(draft))) setDraft(emptySupplier);
  }

  return (
    <>
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      <form className="card form-row" onSubmit={add}>
        <label className="field">
          {ar.purchases.name}
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
        <label className="field narrow">
          {ar.purchases.phone}
          <input dir="ltr" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
        </label>
        <label className="field narrow">
          {ar.purchases.taxRegistrationNumber}
          <input
            dir="ltr"
            value={draft.taxRegistrationNumber}
            onChange={(e) => setDraft({ ...draft, taxRegistrationNumber: e.target.value })}
          />
        </label>
        <label className="field narrow">
          {ar.purchases.currency}
          <select value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value as Currency })}>
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="field narrow">
          {ar.withholding.category}
          <WithholdingSelect categories={categories} value={draft.withholdingCategoryId} onChange={(id) => setDraft({ ...draft, withholdingCategoryId: id })} />
        </label>
        <button type="submit" className="btn btn-primary">
          {ar.purchases.addSupplier}
        </button>
      </form>
      <section className="table-card" aria-label={ar.purchases.tabs.suppliers}>
        {suppliers.length === 0 ? (
          <p className="muted empty">{ar.purchases.noSuppliers}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{ar.purchases.name}</th>
                <th className="col-type">{ar.purchases.phone}</th>
                <th className="col-type">{ar.purchases.taxRegistrationNumber}</th>
                <th className="col-type">{ar.purchases.currency}</th>
                <th className="col-type">{ar.withholding.category}</th>
                {canSeeBalances && <th className="col-money">{ar.purchases.balance}</th>}
                <th className="col-actions" />
              </tr>
            </thead>
            <tbody>
              {suppliers.map((s) =>
                editing?.id === s.id ? (
                  <tr key={s.id}>
                    <td>
                      <input aria-label={ar.purchases.name} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                    </td>
                    <td>
                      <input aria-label={ar.purchases.phone} dir="ltr" value={editing.phone} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} />
                    </td>
                    <td>
                      <input
                        aria-label={ar.purchases.taxRegistrationNumber}
                        dir="ltr"
                        value={editing.taxRegistrationNumber}
                        onChange={(e) => setEditing({ ...editing, taxRegistrationNumber: e.target.value })}
                      />
                    </td>
                    <td>
                      <select aria-label={ar.purchases.currency} value={editing.currency} onChange={(e) => setEditing({ ...editing, currency: e.target.value as Currency })}>
                        {CURRENCIES.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <WithholdingSelect
                        categories={categories}
                        value={editing.withholdingCategoryId}
                        onChange={(id) => setEditing({ ...editing, withholdingCategoryId: id })}
                      />
                    </td>
                    {canSeeBalances && <td />}
                    <td>
                      <div className="actions">
                        <button
                          type="button"
                          className="btn btn-small btn-primary"
                          onClick={async () => {
                            const { id, ...changes } = editing;
                            if (await run(business.updateSupplier(id, changes))) setEditing(null);
                          }}
                        >
                          {ar.save}
                        </button>
                        <button type="button" className="btn btn-small" onClick={() => setEditing(null)}>
                          {ar.cancel}
                        </button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr key={s.id} className={s.active ? undefined : "inactive"}>
                    <td>
                      {s.name}
                      {!s.active && <span className="chip chip-warn">{ar.purchases.stopped}</span>}
                    </td>
                    <td className="muted" dir="ltr">
                      {s.phone}
                    </td>
                    <td className="muted" dir="ltr">
                      {s.taxRegistrationNumber}
                    </td>
                    <td className="muted">{s.currency}</td>
                    <td className="muted">{categoryName(s.withholdingCategoryId)}</td>
                    {canSeeBalances && <td className="num">{balances[s.id] !== undefined && <Owed account={balances[s.id]!} />}</td>}
                    <td>
                      <div className="actions">
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() =>
                            setEditing({
                              id: s.id,
                              name: s.name,
                              phone: s.phone,
                              taxRegistrationNumber: s.taxRegistrationNumber,
                              currency: s.currency,
                              withholdingCategoryId: s.withholdingCategoryId,
                            })
                          }
                        >
                          {ar.edit}
                        </button>
                        {canSeeBalances &&
                          (s.active ? (
                            <button type="button" className="btn btn-small" onClick={() => run(business.deactivateSupplier(s.id))}>
                              {ar.purchases.stop}
                            </button>
                          ) : (
                            <button type="button" className="btn btn-small" onClick={() => run(business.reactivateSupplier(s.id))}>
                              {ar.purchases.restart}
                            </button>
                          ))}
                      </div>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

/** A supplier's balance: in EGP, or in their currency with what the books carry it at in EGP. */
function Owed({ account }: { account: SupplierAccount }) {
  if (account.currency === "EGP") return <>{formatMoney(account.owed)}</>;
  return (
    <>
      {account.currency} {formatMoney(account.owed)}
      <div className="muted small">{formatMoney(account.owedEgp)} ج.م</div>
    </>
  );
}
