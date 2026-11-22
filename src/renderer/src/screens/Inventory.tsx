import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ItemMovement, LowStockRow, StockCount, WriteOff } from "../../../core/inventory";
import type { Item } from "../../../core/items";
import type { Warehouse } from "../../../core/stock";
import { formatMoney } from "../../../shared/money";
import { formatQuantity, parseQuantity } from "../../../shared/quantity";
import { business, errorText, today } from "../api";
import { ar } from "../strings";
import { SerialsField, splitSerials } from "./Serials";


function Notice({ error, done }: { error: string | null; done?: string | null }) {
  return (
    <>
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
    </>
  );
}

function useItems(): Item[] {
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => {
    void business.items().then((r) => r.ok && setItems(r.value));
  }, []);
  return items;
}

function WarehouseSelect({
  warehouses,
  value,
  onChange,
  all,
}: {
  warehouses: Warehouse[];
  value: number | "";
  onChange: (id: number | "") => void;
  all?: boolean;
}) {
  return (
    <label className="field narrow">
      {ar.inventory.warehouse}
      <select value={value} onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}>
        {all && <option value="">{ar.inventory.allWarehouses}</option>}
        {warehouses.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function ItemSelect({
  items,
  value,
  onChange,
  label = ar.inventory.item,
}: {
  items: Item[];
  value: number | "";
  onChange: (id: number | "") => void;
  label?: string;
}) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}>
      <option value="">{ar.warehouses.pickItem}</option>
      {items.map((i) => (
        <option key={i.id} value={i.id}>
          {i.nameAr}
        </option>
      ))}
    </select>
  );
}

/** A stock count for one warehouse: the quantity found per item; differences post as gain or loss. */
export function CountForm({ warehouses }: { warehouses: Warehouse[] }) {
  const items = useItems();
  const [warehouseId, setWarehouseId] = useState<number | "">(warehouses[0]?.id ?? "");
  const [date, setDate] = useState(today());
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<{ itemId: number | ""; counted: string }[]>([{ itemId: "", counted: "" }]);
  const [counts, setCounts] = useState<StockCount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const r = await business.stockCounts();
    if (r.ok) setCounts(r.value);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setDone(null);
    const out: { itemId: number; counted: number }[] = [];
    for (const l of lines) {
      if (l.itemId === "" && l.counted.trim() === "") continue;
      const counted = parseQuantity(l.counted);
      if (l.itemId === "" || counted === null) {
        setError(ar.errors["quantity_invalid"]!);
        return;
      }
      out.push({ itemId: l.itemId, counted });
    }
    if (warehouseId === "") return;
    const result = await business.postStockCount({ date, warehouseId, memo, lines: out });
    setError(errorText(result));
    if (result.ok) {
      setDone(ar.inventory.countPosted);
      setLines([{ itemId: "", counted: "" }]);
      setMemo("");
      await reload();
    }
  }

  const name = (id: number) => warehouses.find((w) => w.id === id)?.name ?? "";
  return (
    <>
      <form className="card" onSubmit={submit} aria-label={ar.warehouses.tabs.count}>
        <Notice error={error} done={done} />
        <p className="muted small">{ar.inventory.countHint}</p>
        <div className="row">
          <WarehouseSelect warehouses={warehouses} value={warehouseId} onChange={setWarehouseId} />
          <label className="field narrow">
            {ar.warehouses.date}
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="field">
            {ar.warehouses.memo}
            <input value={memo} onChange={(e) => setMemo(e.target.value)} />
          </label>
        </div>
        <table className="lines">
          <thead>
            <tr>
              <th>{ar.inventory.item}</th>
              <th className="col-money">{ar.inventory.counted}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <ItemSelect items={items} value={l.itemId} onChange={(id) => setLines(lines.map((x, j) => (j === i ? { ...x, itemId: id } : x)))} />
                </td>
                <td>
                  <input
                    aria-label={ar.inventory.counted}
                    dir="ltr"
                    inputMode="decimal"
                    value={l.counted}
                    onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, counted: e.target.value } : x)))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row">
          <button type="button" className="btn btn-small" onClick={() => setLines([...lines, { itemId: "", counted: "" }])}>
            {ar.warehouses.addLine}
          </button>
          <button type="submit" className="btn btn-primary">
            {ar.inventory.postCount}
          </button>
        </div>
      </form>
      {counts.map((c) => (
        <section key={c.id} className="table-card" aria-label={ar.inventory.countTitle(c.id)}>
          <div className="row table-head">
            <strong>{ar.inventory.countTitle(c.id)}</strong>
            <span className="muted">
              {c.date} · {name(c.warehouseId)}
              {c.memo && ` · ${c.memo}`}
            </span>
          </div>
          <table>
            <thead>
              <tr>
                <th>{ar.inventory.item}</th>
                <th className="col-money">{ar.inventory.expected}</th>
                <th className="col-money">{ar.inventory.counted}</th>
                <th className="col-money">{ar.inventory.difference}</th>
                <th className="col-money">{ar.inventory.value}</th>
              </tr>
            </thead>
            <tbody>
              {c.lines.map((l) => (
                <tr key={l.itemId}>
                  <td>{l.nameAr}</td>
                  <td className="num">{formatQuantity(l.expected)}</td>
                  <td className="num">{formatQuantity(l.counted)}</td>
                  <td className={`num${l.difference < 0 ? " warn-text" : ""}`}>{formatQuantity(l.difference)}</td>
                  <td className="num">{l.value !== 0 && formatMoney(l.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </>
  );
}

/** Damaged or expired stock taken out of a warehouse, with a reason. */
export function WriteOffForm({ warehouses }: { warehouses: Warehouse[] }) {
  const items = useItems();
  const [warehouseId, setWarehouseId] = useState<number | "">(warehouses[0]?.id ?? "");
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState("");
  const [lines, setLines] = useState<{ itemId: number | ""; quantity: string; serials: string }[]>([{ itemId: "", quantity: "", serials: "" }]);
  const [writeOffs, setWriteOffs] = useState<WriteOff[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const r = await business.writeOffs();
    if (r.ok) setWriteOffs(r.value);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setDone(null);
    const out = [];
    for (const l of lines) {
      if (l.itemId === "" && l.quantity.trim() === "") continue;
      const quantity = parseQuantity(l.quantity);
      if (l.itemId === "" || quantity === null || quantity === 0) {
        setError(ar.errors["quantity_invalid"]!);
        return;
      }
      const serials = splitSerials(l.serials);
      out.push({ itemId: l.itemId, unit: "base" as const, quantity, ...(serials.length > 0 ? { serials } : {}) });
    }
    if (warehouseId === "") return;
    const result = await business.writeOffStock({ date, warehouseId, reason, lines: out });
    setError(errorText(result));
    if (result.ok) {
      setDone(ar.inventory.writtenOff);
      setLines([{ itemId: "", quantity: "", serials: "" }]);
      setReason("");
      await reload();
    }
  }

  const name = (id: number) => warehouses.find((w) => w.id === id)?.name ?? "";
  return (
    <>
      <form className="card" onSubmit={submit} aria-label={ar.warehouses.tabs.writeOff}>
        <Notice error={error} done={done} />
        <div className="row">
          <WarehouseSelect warehouses={warehouses} value={warehouseId} onChange={setWarehouseId} />
          <label className="field narrow">
            {ar.warehouses.date}
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="field">
            {ar.inventory.reason}
            <input value={reason} placeholder={ar.inventory.reasonHint} onChange={(e) => setReason(e.target.value)} />
          </label>
        </div>
        <table className="lines">
          <thead>
            <tr>
              <th>{ar.inventory.item}</th>
              <th className="col-money">{ar.inventory.quantity}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const item = items.find((x) => x.id === l.itemId);
              return (
                <tr key={i}>
                  <td>
                    <ItemSelect
                      items={items}
                      value={l.itemId}
                      onChange={(id) => setLines(lines.map((x, j) => (j === i ? { ...x, itemId: id } : x)))}
                    />
                    {item?.serialised && (
                      <SerialsField
                        name={item.nameAr}
                        value={l.serials}
                        onChange={(serials) => setLines(lines.map((x, j) => (j === i ? { ...x, serials } : x)))}
                      />
                    )}
                  </td>
                  <td>
                    <input
                      aria-label={ar.inventory.quantity}
                      dir="ltr"
                      inputMode="decimal"
                      value={l.quantity}
                      onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="row">
          <button type="button" className="btn btn-small" onClick={() => setLines([...lines, { itemId: "", quantity: "", serials: "" }])}>
            {ar.warehouses.addLine}
          </button>
          <button type="submit" className="btn btn-primary">
            {ar.inventory.postWriteOff}
          </button>
        </div>
      </form>
      <section className="table-card" aria-label={ar.inventory.writeOffs}>
        {writeOffs.length === 0 ? (
          <p className="muted empty">{ar.inventory.noWriteOffs}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th className="col-type">{ar.warehouses.date}</th>
                <th>{ar.inventory.reason}</th>
                <th>{ar.warehouses.items}</th>
                <th className="col-money">{ar.inventory.value}</th>
              </tr>
            </thead>
            <tbody>
              {writeOffs.map((w) => (
                <tr key={w.id}>
                  <td className="muted">{w.date}</td>
                  <td>
                    {w.reason}
                    <div className="muted small">{name(w.warehouseId)}</div>
                  </td>
                  <td>{w.lines.map((l) => `${l.nameAr} × ${formatQuantity(l.quantity)}`).join(ar.list)}</td>
                  <td className="num">{formatMoney(w.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

/** Items below their minimum, and the minimum per item. */
export function LowStockView({ warehouses, canChange }: { warehouses: Warehouse[]; canChange: boolean }) {
  const items = useItems();
  const [warehouseId, setWarehouseId] = useState<number | "">("");
  const [rows, setRows] = useState<LowStockRow[]>([]);
  const [itemId, setItemId] = useState<number | "">("");
  const [minimum, setMinimum] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const r = await business.lowStock(...(warehouseId === "" ? [] : [warehouseId]));
    if (r.ok) setRows(r.value);
  }, [warehouseId]);
  useEffect(() => {
    void reload();
  }, [reload]);

  async function save(event: FormEvent) {
    event.preventDefault();
    const value = minimum.trim() === "" ? null : parseQuantity(minimum);
    if (itemId === "" || (minimum.trim() !== "" && value === null)) {
      setError(ar.errors["quantity_invalid"]!);
      return;
    }
    const result = await business.setItemMinimum(itemId, value);
    setError(errorText(result));
    if (result.ok) {
      setMinimum("");
      await reload();
    }
  }

  const name = (id: number) => warehouses.find((w) => w.id === id)?.name ?? "";
  return (
    <>
      <Notice error={error} />
      {canChange && (
        <form className="card form-row" onSubmit={save} aria-label={ar.inventory.setMinimum}>
          <label className="field">
            {ar.inventory.item}
            <ItemSelect items={items} value={itemId} onChange={setItemId} />
          </label>
          <label className="field narrow">
            {ar.inventory.minimum}
            <input dir="ltr" inputMode="decimal" placeholder={ar.inventory.noMinimum} value={minimum} onChange={(e) => setMinimum(e.target.value)} />
          </label>
          <button type="submit" className="btn">
            {ar.inventory.setMinimum}
          </button>
        </form>
      )}
      <div className="card form-row">
        <WarehouseSelect warehouses={warehouses} value={warehouseId} onChange={setWarehouseId} all />
      </div>
      <section className="table-card" aria-label={ar.warehouses.tabs.low}>
        {rows.length === 0 ? (
          <p className="muted empty">{ar.inventory.noLow}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{ar.inventory.item}</th>
                <th className="col-money">{ar.inventory.minimum}</th>
                <th className="col-money">{ar.inventory.onHand}</th>
                <th>{ar.inventory.byWarehouse}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.itemId}>
                  <td>{r.nameAr}</td>
                  <td className="num">{formatQuantity(r.minQuantity)}</td>
                  <td className="num warn-text">{formatQuantity(r.onHand)}</td>
                  <td className="muted">{r.byWarehouse.map((w) => `${name(w.warehouseId)}: ${formatQuantity(w.quantity)}`).join(" · ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

/** One item's movements with a running balance, in all warehouses or one. */
export function MovementsView({ warehouses }: { warehouses: Warehouse[] }) {
  const items = useItems();
  const [itemId, setItemId] = useState<number | "">("");
  const [warehouseId, setWarehouseId] = useState<number | "">("");
  const [rows, setRows] = useState<ItemMovement[]>([]);

  useEffect(() => {
    if (itemId === "") return;
    void business.itemMovements(itemId, ...(warehouseId === "" ? [] : [warehouseId])).then((r) => r.ok && setRows(r.value));
  }, [itemId, warehouseId]);

  return (
    <>
      <div className="card form-row">
        <label className="field">
          {ar.inventory.item}
          <ItemSelect items={items} value={itemId} onChange={setItemId} />
        </label>
        <WarehouseSelect warehouses={warehouses} value={warehouseId} onChange={setWarehouseId} all />
      </div>
      {itemId !== "" && (
        <section className="table-card" aria-label={ar.warehouses.tabs.movements}>
          {rows.length === 0 ? (
            <p className="muted empty">{ar.inventory.noMovements}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th className="col-type">{ar.warehouses.date}</th>
                  <th>{ar.inventory.document}</th>
                  <th>{ar.inventory.warehouse}</th>
                  <th className="col-money">{ar.inventory.quantity}</th>
                  <th className="col-money">{ar.inventory.balance}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id}>
                    <td className="muted">{m.date}</td>
                    <td>
                      {ar.inventory.sources[m.source] ?? m.source} {m.sourceId}
                    </td>
                    <td>{m.warehouseName}</td>
                    <td className={`num${m.quantity < 0 ? " warn-text" : ""}`}>{m.quantity !== 0 && formatQuantity(m.quantity)}</td>
                    <td className="num">{formatQuantity(m.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </>
  );
}
