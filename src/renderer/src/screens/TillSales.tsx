import { useEffect, useMemo, useState } from "react";
import type { Receipt } from "../../../shared/books/sales";
import type { Shift } from "../../../shared/books/shifts";
import { formatMoney } from "../../../shared/money";
import { formatQuantity } from "../../../shared/quantity";
import { business, errorText, today } from "../api";
import { ar, currentLanguage, locale } from "../strings";

const time = (at: string) => new Date(at).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
const money = (value: number) => <span dir="ltr">{formatMoney(value)}</span>;

/** How a receipt was paid, as one line: each tender, and what was left on credit. */
function paidBy(r: Receipt): string {
  const t = ar.tillSales;
  const parts = r.payments.map((p) => `${ar.till.tenders[p.method] ?? p.method} ${formatMoney(p.amount)}`);
  if (r.onCredit > 0) parts.push(`${t.onCredit} ${formatMoney(r.onCredit)}`);
  return parts.join(" + ");
}

/** One receipt in full, with a reprint. */
function ReceiptDetail({ receipt, onBack }: { receipt: Receipt; onBack: () => void }) {
  const t = ar.tillSales;
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  async function reprint() {
    const result = await window.api.print({ kind: "sale", number: receipt.number, copy: true, openDrawer: false });
    setMessage(result.ok ? { ok: true, text: t.reprinted } : { ok: false, text: errorText(result)! });
  }
  const name = (l: Receipt["lines"][number]) => (currentLanguage() === "en" && l.nameEn ? l.nameEn : l.nameAr);
  return (
    <section className="card" aria-labelledby="receipt-title">
      <div className="row">
        <h2 id="receipt-title">{t.receipt(receipt.number)}</h2>
        <button type="button" className="btn btn-primary" onClick={() => void reprint()}>
          {t.reprint}
        </button>
        <button type="button" className="btn" onClick={onBack}>
          {t.back}
        </button>
      </div>
      <p className="muted">
        {receipt.date} · {time(receipt.at)} · {ar.tillSales.cashier}: {receipt.soldBy}
      </p>
      {message && (
        <div role={message.ok ? "status" : "alert"} className={message.ok ? "ok" : "error"}>
          {message.text}
        </div>
      )}
      <table>
        <thead>
          <tr>
            <th>{ar.till.item}</th>
            <th className="num">{ar.till.quantity}</th>
            <th className="num">{ar.till.price}</th>
            <th className="num">{ar.till.discount}</th>
            <th className="num">{ar.till.lineTotal}</th>
          </tr>
        </thead>
        <tbody>
          {receipt.lines.map((l) => (
            <tr key={l.lineId}>
              <td>
                {name(l)}
                {l.returned > 0 && <small className="muted"> · {t.returned(formatQuantity(l.returned))}</small>}
                {l.serials.length > 0 && <small className="muted"> · {l.serials.join("، ")}</small>}
              </td>
              <td className="num">{formatQuantity(l.quantity)}</td>
              <td className="num">{money(l.unitPrice)}</td>
              <td className="num">{l.discount > 0 ? money(l.discount) : ""}</td>
              <td className="num">{money(l.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="totals-list">
        <dt>{ar.till.vatIncluded}</dt>
        <dd>{money(receipt.vat)}</dd>
        <dt>{t.total}</dt>
        <dd>
          <strong>{money(receipt.total)}</strong>
        </dd>
        <dt>{ar.till.payment}</dt>
        <dd>{paidBy(receipt)}</dd>
        {receipt.change > 0 && (
          <>
            <dt>{t.change}</dt>
            <dd>{money(receipt.change)}</dd>
          </>
        )}
      </dl>
    </section>
  );
}

/**
 * The till's sales (#97, notes 8 and 9): receipts by date, shift and cashier, each opening to its
 * items, payments and total, and reprinted from there. A cashier sees only their own; the core sees to that.
 */
export function TillSales({ currentShift, onBack }: { currentShift: number | null; onBack: () => void }) {
  const t = ar.tillSales;
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [shiftId, setShiftId] = useState<number | "">(currentShift ?? "");
  const [userId, setUserId] = useState<number | "">("");
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [receipts, setReceipts] = useState<Receipt[] | null>(null);
  const [open, setOpen] = useState<Receipt | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void business.shifts().then((r) => r.ok && setShifts(r.value));
  }, []);

  useEffect(() => {
    const filter = { from, to, ...(shiftId === "" ? {} : { shiftId }), ...(userId === "" ? {} : { userId }) };
    void business.searchReceipts(filter).then((r) => {
      setError(errorText(r));
      setReceipts(r.ok ? r.value : []);
    });
  }, [from, to, shiftId, userId]);

  // The cashiers who opened shifts, for the filter.
  const cashiers = useMemo(() => [...new Map(shifts.map((s) => [s.userId, s.userName])).entries()], [shifts]);
  const total = (receipts ?? []).reduce((sum, r) => sum + r.total, 0);

  if (open) return <ReceiptDetail receipt={open} onBack={() => setOpen(null)} />;
  return (
    <>
      <header className="screen-head">
        <div>
          <h1>{t.title}</h1>
          <span className="muted">{t.hint}</span>
        </div>
        <button type="button" className="btn" onClick={onBack}>
          {t.backToTill}
        </button>
      </header>
      <div className="row">
        <label className="field narrow">
          {t.from}
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field narrow">
          {t.to}
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="field narrow">
          {t.shift}
          <select value={shiftId} onChange={(e) => setShiftId(e.target.value === "" ? "" : Number(e.target.value))}>
            <option value="">{t.allShifts}</option>
            {shifts.map((s) => (
              <option key={s.id} value={s.id}>
                {t.shiftLabel(s.id, s.userName, s.openedAt.slice(0, 10), s.status === "open")}
              </option>
            ))}
          </select>
        </label>
        {cashiers.length > 1 && (
          <label className="field narrow">
            {ar.tillSales.cashier}
            <select value={userId} onChange={(e) => setUserId(e.target.value === "" ? "" : Number(e.target.value))}>
              <option value="">{t.allCashiers}</option>
              {cashiers.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      {receipts && (
        <section className="table-card" aria-label={t.title}>
          <p className="muted">{t.summary(receipts.length, formatMoney(total))}</p>
          {receipts.length === 0 ? (
            <p className="muted">{t.none}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t.number}</th>
                  <th>{t.when}</th>
                  <th>{ar.tillSales.cashier}</th>
                  <th className="num">{t.items}</th>
                  <th>{ar.till.payment}</th>
                  <th className="num">{t.total}</th>
                </tr>
              </thead>
              <tbody>
                {receipts.map((r) => (
                  <tr
                    key={r.id}
                    className="clickable"
                    tabIndex={0}
                    onClick={() => setOpen(r)}
                    onKeyDown={(e) => e.key === "Enter" && setOpen(r)}
                  >
                    <td>{r.number}</td>
                    <td>
                      {r.date} · {time(r.at)}
                    </td>
                    <td>{r.soldBy}</td>
                    <td className="num">{r.lines.length}</td>
                    <td>{paidBy(r)}</td>
                    <td className="num">{money(r.total)}</td>
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
