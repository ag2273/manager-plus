import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Item } from "../../../core/items";
import type { SerialLine, Transfer, UnitLine, Warehouse } from "../../../core/stock";
import type { Result } from "../../../shared/api";
import { formatQuantity, parseQuantity } from "../../../shared/quantity";
import { business, errorText, today } from "../api";
import { ar } from "../strings";
import { SerialsField, splitSerials } from "./Serials";

type Tab = "list" | "transfer" | "history";

/** Warehouses on this site, moving stock between them, and past transfers. */
export function Warehouses({ canChange }: { canChange: boolean }) {
  const [tab, setTab] = useState<Tab>(canChange ? "list" : "history");
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);

  const reload = useCallback(async () => {
    const result = await business.warehouses();
    if (result.ok) setWarehouses(result.value);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const tabs: Tab[] = canChange ? ["list", "transfer", "history"] : ["history"];

  return (
    <>
      <header className="screen-head">
        <div>
          <h1>{ar.warehouses.title}</h1>
          <span className="muted">{ar.warehouses.hint}</span>
        </div>
      </header>
      <div role="tablist" aria-label={ar.warehouses.title} className="pills">
        {tabs.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={t === tab} className="pill" onClick={() => setTab(t)}>
            {ar.warehouses.tabs[t]}
          </button>
        ))}
      </div>
      {tab === "list" && <WarehouseList warehouses={warehouses} onChange={reload} />}
      {tab === "transfer" && <TransferForm warehouses={warehouses.filter((w) => w.active)} />}
      {tab === "history" && <TransferHistory warehouses={warehouses} />}
    </>
  );
}

function WarehouseList({ warehouses, onChange }: { warehouses: Warehouse[]; onChange: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(work: Promise<Result<unknown>>): Promise<boolean> {
    const result = await work;
    setError(errorText(result));
    if (result.ok) await onChange();
    return result.ok;
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (await run(business.addWarehouse(name))) setName("");
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
          {ar.warehouses.name}
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button type="submit" className="btn btn-primary">
          {ar.warehouses.add}
        </button>
      </form>
      <section className="table-card" aria-label={ar.warehouses.tabs.list}>
        <table>
          <thead>
            <tr>
              <th>{ar.warehouses.name}</th>
              <th className="col-actions" />
            </tr>
          </thead>
          <tbody>
            {warehouses.map((w) => (
              <tr key={w.id} className={w.active ? undefined : "inactive"}>
                <td>
                  {editing?.id === w.id ? (
                    <input
                      aria-label={ar.warehouses.name}
                      value={editing.name}
                      onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    />
                  ) : (
                    <>
                      {w.name}
                      {!w.active && <span className="chip chip-warn">{ar.warehouses.stopped}</span>}
                    </>
                  )}
                </td>
                <td>
                  <div className="actions">
                    {editing?.id === w.id ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-small btn-primary"
                          onClick={async () => {
                            if (await run(business.renameWarehouse(w.id, editing.name))) setEditing(null);
                          }}
                        >
                          {ar.save}
                        </button>
                        <button type="button" className="btn btn-small" onClick={() => setEditing(null)}>
                          {ar.cancel}
                        </button>
                      </>
                    ) : (
                      <button type="button" className="btn btn-small" onClick={() => setEditing({ id: w.id, name: w.name })}>
                        {ar.edit}
                      </button>
                    )}
                    {w.active ? (
                      <button type="button" className="btn btn-small" onClick={() => run(business.deactivateWarehouse(w.id))}>
                        {ar.warehouses.stop}
                      </button>
                    ) : (
                      <button type="button" className="btn btn-small" onClick={() => run(business.reactivateWarehouse(w.id))}>
                        {ar.warehouses.restart}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

type DraftLine = { itemId: number | ""; unit: "base" | "pack"; quantity: string; serials: string };
const emptyLine = (): DraftLine => ({ itemId: "", unit: "base", quantity: "", serials: "" });

function TransferForm({ warehouses }: { warehouses: Warehouse[] }) {
  const [items, setItems] = useState<Item[]>([]);
  const [date, setDate] = useState(today());
  const [from, setFrom] = useState<number | "">(warehouses[0]?.id ?? "");
  const [to, setTo] = useState<number | "">(warehouses[1]?.id ?? "");
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [available, setAvailable] = useState<Record<number, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    void business.items().then((r) => r.ok && setItems(r.value));
  }, []);

  // What the source warehouse holds of each picked item, for the "available" column.
  useEffect(() => {
    if (from === "") return;
    const ids = [...new Set(lines.map((l) => l.itemId).filter((id): id is number => id !== ""))];
    void Promise.all(ids.map((id) => business.stockOnHand(id))).then((results) => {
      const next: Record<number, number> = {};
      results.forEach((r, i) => {
        if (r.ok) next[ids[i]!] = r.value.byWarehouse.find((w) => w.warehouseId === from)?.quantity ?? 0;
      });
      setAvailable(next);
    });
  }, [from, lines, done]);

  function setLine(index: number, change: Partial<DraftLine>) {
    setLines(lines.map((l, i) => (i === index ? { ...l, ...change } : l)));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setDone(null);
    const out: (UnitLine & SerialLine)[] = [];
    for (const l of lines) {
      if (l.itemId === "" && l.quantity.trim() === "") continue;
      const quantity = parseQuantity(l.quantity);
      if (l.itemId === "" || quantity === null || quantity === 0) {
        setError(ar.errors["quantity_invalid"]!);
        return;
      }
      const serials = splitSerials(l.serials);
      out.push({ itemId: l.itemId, unit: l.unit, quantity, ...(serials.length > 0 ? { serials } : {}) });
    }
    if (from === "" || to === "") {
      setError(ar.errors["transfer_same_warehouse"]!);
      return;
    }
    const result = await business.transferStock({ date, from, to, memo, lines: out });
    setError(errorText(result));
    if (result.ok) {
      setDone(ar.warehouses.done);
      setLines([emptyLine()]);
      setMemo("");
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
        <label className="field narrow">
          {ar.warehouses.from}
          <select value={from} onChange={(e) => setFrom(Number(e.target.value))}>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field narrow">
          {ar.warehouses.to}
          <select value={to} onChange={(e) => setTo(Number(e.target.value))}>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
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
            <th>{ar.warehouses.item}</th>
            <th className="col-type">{ar.warehouses.unit}</th>
            <th className="col-money">{ar.warehouses.quantity}</th>
            <th className="col-money">{ar.warehouses.available}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const item = items.find((it) => it.id === l.itemId);
            return [
              <tr key={i}>
                <td>
                  <select
                    aria-label={ar.warehouses.item}
                    value={l.itemId}
                    onChange={(e) => setLine(i, { itemId: e.target.value === "" ? "" : Number(e.target.value), unit: "base" })}
                  >
                    <option value="">{ar.warehouses.pickItem}</option>
                    {items.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.nameAr}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select aria-label={ar.warehouses.unit} value={l.unit} onChange={(e) => setLine(i, { unit: e.target.value as "base" | "pack" })}>
                    <option value="base">{item?.baseUnit ?? "—"}</option>
                    {item?.pack && <option value="pack">{item.pack.name}</option>}
                  </select>
                </td>
                <td>
                  <input aria-label={ar.warehouses.quantity} dir="ltr" inputMode="decimal" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
                </td>
                <td className="num muted">
                  {l.itemId !== "" && available[l.itemId] !== undefined && `${formatQuantity(available[l.itemId]!)} ${item?.baseUnit ?? ""}`}
                </td>
              </tr>,
              item?.serialised && (
                <tr key={`${i}-serials`}>
                  <td colSpan={4}>
                    <SerialsField name={item.nameAr} value={l.serials} onChange={(serials, count) => setLine(i, { serials, unit: "base", quantity: String(count) })} />
                  </td>
                </tr>
              ),
            ];
          })}
        </tbody>
      </table>
      <div className="row">
        <button type="button" className="btn btn-small" onClick={() => setLines([...lines, emptyLine()])}>
          {ar.warehouses.addLine}
        </button>
      </div>
      <div className="row">
        <button type="submit" className="btn btn-primary">
          {ar.warehouses.submit}
        </button>
      </div>
    </form>
  );
}

function TransferHistory({ warehouses }: { warehouses: Warehouse[] }) {
  const [transfers, setTransfers] = useState<Transfer[]>([]);

  useEffect(() => {
    void business.transfers().then((r) => r.ok && setTransfers(r.value));
  }, []);

  const name = (id: number) => warehouses.find((w) => w.id === id)?.name ?? "";

  return (
    <section className="table-card" aria-label={ar.warehouses.tabs.history}>
      {transfers.length === 0 ? (
        <p className="muted empty">{ar.warehouses.none}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th className="col-type">{ar.warehouses.date}</th>
              <th>{ar.warehouses.from}</th>
              <th>{ar.warehouses.to}</th>
              <th className="col-type">{ar.warehouses.items}</th>
              <th>{ar.warehouses.memo}</th>
            </tr>
          </thead>
          <tbody>
            {transfers.map((t) => (
              <tr key={t.id}>
                <td className="muted">{t.date}</td>
                <td>{name(t.from)}</td>
                <td>{name(t.to)}</td>
                <td>{t.lines.length}</td>
                <td className="muted">{t.memo}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
