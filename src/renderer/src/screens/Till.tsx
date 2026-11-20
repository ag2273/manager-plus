import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Account } from "../../../core/ledger";
import type { Shift, ZReport } from "../../../core/shifts";
import type { Item } from "../../../core/items";
import type { Customer } from "../../../core/customers";
import type { CashSaleResult, Discount, HeldSale, Payment, PricedSale, Receipt, SaleLineInput } from "../../../core/sales";
import type { Warehouse } from "../../../core/stock";
import { formatMoney, parseMoney } from "../../../shared/money";
import { formatQuantity, parseQuantity } from "../../../shared/quantity";
import { business, errorText, today } from "../api";
import { ar } from "../strings";

type Tender = "cash" | "card" | "wallet" | "split" | "credit";
const TENDERS: Tender[] = ["cash", "card", "wallet", "split", "credit"];

type CartLine = { itemId: number; unit: "base" | "pack"; name: string; barcode: string; quantity: string; discount: string };

/** "2.50" is an amount off; "10%" is a percentage. Empty is no discount; null is unreadable. */
function parseDiscount(text: string): Discount | undefined | null {
  const t = text.trim();
  if (t === "") return undefined;
  const percent = t.endsWith("%");
  // A percentage reads like money: "12.5" → 1250 basis points.
  const value = parseMoney(percent ? t.slice(0, -1) : t);
  if (value === null) return null;
  return { kind: percent ? "percent" : "amount", value };
}

/** The cart as the core takes it, or null while a quantity or discount is unreadable. */
function toSaleLines(lines: CartLine[]): SaleLineInput[] | null {
  const out: SaleLineInput[] = [];
  for (const l of lines) {
    const quantity = parseQuantity(l.quantity);
    const discount = parseDiscount(l.discount);
    if (quantity === null || quantity <= 0 || discount === null) return null;
    out.push({ itemId: l.itemId, unit: l.unit, quantity, ...(discount ? { discount } : {}) });
  }
  return out;
}

/** Keystrokes closer together than this are a scanner, not a person. */
const SCANNER_GAP_MS = 40;
const MIN_BARCODE = 4;
/** No one types a quantity this long: it is a barcode scanned into the wrong field. */
const BARCODE = /^\d{8,}$/;

/**
 * The till. Everything works from the keyboard: type or scan into the search box,
 * Enter adds; F12 goes to payment; Enter there completes the sale; Esc clears.
 */
function Sale({ onCash, onClose, onReturn }: { onCash: () => void; onClose: () => void; onReturn: () => void }) {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState<number | "">("");
  const [lines, setLines] = useState<CartLine[]>([]);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Item[]>([]);
  const [priced, setPriced] = useState<PricedSale | null>(null);
  const [cash, setCash] = useState("");
  const [receiptDiscount, setReceiptDiscount] = useState("");
  const [held, setHeld] = useState<HeldSale[]>([]);
  const [showHeld, setShowHeld] = useState(false);
  const [tender, setTender] = useState<Tender>("cash");
  const [card, setCard] = useState("");
  const [wallet, setWallet] = useState("");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerId, setCustomerId] = useState<number | "">("");
  const [newCustomer, setNewCustomer] = useState<{ name: string; phone: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<(CashSaleResult & { names: string[] }) | null>(null);
  const search = useRef<HTMLInputElement>(null);
  /** Moves the cursor to the first payment field: the cash amount, the customer, or the complete button. */
  const focusPayment = () => document.querySelector<HTMLElement>(".till-pay [data-pay]")?.focus();
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
    void loadCustomers();
    void loadHeld();
  }, []);

  async function loadCustomers() {
    const result = await business.customers();
    if (result.ok) setCustomers(result.value.filter((c) => c.active));
  }

  async function createCustomer() {
    if (!newCustomer) return;
    const result = await business.addCustomer({ ...newCustomer, taxRegistrationNumber: "" });
    setError(errorText(result));
    if (result.ok) {
      await loadCustomers();
      setCustomerId(result.value);
      setNewCustomer(null);
    }
  }

  async function loadHeld() {
    const result = await business.heldSales();
    if (result.ok) setHeld(result.value);
  }

  async function hold() {
    const cart = toSaleLines(lines);
    const discount = parseDiscount(receiptDiscount);
    if (warehouseId === "" || cart === null || cart.length === 0 || discount === null) return;
    const result = await business.holdSale({ warehouseId, lines: cart, note: lines[0]?.name ?? "", ...(discount ? { discount } : {}) });
    setError(errorText(result));
    if (result.ok) {
      setLines([]);
      resetPayment();
      await loadHeld();
      search.current?.focus();
    }
  }

  async function recall(id: number) {
    const result = await business.recallSale(id);
    setError(errorText(result));
    if (!result.ok) return;
    const cart = result.value;
    setLast(null);
    const names = await business.items({ includeInactive: true });
    const byId = new Map((names.ok ? names.value : []).map((i) => [i.id, i]));
    setWarehouseId(cart.warehouseId);
    setLines(
      cart.lines.map((l) => {
        const item = byId.get(l.itemId);
        const pack = l.unit === "pack" && item?.pack;
        return {
          itemId: l.itemId,
          unit: l.unit,
          name: pack ? `${item.nameAr} · ${item.pack!.name}` : (item?.nameAr ?? ""),
          barcode: (pack ? item.pack!.barcode : item?.barcode) ?? "",
          quantity: formatQuantity(l.quantity),
          discount: l.discount ? formatDiscount(l.discount) : "",
        };
      }),
    );
    setReceiptDiscount(cart.discount ? formatDiscount(cart.discount) : "");
    setShowHeld(false);
    await loadHeld();
    search.current?.focus();
  }

  function resetPayment() {
    setCash("");
    setReceiptDiscount("");
    setCard("");
    setWallet("");
    setTender("cash");
    setCustomerId("");
    setNewCustomer(null);
  }

  // Totals come from the core: the screen never computes money or VAT.
  useEffect(() => {
    const complete = toSaleLines(lines);
    const discount = parseDiscount(receiptDiscount);
    if (complete === null || complete.length === 0 || discount === null) {
      setPriced(null);
      return;
    }
    let stale = false;
    void business.priceSale(today(), complete, discount).then((r) => {
      if (stale) return;
      setPriced(r.ok ? r.value : null);
      setError(r.ok ? null : errorText(r));
    });
    return () => {
      stale = true;
    };
  }, [lines, receiptDiscount]);

  function addUnit(unit: { itemId: number; unit: "base" | "pack"; name: string; barcode: string }) {
    setLast(null);
    setError(null);
    setLines((current) => {
      const at = current.findIndex((l) => l.itemId === unit.itemId && l.unit === unit.unit);
      if (at === -1) return [...current, { ...unit, quantity: "1", discount: "" }];
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
      if (lines.length > 0) focusPayment();
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
    resetPayment();
    setQuery("");
    setMatches([]);
    setError(null);
    search.current?.focus();
  }

  /** The tenders as typed. Cash left empty in cash mode means the exact total. */
  function payments(total: number): Payment[] | null {
    const amount = (text: string) => (text.trim() === "" ? 0 : parseMoney(text));
    switch (tender) {
      case "cash": {
        const c = cash.trim() === "" ? total : parseMoney(cash);
        return c === null ? null : [{ method: "cash", amount: c }];
      }
      case "card":
        return [{ method: "card", amount: total }];
      case "wallet":
        return [{ method: "wallet", amount: total }];
      case "split":
      case "credit": {
        const parts = [
          { method: "cash" as const, amount: amount(cash) },
          { method: "card" as const, amount: tender === "split" ? amount(card) : 0 },
          { method: "wallet" as const, amount: tender === "split" ? amount(wallet) : 0 },
        ];
        if (parts.some((p) => p.amount === null)) return null;
        return parts.filter((p): p is Payment => p.amount !== null && p.amount > 0);
      }
    }
  }

  async function complete() {
    const cart = toSaleLines(lines);
    const discount = parseDiscount(receiptDiscount);
    if (warehouseId === "" || cart === null || cart.length === 0 || discount === null || !priced) return;
    const paid = payments(priced.total);
    if (paid === null) {
      setError(ar.errors["price_invalid"]!);
      return;
    }
    if (tender === "credit" && customerId === "") {
      setError(ar.errors["customer_not_found"]!);
      return;
    }
    const result = await business.postSale({
      date: today(),
      warehouseId,
      payments: paid,
      ...(tender === "credit" && customerId !== "" ? { customerId } : {}),
      ...(discount ? { discount } : {}),
      lines: cart,
    });
    setError(errorText(result));
    if (result.ok) {
      const names = result.value.belowZero.map((id) => lines.find((l) => l.itemId === id)?.name ?? "");
      setLast({ ...result.value, names });
      setLines([]);
      resetPayment();
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
      focusPayment();
    } else if (event.key === "Escape") {
      event.preventDefault();
      clearSale();
    } else if (event.key === "F4") {
      event.preventDefault();
      document.querySelector<HTMLInputElement>(".till-cart tbody tr:last-child [data-discount]")?.focus();
    } else if (event.key === "F8") {
      event.preventDefault();
      void hold();
    } else if (event.key === "F9") {
      event.preventDefault();
      onReturn();
    } else if (event.key === "F10") {
      event.preventDefault();
      onClose();
    } else if (event.target !== search.current && !(event.target instanceof HTMLElement && event.target.closest(".till-pay"))) {
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
          <button type="button" className="btn" onClick={() => void hold()} disabled={lines.length === 0}>
            {ar.till.hold}
          </button>
          <button type="button" className="btn" onClick={() => setShowHeld(!showHeld)} disabled={held.length === 0}>
            {ar.till.held(held.length)}
          </button>
          <button type="button" className="btn" onClick={onReturn}>
            {ar.returns.open}
          </button>
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
      {showHeld && held.length > 0 && (
        <section className="card" aria-label={ar.till.heldTitle}>
          <ul className="till-matches">
            {held.map((h) => (
              <li key={h.id}>
                <button type="button" className="btn btn-small" onClick={() => void recall(h.id)}>
                  {ar.till.recall(h.note, new Date(h.at).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" }), h.lines.length)}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
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
                <th className="col-type">{ar.till.discount}</th>
                <th className="col-money">{ar.till.lineTotal}</th>
                <th className="col-remove" />
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted empty">
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
                    <td>
                      <input
                        data-discount
                        aria-label={`${ar.till.discount} ${l.name}`}
                        dir="ltr"
                        value={l.discount}
                        placeholder="—"
                        onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, discount: e.target.value } : x)))}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            e.stopPropagation();
                            search.current?.focus();
                          }
                        }}
                      />
                    </td>
                    <td className="num strong">{row && formatMoney(row.amount)}</td>
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
            <span className="muted">{ar.till.beforeDiscount}</span>
            <span className="num">{priced ? formatMoney(priced.gross) : "—"}</span>
          </div>
          <label className="till-sum till-discount">
            <span className="muted">{ar.till.receiptDiscount}</span>
            <input dir="ltr" value={receiptDiscount} placeholder="0.00 / 5%" onChange={(e) => setReceiptDiscount(e.target.value)} />
          </label>
          {priced && priced.discount > 0 && (
            <div className="till-sum">
              <span className="muted">{ar.till.totalDiscount}</span>
              <span className="num">−{formatMoney(priced.discount)}</span>
            </div>
          )}
          <div className="till-sum">
            <span className="muted">{ar.till.vatIncluded}</span>
            <span className="num">{priced ? formatMoney(priced.vat) : "—"}</span>
          </div>
          <div className="till-total">
            <span>{ar.till.due}</span>
            <span className="num">{priced ? formatMoney(priced.total) : "0.00"}</span>
          </div>
          <div role="radiogroup" aria-label={ar.till.method} className="pills till-tenders">
            {TENDERS.map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={t === tender}
                className="pill"
                onClick={() => {
                  setTender(t);
                  setTimeout(focusPayment);
                }}
              >
                {ar.till.tenders[t]}
              </button>
            ))}
          </div>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void complete();
            }}
          >
            {tender === "credit" && (
              <>
                <label className="field">
                  {ar.till.customer}
                  <select data-pay value={customerId} onChange={(e) => setCustomerId(e.target.value === "" ? "" : Number(e.target.value))}>
                    <option value="">{ar.till.pickCustomer}</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.phone ? ` · ${c.phone}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                {newCustomer ? (
                  <div className="stack till-new-customer">
                    <label className="field">
                      {ar.till.customerName}
                      <input autoFocus value={newCustomer.name} onChange={(e) => setNewCustomer({ ...newCustomer, name: e.target.value })} />
                    </label>
                    <label className="field">
                      {ar.till.customerPhone}
                      <input dir="ltr" value={newCustomer.phone} onChange={(e) => setNewCustomer({ ...newCustomer, phone: e.target.value })} />
                    </label>
                    <div className="row">
                      <button type="button" className="btn btn-small btn-primary" onClick={() => void createCustomer()}>
                        {ar.save}
                      </button>
                      <button type="button" className="btn btn-small" onClick={() => setNewCustomer(null)}>
                        {ar.cancel}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="link" onClick={() => setNewCustomer({ name: "", phone: "" })}>
                    {ar.till.newCustomer}
                  </button>
                )}
              </>
            )}
            {(tender === "cash" || tender === "split" || tender === "credit") && (
              <label className="field">
                {tender === "cash" ? ar.till.cash : tender === "credit" ? ar.till.paidNow : ar.till.tenders.cash}
                <input
                  data-pay={tender === "credit" ? undefined : true}
                  className="till-cash"
                  dir="ltr"
                  inputMode="decimal"
                  value={cash}
                  placeholder={tender === "cash" && priced ? formatMoney(priced.total) : "0.00"}
                  onChange={(e) => setCash(e.target.value)}
                />
              </label>
            )}
            {tender === "split" && (
              <>
                <label className="field">
                  {ar.till.tenders.card}
                  <input dir="ltr" inputMode="decimal" value={card} placeholder="0.00" onChange={(e) => setCard(e.target.value)} />
                </label>
                <label className="field">
                  {ar.till.tenders.wallet}
                  <input dir="ltr" inputMode="decimal" value={wallet} placeholder="0.00" onChange={(e) => setWallet(e.target.value)} />
                </label>
              </>
            )}
            <button
              data-pay={tender === "card" || tender === "wallet" ? true : undefined}
              type="submit"
              className="btn btn-primary till-complete"
              disabled={!priced}
            >
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

function formatDiscount(d: Discount): string {
  return d.kind === "percent" ? `${formatMoney(d.value)}%` : formatMoney(d.value);
}

type Panel = "sale" | "cash" | "close" | "return";

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
  if (panel === "return") return <ReturnPanel onDone={() => setPanel("sale")} />;
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
  return <Sale onCash={() => setPanel("cash")} onClose={() => setPanel("close")} onReturn={() => setPanel("return")} />;
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
    [ar.shift.z.salesTotal, report.sales.total],
    [ar.shift.z.salesCash, report.sales.byMethod.cash],
    [ar.shift.z.salesCard, report.sales.byMethod.card],
    [ar.shift.z.salesWallet, report.sales.byMethod.wallet],
    [ar.shift.z.salesCredit, report.sales.byMethod.credit],
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

/** A return against the original receipt: look it up by number, pick quantities, refund. */
function ReturnPanel({ onDone }: { onDone: () => void }) {
  const [number, setNumber] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [refund, setRefund] = useState<"cash" | "account">("cash");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const numberField = useRef<HTMLInputElement>(null);

  async function find(event: FormEvent) {
    event.preventDefault();
    setDone(null);
    const n = Number(number.trim());
    if (!Number.isInteger(n) || n <= 0) {
      setError(ar.errors["receipt_not_found"]!);
      return;
    }
    const result = await business.findReceipt(n);
    setError(errorText(result));
    setReceipt(result.ok ? result.value : null);
    setQuantities({});
    setRefund(result.ok && result.value.customerId !== null && result.value.onCredit > 0 ? "account" : "cash");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!receipt) return;
    const lines: { lineId: number; quantity: number }[] = [];
    for (const l of receipt.lines) {
      const text = quantities[l.lineId]?.trim() ?? "";
      if (text === "") continue;
      const quantity = parseQuantity(text);
      if (quantity === null || quantity <= 0) {
        setError(ar.errors["quantity_invalid"]!);
        return;
      }
      lines.push({ lineId: l.lineId, quantity });
    }
    const result = await business.returnSale({ date: today(), receiptId: receipt.id, lines, refund });
    setError(errorText(result));
    if (result.ok) {
      setDone(ar.returns.done(result.value.number, receipt.number, formatMoney(result.value.total)));
      setReceipt(null);
      setNumber("");
      numberField.current?.focus();
    }
  }

  return (
    <>
      <header className="screen-head">
        <div>
          <h1>{ar.returns.title}</h1>
          <span className="muted">{ar.returns.hint}</span>
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={onDone}>
            {ar.returns.back}
          </button>
        </div>
      </header>
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
      <form className="card form-row" onSubmit={find} onKeyDown={(e) => e.key === "Escape" && onDone()}>
        <label className="field narrow">
          {ar.returns.receiptNumber}
          <input ref={numberField} autoFocus dir="ltr" inputMode="numeric" value={number} onChange={(e) => setNumber(e.target.value)} />
        </label>
        <button type="submit" className="btn btn-primary">
          {ar.returns.find}
        </button>
      </form>
      {receipt && (
        <form className="card" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && onDone()}>
          <span className="muted">
            {ar.returns.receiptInfo(receipt.number, receipt.date, receipt.soldBy, formatMoney(receipt.total))}
          </span>
          <table className="lines">
            <thead>
              <tr>
                <th>{ar.till.item}</th>
                <th className="col-type">{ar.returns.sold}</th>
                <th className="col-type">{ar.returns.returned}</th>
                <th className="col-money">{ar.till.lineTotal}</th>
                <th className="col-type">{ar.returns.quantity}</th>
              </tr>
            </thead>
            <tbody>
              {receipt.lines.map((l) => (
                <tr key={l.lineId}>
                  <td>{l.nameAr}</td>
                  <td className="num">{formatQuantity(l.quantity)}</td>
                  <td className="num muted">{formatQuantity(l.returned)}</td>
                  <td className="num">{formatMoney(l.amount)}</td>
                  <td>
                    <input
                      aria-label={`${ar.returns.quantity} ${l.nameAr}`}
                      dir="ltr"
                      inputMode="decimal"
                      disabled={l.returned >= l.quantity}
                      value={quantities[l.lineId] ?? ""}
                      placeholder="0"
                      onChange={(e) => setQuantities({ ...quantities, [l.lineId]: e.target.value })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div role="radiogroup" aria-label={ar.returns.refund} className="pills">
            {(["cash", "account"] as const).map((r) => (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={r === refund}
                className="pill"
                disabled={r === "account" && receipt.customerId === null}
                onClick={() => setRefund(r)}
              >
                {ar.returns.refunds[r]}
              </button>
            ))}
          </div>
          <div className="row">
            <button type="submit" className="btn btn-primary">
              {ar.returns.submit}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
