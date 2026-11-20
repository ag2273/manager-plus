import { useState, type FormEvent } from "react";
import type { SerialHistory } from "../../../core/serials";
import type { Warehouse } from "../../../core/stock";
import { business, errorText, today } from "../api";
import { ar } from "../strings";

/** Serials typed or scanned one per line (commas work too), without blanks. */
export function splitSerials(text: string): string[] {
  return text
    .split(/[\n,،]+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** A box for a serialised line's serials; it reports the count so the quantity can follow it. */
export function SerialsField({ name, value, onChange }: { name: string; value: string; onChange: (text: string, count: number) => void }) {
  return (
    <label className="field serials-field">
      {ar.serials.lineLabel(name)}
      <textarea dir="ltr" rows={2} value={value} placeholder={ar.serials.label} onChange={(e) => onChange(e.target.value, splitSerials(e.target.value).length)} />
    </label>
  );
}

/** Looks a serial up: the item, where it came from, who bought it, and its warranty today. */
export function SerialLookup({ warehouses }: { warehouses: Warehouse[] }) {
  const [serial, setSerial] = useState("");
  const [found, setFound] = useState<SerialHistory[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function find(event: FormEvent) {
    event.preventDefault();
    if (serial.trim() === "") return;
    const result = await business.findSerial(serial.trim(), today());
    setError(errorText(result));
    setFound(result.ok ? result.value : null);
  }

  const warehouseName = (id: number | null) => warehouses.find((w) => w.id === id)?.name ?? "";

  return (
    <section className="card" aria-label={ar.serials.lookup}>
      <form className="row" onSubmit={find}>
        <label className="field">
          {ar.serials.lookup}
          <input dir="ltr" placeholder={ar.serials.lookupHint} value={serial} onChange={(e) => setSerial(e.target.value)} />
        </label>
        <button type="submit" className="btn">
          {ar.serials.find}
        </button>
      </form>
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      {found && found.length === 0 && <p className="muted">{ar.serials.notFound}</p>}
      {found?.map((h) => (
        <dl key={`${h.itemId}-${h.serial}`} className="server-facts" aria-label={h.serial}>
          <dt>{ar.serials.item}</dt>
          <dd>
            {h.nameAr} · <span dir="ltr">{h.serial}</span>
          </dd>
          <dt>{ar.serials.status}</dt>
          <dd>{h.inStock ? ar.serials.inStock(warehouseName(h.warehouseId)) : h.sale ? ar.serials.sold : ar.serials.out}</dd>
          {h.purchase && (
            <>
              <dt>{ar.serials.purchase}</dt>
              <dd>
                {h.purchase.supplierName} · {h.purchase.date}
                {h.purchase.reference && ` · ${h.purchase.reference}`}
              </dd>
            </>
          )}
          {h.sale && (
            <>
              <dt>{ar.serials.sale}</dt>
              <dd>
                {h.sale.document} · {h.sale.date}
                {h.sale.customerName && ` · ${h.sale.customerName}`}
              </dd>
              <dt>{ar.serials.warranty}</dt>
              <dd className={h.underWarranty ? "ok-text" : "warn-text"}>
                {h.warrantyEnds ? ar.serials.warrantyUntil(h.warrantyEnds, h.underWarranty) : ar.serials.noWarranty}
              </dd>
            </>
          )}
        </dl>
      ))}
    </section>
  );
}
