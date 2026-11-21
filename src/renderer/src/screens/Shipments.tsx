import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { PurchaseInvoice, Supplier } from "../../../core/purchases";
import type { ImportShipment, ShipmentCostKind, SpreadBy } from "../../../core/shipments";
import { formatMoney, parseMoney } from "../../../shared/money";
import { formatQuantity } from "../../../shared/quantity";
import { business, errorText, today } from "../api";
import { ar } from "../strings";

const KINDS: ShipmentCostKind[] = ["customs_duty", "freight", "clearance", "insurance", "other"];
type CostDraft = { kind: ShipmentCostKind; payeeId: number | ""; amount: string; vat: string };
const emptyCost = (kind: ShipmentCostKind = "customs_duty"): CostDraft => ({ kind, payeeId: "", amount: "", vat: "" });

/** Import shipments: supplier invoices plus customs, freight and clearance, spread into the items' cost. */
export function Shipments({ suppliers }: { suppliers: Supplier[] }) {
  const [invoices, setInvoices] = useState<PurchaseInvoice[]>([]);
  const [shipments, setShipments] = useState<ImportShipment[]>([]);
  const [date, setDate] = useState(today());
  const [reference, setReference] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [spreadBy, setSpreadBy] = useState<SpreadBy>("value");
  const [costs, setCosts] = useState<CostDraft[]>([emptyCost("customs_duty"), emptyCost("freight")]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [i, s] = await Promise.all([business.purchaseInvoices(), business.importShipments()]);
    if (i.ok) setInvoices(i.value);
    if (s.ok) setShipments(s.value);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const shipped = new Set(shipments.flatMap((s) => s.purchaseInvoiceIds));
  const open = invoices.filter((i) => !shipped.has(i.id));
  const payees = suppliers.filter((s) => s.active && s.currency === "EGP");
  const supplierName = (id: number) => suppliers.find((s) => s.id === id)?.name ?? "";
  const setCost = (index: number, change: Partial<CostDraft>) => setCosts(costs.map((c, i) => (i === index ? { ...c, ...change } : c)));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setDone(null);
    const lines = [];
    for (const c of costs) {
      if (c.payeeId === "" && c.amount.trim() === "" && c.vat.trim() === "") continue;
      const amount = c.amount.trim() === "" ? 0 : parseMoney(c.amount);
      const vat = c.vat.trim() === "" ? 0 : parseMoney(c.vat);
      if (amount === null || vat === null) {
        setError(ar.errors["amount_invalid"]!);
        return;
      }
      if (c.payeeId === "") {
        setError(ar.errors["supplier_not_found"]!);
        return;
      }
      lines.push({ kind: c.kind, payeeId: c.payeeId, amount, vat });
    }
    const result = await business.postImportShipment({ date, reference, purchaseInvoiceIds: [...picked], spreadBy, costs: lines });
    setError(errorText(result));
    if (result.ok) {
      setDone(ar.shipments.posted);
      setPicked(new Set());
      setReference("");
      setCosts([emptyCost("customs_duty"), emptyCost("freight")]);
      await reload();
    }
  }

  return (
    <>
      <form className="card" onSubmit={submit} aria-label={ar.shipments.new}>
        <p className="muted small">{ar.shipments.hint}</p>
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
          <label className="field narrow">
            {ar.shipments.date}
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="field">
            {ar.shipments.reference}
            <input dir="ltr" value={reference} onChange={(e) => setReference(e.target.value)} />
          </label>
          <label className="field narrow">
            {ar.shipments.spreadBy}
            <select value={spreadBy} onChange={(e) => setSpreadBy(e.target.value as SpreadBy)}>
              <option value="value">{ar.shipments.byValue}</option>
              <option value="quantity">{ar.shipments.byQuantity}</option>
            </select>
          </label>
        </div>
        <fieldset className="stack" aria-label={ar.shipments.invoices}>
          <legend className="small strong">{ar.shipments.invoices}</legend>
          {open.length === 0 && <p className="muted">{ar.shipments.noInvoices}</p>}
          {open.map((inv) => (
            <label key={inv.id} className="check">
              <input
                type="checkbox"
                checked={picked.has(inv.id)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(inv.id);
                  else next.delete(inv.id);
                  setPicked(next);
                }}
              />
              {inv.date} · {supplierName(inv.supplierId)}
              {inv.reference && ` · ${inv.reference}`} · {inv.currency !== "EGP" && `${inv.currency} `}
              {formatMoney(inv.total)}
            </label>
          ))}
        </fieldset>
        <table className="lines">
          <thead>
            <tr>
              <th className="col-type">{ar.shipments.kind}</th>
              <th>{ar.shipments.payee}</th>
              <th className="col-money">{ar.shipments.amount}</th>
              <th className="col-money">{ar.shipments.vat}</th>
            </tr>
          </thead>
          <tbody>
            {costs.map((c, i) => (
              <tr key={i}>
                <td>
                  <select aria-label={ar.shipments.kind} value={c.kind} onChange={(e) => setCost(i, { kind: e.target.value as ShipmentCostKind })}>
                    {KINDS.map((k) => (
                      <option key={k} value={k}>
                        {ar.shipments.kinds[k]}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    aria-label={`${ar.shipments.payee} ${ar.shipments.kinds[c.kind]}`}
                    value={c.payeeId}
                    onChange={(e) => setCost(i, { payeeId: e.target.value === "" ? "" : Number(e.target.value) })}
                  >
                    <option value="">{ar.shipments.pickPayee}</option>
                    {payees.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    aria-label={`${ar.shipments.amount} ${ar.shipments.kinds[c.kind]}`}
                    dir="ltr"
                    inputMode="decimal"
                    value={c.amount}
                    onChange={(e) => setCost(i, { amount: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    aria-label={`${ar.shipments.vat} ${ar.shipments.kinds[c.kind]}`}
                    dir="ltr"
                    inputMode="decimal"
                    value={c.vat}
                    onChange={(e) => setCost(i, { vat: e.target.value })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row">
          <button type="button" className="btn btn-small" onClick={() => setCosts([...costs, emptyCost("other")])}>
            {ar.shipments.addCost}
          </button>
        </div>
        <div className="row">
          <button type="submit" className="btn btn-primary">
            {ar.shipments.post}
          </button>
        </div>
      </form>
      {shipments.map((s) => (
        <section key={s.id} className="table-card" aria-label={ar.shipments.title(s.number)}>
          <div className="row table-head">
            <strong>{ar.shipments.title(s.number)}</strong>
            <span className="muted">
              {s.date}
              {s.reference && ` · ${s.reference}`} · {ar.shipments.summary(formatMoney(s.goods), formatMoney(s.costs), formatMoney(s.vat))}
            </span>
          </div>
          <table>
            <thead>
              <tr>
                <th>{ar.shipments.item}</th>
                <th className="col-money">{ar.shipments.quantity}</th>
                <th className="col-money">{ar.shipments.goods}</th>
                <th className="col-money">{ar.shipments.allocated}</th>
                <th className="col-money">{ar.shipments.landedUnitCost}</th>
              </tr>
            </thead>
            <tbody>
              {s.lines.map((l, i) => (
                <tr key={i}>
                  <td>
                    {l.nameAr}
                    {l.toCostOfSales > 0 && <div className="muted small">{ar.shipments.toCostOfSales(formatMoney(l.toCostOfSales))}</div>}
                  </td>
                  <td className="num">{formatQuantity(l.quantity)}</td>
                  <td className="num">{formatMoney(l.goods)}</td>
                  <td className="num">{formatMoney(l.allocated)}</td>
                  <td className="num strong">{formatMoney(l.landedUnitCost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </>
  );
}
