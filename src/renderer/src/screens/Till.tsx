import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Account } from "../../../core/ledger";
import type { Shift, ZReport } from "../../../core/shifts";
import type { Item } from "../../../core/items";
import type { CashSaleResult, PricedSale } from "../../../core/sales";
import type { Warehouse } from "../../../core/stock";
import { formatMoney, parseMoney } from "../../../shared/money";
import { formatQuantity, parseQuantity } from "../../../shared/quantity";
import { business, errorText, today } from "../api";
import { ar } from "../strings";

type CartLine = { itemId: number; unit: "base" | "pack"; name: string; barcode: string; quantity: string };

/** Keystrokes closer together than this are a scanner, not a person. */
const SCANNER_GAP_MS = 40;
const MIN_BARCODE = 4;
/** No one types a quantity this long: it is a barcode scanned into the wrong field. */
const BARCODE = /^\d{8,}$/;

/**
 * The till. Everything works from the keyboard: type or scan into the search box,
 * Enter adds; F12 goes to payment; Enter there completes the sale; Esc clears.
 */
function Sale({ onCash, onClose }: { onCash: () => void; onClose: () => void }) {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState<number | "">("");
  const [lines, setLines] = useState<CartLine[]>([]);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Item[]>([]);
  const [priced, setPriced] = useState<PricedSale | null>(null);
  const [cash, setCash] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<(CashSaleResult & { names: string[] }) | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const pay = useRef<HTMLInputElement>(null);
  const scan = useRef({ buffer: "", at: 0 });
  const editing = useRef("");

  useEffect(() => {
    void business.warehouses().then((r) => {
      if (!r.ok) return;
      const active = r.value.filter((w) => w.active);
      setWarehouses(active);
      setWarehouseId(active[0]?.id ?? "");
    });
    search.current?.focus();
  }, []);

  // Totals come from the core: the screen never computes money or VAT.
  useEffect(() => {
    const complete = lines.flatMap((l) => {
      const quantity = parseQuantity(l.quantity);
      return quantity !== null && quantity > 0 ? [{ itemId: l.itemId, unit: l.unit, quantity }] : [];
    });
    if (complete.length === 0 || complete.length !== lines.length) {
      setPriced(null);
      return;
    }
    let stale = false;
    void business.priceSale(today(), complete).then((r) => {
      if (!stale) setPriced(r.ok ? r.value : null);
    });
    return () => {
      stale = true;
    };
  }, [lines]);

  function addUnit(unit: { itemId: number; unit: "base" | "pack"; name: string; barcode: string }) {
    setLast(null);
    setError(null);
    setLines((current) => {
      const at = current.findIndex((l) => l.itemId === unit.itemId && l.unit === unit.unit);
      if (at === -1) return [...current, { ...unit, quantity: "1" }];
      return current.map((l, i) => (i === at ? { ...l, quantity: String((parseQuantity(l.quantity) ?? 0) / 1000 + 1) } : l));
    });
  }

  async function addBarcode(code: string): Promise<boolean> {
    const result = await business.findByBarcode(code);
    if (!result.ok || !result.value) return false;
    const u = result.value;
    addUnit({ itemId: u.itemId, unit: u.unit, name: u.unit === "pack" ? `${u.nameAr} · ${u.unitName}` : u.nameAr, barcode: code });
    return true;
  }

  async function submitSearch() {
    const text = query.trim();
    if (text === "") {
      if (lines.length > 0) pay.current?.focus();
      return;
    }
    if (await addBarcode(text)) {
      setQuery("");
      setMatches([]);
      return;
    }
    const found = await business.items({ search: text });
    const items = found.ok ? found.value : [];
    if (items.length === 1) {
      pickItem(items[0]!);
    } else {
      setMatches(items);
      if (items.length === 0) setError(ar.till.notFound);
    }
  }

  function pickItem(item: Item) {
    addUnit({ itemId: item.id, unit: "base", name: item.nameAr, barcode: item.barcode ?? "" });
    setQuery("");
    setMatches([]);
    search.current?.focus();
  }

  function clearSale() {
    setLines([]);
    setCash("");
    setQuery("");
    setMatches([]);
    setError(null);
    search.current?.focus();
  }

  async function complete() {
    if (warehouseId === "" || lines.length === 0 || !priced) return;
    const received = cash.trim() === "" ? priced.total : parseMoney(cash);
    if (received === null) {
      setError(ar.errors["price_invalid"]!);
      return;
    }
    const result = await business.postCashSale({
      date: today(),
      warehouseId,
      cashReceived: received,
      lines: lines.map((l) => ({ itemId: l.itemId, unit: l.unit, quantity: parseQuantity(l.quantity) ?? 0 })),
    });
    setError(errorText(result));
    if (result.ok) {
      const names = result.value.belowZero.map((id) => lines.find((l) => l.itemId === id)?.name ?? "");
      setLast({ ...result.value, names });
      setLines([]);
      setCash("");
      search.current?.focus();
    }
  }

  // Function keys anywhere on the till, and scanner bursts typed outside the search box.
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "F2") {
      event.preventDefault();
      search.current?.focus();
    } else if (event.key === "F12") {
      event.preventDefault();
      pay.current?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      clearSale();
    } else if (event.key === "F10") {
      event.preventDefault();
      onClose();
    } else if (event.target !== search.current && event.target !== pay.current) {
      const now = Date.now();
      const s = scan.current;
      if (now - s.at > SCANNER_GAP_MS) s.buffer = "";
      s.at = now;
      if (event.key === "Enter" && s.buffer.length >= MIN_BARCODE) {
        event.preventDefault();
        const code = s.buffer;
        s.buffer = "";
        // The burst also typed into whatever field had focus; put that field back.
        if (event.target instanceof HTMLInputElement) event.target.blur();
        void addBarcode(code).then((ok) => !ok && setError(ar.till.notFound));
      } else if (event.key.length === 1) {
        s.buffer += event.key;
      }
    }
  }

  const count = lines.reduce((t, l) => t + (parseQuantity(l.quantity) ?? 0), 0);

  return (
    <div className="till" onKeyDown={onKeyDown}>
      <header className="screen-head">
        <div>
          <h1>{ar.till.title}</h1>
          <span className="muted">{ar.till.keys}</span>
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={onCash}>
            {ar.shift.cashInOut}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {ar.shift.close}
          </button>
        </div>
        {warehouses.length > 1 && (
          <label className="field narrow">
            {ar.till.warehouse}
            <select value={warehouseId} onChange={(e) => setWarehouseId(Number(e.target.value))}>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>
      <div className="till-grid">
        <section className="card till-cart">
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void submitSearch();
            }}
          >
            <label className="field">
              {ar.till.search}
              <input
                ref={search}
                className="till-search"
                value={query}
                autoComplete="off"
                placeholder={ar.till.searchHint}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown" && matches.length > 0) {
                    e.preventDefault();
                    document.querySelector<HTMLButtonElement>(".till-matches button")?.focus();
                  }
                }}
              />
            </label>
          </form>
          {matches.length > 0 && (
            <ul className="till-matches" aria-label={ar.till.matches}>
              {matches.slice(0, 8).map((m, i) => (
                <li key={m.id}>
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => pickItem(m)}
                    onKeyDown={(e) => {
                      const buttons = document.querySelectorAll<HTMLButtonElement>(".till-matches button");
                      if (e.key === "ArrowDown") buttons[i + 1]?.focus();
                      if (e.key === "ArrowUp") (i === 0 ? search.current : buttons[i - 1])?.focus();
                    }}
                  >
                    {m.nameAr} · {formatMoney(m.salePrice)}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {error && (
            <div role="alert" className="error">
              {error}
            </div>
          )}
          {last && (
            <div role="status" className="ok">
              {ar.till.done(last.number, formatMoney(last.change))}
              {last.names.length > 0 && <div className="warn-text">{ar.till.belowZero(last.names.join("، "))}</div>}
            </div>
          )}
          <table className="lines">
            <thead>
              <tr>
                <th className="col-remove">#</th>
                <th>{ar.till.item}</th>
                <th className="col-type">{ar.till.quantity}</th>
                <th className="col-money">{ar.till.price}</th>
                <th className="col-money">{ar.till.lineTotal}</th>
                <th className="col-remove" />
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted empty">
                    {ar.till.empty}
                  </td>
                </tr>
              )}
              {lines.map((l, i) => {
                const row = priced?.lines[i];
                return (
                  <tr key={`${l.itemId}-${l.unit}`}>
                    <td className="muted">{i + 1}</td>
                    <td>
                      <div className="stack">
                        <span className="strong">{l.name}</span>
                        <span className="muted small" dir="ltr">
                          {l.barcode}
                        </span>
                      </div>
                    </td>
                    <td>
                      <input
                        aria-label={`${ar.till.quantity} ${l.name}`}
                        dir="ltr"
                        inputMode="decimal"
                        value={l.quantity}
                        onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))}
                        onFocus={(e) => {
                          editing.current = e.currentTarget.value;
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") return;
                          e.preventDefault();
                          e.stopPropagation();
                          // A scan while the cursor sits here types the barcode into the quantity.
                          const value = e.currentTarget.value;
                          const typed = value.startsWith(editing.current) ? value.slice(editing.current.length) : value;
                          if (BARCODE.test(typed)) {
                            const before = editing.current;
                            setLines((current) => current.map((x, j) => (j === i ? { ...x, quantity: before } : x)));
                            void addBarcode(typed).then((ok) => !ok && setError(ar.till.notFound));
                          }
                          search.current?.focus();
                        }}
                      />
                    </td>
                    <td className="num">{row && formatMoney(row.unitPrice)}</td>
                    <td className="num strong">{row && formatMoney(row.gross)}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-small"
                        aria-label={`${ar.till.remove} ${l.name}`}
                        onClick={() => setLines(lines.filter((_, j) => j !== i))}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <span className="muted small">{ar.till.count(lines.length, formatQuantity(count))}</span>
        </section>
        <aside className="card till-pay" aria-label={ar.till.payment}>
          <div className="till-sum">
            <span className="muted">{ar.till.vatIncluded}</span>
            <span className="num">{priced ? formatMoney(priced.vat) : "—"}</span>
          </div>
          <div className="till-total">
            <span>{ar.till.due}</span>
            <span className="num">{priced ? formatMoney(priced.total) : "0.00"}</span>
          </div>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void complete();
            }}
          >
            <label className="field">
              {ar.till.cash}
              <input
                ref={pay}
                className="till-cash"
                dir="ltr"
                inputMode="decimal"
                value={cash}
                placeholder={priced ? formatMoney(priced.total) : ""}
                onChange={(e) => setCash(e.target.value)}
              />
            </label>
            <button type="submit" className="btn btn-primary till-complete" disabled={!priced}>
              {ar.till.complete}
            </button>
          </form>
          <button type="button" className="btn" onClick={clearSale}>
            {ar.till.clear}
          </button>
        </aside>
      </div>
    </div>
  );
}

type Panel = "sale" | "cash" | "close";

/** The till for the signed-in user: open a shift, sell, move cash, close with a Z report. */
export function Till() {
  const [shift, setShift] = useState<Shift | null | undefined>(undefined);
  const [panel, setPanel] = useState<Panel>("sale");
  const [z, setZ] = useState<ZReport | null>(null);

  const reload = useCallback(async () => {
    const result = await business.currentShift();
    setShift(result.ok ? result.value : null);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (shift === undefined) return null;
  if (z) return <ZReportView report={z} onDone={() => setZ(null)} />;
  if (shift === null) return <OpenShift onOpened={reload} />;
  if (panel === "cash") return <CashPanel onDone={() => setPanel("sale")} />;
  if (panel === "close")
    return (
      <ClosePanel
        onCancel={() => setPanel("sale")}
        onClosed={(report) => {
          setZ(report);
          setPanel("sale");
          void reload();
        }}
      />
    );
  return <Sale onCash={() => setPanel("cash")} onClose={() => setPanel("close")} />;
}

function OpenShift({ onOpened }: { onOpened: () => Promise<void> }) {
  const [float, setFloat] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const amount = float.trim() === "" ? 0 : parseMoney(float);
    if (amount === null) {
      setError(ar.errors["line_amount_invalid"]!);
      return;
    }
    const result = await business.openShift(amount);
    setError(errorText(result));
    if (result.ok) await onOpened();
  }

  return (
    <>
      <header className="screen-head">
        <div>
          <h1>{ar.till.title}</h1>
          <span className="muted">{ar.shift.noShift}</span>
        </div>
      </header>
      <form className="card shift-card" onSubmit={submit}>
        <h2>{ar.shift.open}</h2>
        {error && (
          <div role="alert" className="error">
            {error}
          </div>
        )}
        <label className="field">
          {ar.shift.float}
          <input autoFocus dir="ltr" inputMode="decimal" value={float} placeholder="0.00" onChange={(e) => setFloat(e.target.value)} />
        </label>
        <button type="submit" className="btn btn-primary">
          {ar.shift.open}
        </button>
      </form>
    </>
  );
}

function CashPanel({ onDone }: { onDone: () => void }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [direction, setDirection] = useState<"in" | "out">("out");
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState<number | "">("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void business.accounts().then((r) => r.ok && setAccounts(r.value.filter((a) => a.active && a.role !== "cash_drawer")));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = parseMoney(amount);
    if (value === null || value <= 0) {
      setError(ar.errors["line_amount_invalid"]!);
      return;
    }
    if (accountId === "") {
      setError(ar.errors["account_not_found"]!);
      return;
    }
    const result = await business.cashInOut({ date: today(), direction, amount: value, accountId, reason });
    setError(errorText(result));
    if (result.ok) onDone();
  }

  return (
    <>
      <header className="screen-head">
        <h1>{ar.shift.cashInOut}</h1>
      </header>
      <form className="card shift-card" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && onDone()}>
        {error && (
          <div role="alert" className="error">
            {error}
          </div>
        )}
        <div role="radiogroup" aria-label={ar.shift.direction} className="pills">
          {(["out", "in"] as const).map((d) => (
            <button key={d} type="button" role="radio" aria-checked={d === direction} className="pill" onClick={() => setDirection(d)}>
              {ar.shift.directions[d]}
            </button>
          ))}
        </div>
        <label className="field">
          {ar.shift.amount}
          <input autoFocus dir="ltr" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="field">
          {direction === "out" ? ar.shift.toAccount : ar.shift.fromAccount}
          <select value={accountId} onChange={(e) => setAccountId(e.target.value === "" ? "" : Number(e.target.value))}>
            <option value="">{ar.shift.pickAccount}</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} · {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {ar.shift.reason}
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <div className="row">
          <button type="submit" className="btn btn-primary">
            {ar.save}
          </button>
          <button type="button" className="btn" onClick={onDone}>
            {ar.cancel}
          </button>
        </div>
      </form>
    </>
  );
}

function ClosePanel({ onCancel, onClosed }: { onCancel: () => void; onClosed: (report: ZReport) => void }) {
  const [counted, setCounted] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = parseMoney(counted);
    if (value === null || value < 0) {
      setError(ar.errors["line_amount_invalid"]!);
      return;
    }
    const result = await business.closeShift({ date: today(), countedCash: value });
    setError(errorText(result));
    if (result.ok) onClosed(result.value);
  }

  return (
    <>
      <header className="screen-head">
        <div>
          <h1>{ar.shift.close}</h1>
          <span className="muted">{ar.shift.closeHint}</span>
        </div>
      </header>
      <form className="card shift-card" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && onCancel()}>
        {error && (
          <div role="alert" className="error">
            {error}
          </div>
        )}
        <label className="field">
          {ar.shift.counted}
          <input autoFocus dir="ltr" inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} />
        </label>
        <div className="row">
          <button type="submit" className="btn btn-primary">
            {ar.shift.closeNow}
          </button>
          <button type="button" className="btn" onClick={onCancel}>
            {ar.cancel}
          </button>
        </div>
      </form>
    </>
  );
}

function ZReportView({ report, onDone }: { report: ZReport; onDone: () => void }) {
  const rows: [string, number | null][] = [
    [ar.shift.z.receipts, null],
    [ar.shift.z.salesCash, report.sales.byMethod.cash],
    [ar.shift.z.net, report.sales.net],
    [ar.shift.z.vat, report.sales.vat],
    [ar.shift.z.returns, report.returns],
    [ar.shift.z.discounts, report.discounts],
    [ar.shift.z.float, report.openingFloat],
    [ar.shift.z.cashIn, report.cashIn],
    [ar.shift.z.cashOut, report.cashOut],
    [ar.shift.z.expected, report.expectedCash],
    [ar.shift.z.counted, report.countedCash],
    [ar.shift.z.difference, report.difference],
  ];
  return (
    <>
      <header className="screen-head">
        <div>
          <h1>{ar.shift.z.title}</h1>
          <span className="muted">
            {report.shift.userName} · {new Date(report.shift.openedAt).toLocaleString("ar-EG")}
          </span>
        </div>
      </header>
      <section className="table-card z-report" aria-label={ar.shift.z.title}>
        <table>
          <tbody>
            {rows.map(([label, value], i) => (
              <tr key={label} className={i === rows.length - 1 ? "z-total" : undefined}>
                <td>{label}</td>
                <td className="num">{i === 0 ? report.receipts : value === null ? "—" : formatMoney(value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <div className="row">
        <button type="button" className="btn btn-primary" autoFocus onClick={onDone}>
          {ar.shift.z.done}
        </button>
      </div>
    </>
  );
}
