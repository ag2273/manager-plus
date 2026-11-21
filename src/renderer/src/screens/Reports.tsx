import { useEffect, useState, type FormEvent } from "react";
import type { Account } from "../../../core/ledger";
import type { EntryDetail, GeneralLedger } from "../../../core/reports";
import type { VatBox, VatTransaction } from "../../../core/vat-return";
import { formatMoney } from "../../../shared/money";
import { formatQuantity } from "../../../shared/quantity";
import {
  type Lang,
  type ReportTable,
  balanceSheetTable,
  ledgerTable,
  pnlTable,
  salesByDayTable,
  salesByItemTable,
  salesByMethodTable,
  stockTable,
  vatReturnTable,
} from "../../../shared/report-tables";
import { business, errorText, today } from "../api";
import { ar, currentLanguage } from "../strings";

type Tab = "pnl" | "balanceSheet" | "ledger" | "byItem" | "byDay" | "byMethod" | "stock" | "vat";
const TABS: Tab[] = ["pnl", "balanceSheet", "ledger", "byItem", "byDay", "byMethod", "stock", "vat"];
const startOfYear = () => `${today().slice(0, 4)}-01-01`;

/** A report built in both languages: Arabic on screen, either one for the PDF or Excel file. */
type Built = {
  table: (lang: Lang) => ReportTable;
  accounts?: (number | null)[];
  entries?: (number | null)[];
  /** The VAT return's boxes, row by row, and the documents behind them. */
  vat?: { boxes: VatBox[]; transactions: VatTransaction[] };
};

function Cell({ value, kind }: { value: string | number | null; kind: "text" | "money" | "quantity" }) {
  if (value === null) return <td />;
  if (typeof value === "number" && kind !== "text")
    return <td className={value < 0 ? "num negative" : "num"}>{kind === "money" ? formatMoney(value) : formatQuantity(value)}</td>;
  return <td>{value}</td>;
}

/** The report on screen. Rows that lead somewhere (an account's ledger, an entry) are clickable. */
function ReportView({ table, onRow }: { table: ReportTable; onRow?: (index: number) => (() => void) | null }) {
  return (
    <section className="table-card" aria-label={table.title}>
      <table>
        <thead>
          <tr>
            {table.columns.map((c, i) => (
              <th key={i} className={c.kind === "text" ? undefined : "col-money"}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, ri) => {
            const go = onRow?.(ri) ?? null;
            const heading = row.every((v, i) => i === 1 || v === null) && row[1] !== null && table.columns[2]?.kind === "money" && row[2] === null;
            return (
              <tr key={ri} className={go ? "clickable" : heading ? "group-row" : undefined} onClick={go ?? undefined}>
                {row.map((v, ci) => (
                  <Cell key={ci} value={v} kind={table.columns[ci]?.kind ?? "text"} />
                ))}
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          {table.totals.map((t, i) => (
            <tr key={i} className="total-row">
              <th colSpan={Math.max(1, table.columns.length - 1)}>{t.label}</th>
              <td className="num">{formatMoney(t.value)}</td>
            </tr>
          ))}
        </tfoot>
      </table>
    </section>
  );
}

/** PDF, print and Excel for the report on screen, in Arabic or English. */
function ExportBar({ built }: { built: Built }) {
  const [lang, setLang] = useState<Lang>(currentLanguage());
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    void window.api.preferences().then((p) => setLang(p.documentLanguage));
  }, []);
  async function pdf(output: "print" | "pdf") {
    const result = await window.api.printA4({ kind: "report", table: built.table(lang), output });
    if (!result.ok) setMessage({ ok: false, text: errorText(result)! });
    else setMessage(result.value.saved ? { ok: true, text: ar.parties.savedPdf(result.value.saved) } : null);
  }
  async function excel() {
    const result = await window.api.exportExcel(built.table(lang));
    if (!result.ok) setMessage({ ok: false, text: errorText(result)! });
    else setMessage(result.value.saved ? { ok: true, text: ar.reports.savedExcel(result.value.saved) } : null);
  }
  return (
    <>
      <div className="row export-bar">
        <label className="field narrow">
          {ar.reports.language}
          <select value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
            <option value="ar">العربية</option>
            <option value="en">English</option>
          </select>
        </label>
        <button type="button" className="btn" onClick={() => void pdf("print")}>
          {ar.reports.print}
        </button>
        <button type="button" className="btn" onClick={() => void pdf("pdf")}>
          {ar.reports.pdf}
        </button>
        <button type="button" className="btn" onClick={() => void excel()}>
          {ar.reports.excel}
        </button>
      </div>
      {message && (
        <div role={message.ok ? "status" : "alert"} className={message.ok ? "ok" : "error"}>
          {message.text}
        </div>
      )}
    </>
  );
}

/** The lines of one journal entry: where every figure in a report ends up. */
function EntryCard({ entry, onClose }: { entry: EntryDetail; onClose: () => void }) {
  return (
    <section className="card" aria-label={ar.reports.entry}>
      <div className="row spread">
        <strong>
          {ar.reports.entry} #{entry.id} · {entry.date} · {ar.reports.kinds[entry.kind] ?? ar.reports.kinds["journal"]}
          {entry.voided && <span className="badge">{ar.reports.voided}</span>}
        </strong>
        <button type="button" className="btn btn-small" onClick={onClose}>
          {ar.reports.close}
        </button>
      </div>
      {entry.memo && <p className="muted">{entry.memo}</p>}
      <table>
        <thead>
          <tr>
            <th className="col-code">{ar.accounts.code}</th>
            <th>{ar.money.account}</th>
            <th>{ar.reports.party}</th>
            <th className="col-money">{ar.reports.debit}</th>
            <th className="col-money">{ar.reports.credit}</th>
          </tr>
        </thead>
        <tbody>
          {entry.lines.map((l, i) => (
            <tr key={i}>
              <td className="muted">{l.code}</td>
              <td>{l.name}</td>
              <td>{l.party ?? ""}</td>
              <td className="num">{l.debit ? formatMoney(l.debit) : ""}</td>
              <td className="num">{l.credit ? formatMoney(l.credit) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** The documents behind one box of the VAT return; each opens its journal entry. */
function VatDocuments({ box, rows, onEntry }: { box: VatBox; rows: VatTransaction[]; onEntry: (id: number) => void }) {
  const title = `${ar.reports.vatSections[box.section]} (${ar.reports.vatKinds[box.taxKind]})`;
  return (
    <section className="table-card" aria-label={title}>
      <table>
        <caption>{title}</caption>
        <thead>
          <tr>
            <th>{ar.reports.document}</th>
            <th>{ar.reports.number}</th>
            <th>{ar.reports.date}</th>
            <th>{ar.reports.party}</th>
            <th className="col-money">{ar.reports.netAmount}</th>
            <th className="col-money">{ar.reports.vatAmount}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t, i) => (
            <tr key={i} className="clickable" onClick={() => onEntry(t.entryId)}>
              <td>{ar.reports.vatDocuments[t.kind] ?? t.kind}</td>
              <td>{t.number}</td>
              <td>{t.date}</td>
              <td>{t.party}</td>
              <Cell value={t.net} kind="money" />
              <Cell value={t.vat} kind="money" />
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** Profit and loss, balance sheet, general ledger, sales, stock and VAT reports, with drill-down and export. */
export function Reports({ vatRegistered }: { vatRegistered: boolean }) {
  const [tab, setTab] = useState<Tab>("pnl");
  const [from, setFrom] = useState(startOfYear());
  const [to, setTo] = useState(today());
  const [accountId, setAccountId] = useState<number | "">("");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [built, setBuilt] = useState<Built | null>(null);
  const [entry, setEntry] = useState<EntryDetail | null>(null);
  const [box, setBox] = useState<VatBox | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pointInTime = tab === "balanceSheet" || tab === "stock";

  useEffect(() => {
    void business.accounts().then((r) => r.ok && setAccounts(r.value));
  }, []);

  async function load(which: Tab, account: number | "" = accountId) {
    setEntry(null);
    setBox(null);
    let result;
    if (which === "pnl") {
      result = await business.profitAndLoss(from, to);
      if (result.ok) {
        const r = result.value;
        setBuilt({
          table: (l) => pnlTable(r, l),
          accounts: [null, ...r.income.map((x) => x.accountId), null, ...r.expenses.map((x) => x.accountId)],
        });
      }
    } else if (which === "balanceSheet") {
      result = await business.balanceSheet(to);
      if (result.ok) {
        const r = result.value;
        setBuilt({
          table: (l) => balanceSheetTable(r, l),
          accounts: [
            null,
            ...r.assets.map((x) => x.accountId),
            null,
            ...r.liabilities.map((x) => x.accountId),
            null,
            ...r.equity.map((x) => x.accountId),
            null,
          ],
        });
      }
    } else if (which === "ledger") {
      if (account === "") {
        setBuilt(null);
        return;
      }
      result = await business.generalLedger(account, from, to);
      if (result.ok) {
        const r: GeneralLedger = result.value;
        setBuilt({ table: (l) => ledgerTable(r, l), entries: [null, ...r.lines.map((x) => x.entryId)] });
      }
    } else if (which === "byItem") {
      result = await business.salesByItem(from, to);
      if (result.ok) {
        const rows = result.value;
        setBuilt({ table: (l) => salesByItemTable(rows, from, to, l) });
      }
    } else if (which === "byDay") {
      result = await business.salesByDay(from, to);
      if (result.ok) {
        const rows = result.value;
        setBuilt({ table: (l) => salesByDayTable(rows, from, to, l) });
      }
    } else if (which === "byMethod") {
      result = await business.salesByPaymentMethod(from, to);
      if (result.ok) {
        const rows = result.value;
        setBuilt({ table: (l) => salesByMethodTable(rows, from, to, l) });
      }
    } else if (which === "vat") {
      result = await business.vatReturn(from, to);
      if (result.ok) {
        const r = result.value;
        setBuilt({ table: (l) => vatReturnTable(r, l), vat: { boxes: r.boxes, transactions: r.transactions } });
      }
    } else {
      result = await business.stockAt(to);
      if (result.ok) {
        const r = result.value;
        setBuilt({ table: (l) => stockTable(r, l) });
      }
    }
    setError(errorText(result));
    if (!result.ok) setBuilt(null);
  }

  useEffect(() => {
    void load(tab);
    // Reload when the tab changes; dates apply with the Show button.
  }, [tab]);

  function show(event: FormEvent) {
    event.preventDefault();
    void load(tab);
  }

  function openLedger(id: number) {
    setAccountId(id);
    setTab("ledger");
    // Switching tabs reloads with the new account; on the ledger tab already, load it here.
    if (tab === "ledger") void load("ledger", id);
  }

  async function openEntry(id: number) {
    const result = await business.journalEntry(id);
    setError(errorText(result));
    setEntry(result.ok ? result.value : null);
  }

  const onRow = (index: number) => {
    const vatBox = built?.vat?.boxes[index];
    if (vatBox) return () => setBox(vatBox);
    const account = built?.accounts?.[index];
    if (account) return () => openLedger(account);
    const entryId = built?.entries?.[index];
    if (entryId) return () => void openEntry(entryId);
    return null;
  };

  return (
    <>
      <header className="screen-head">
        <div>
          <h1>{ar.nav.reports}</h1>
          <span className="muted">{ar.reports.hint}</span>
        </div>
      </header>
      <div role="tablist" aria-label={ar.nav.reports} className="pills">
        {TABS.filter((t) => t !== "vat" || vatRegistered).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={t === tab}
            className="pill"
            onClick={() => {
              // A VAT return covers a month or quarter: start from the first of the month.
              if (t === "vat") setFrom(`${to.slice(0, 7)}-01`);
              setTab(t);
            }}
          >
            {ar.reports.tabs[t]}
          </button>
        ))}
      </div>
      <form className="card form-row" onSubmit={show}>
        {tab === "ledger" && (
          <label className="field">
            {ar.money.account}
            <select
              value={accountId}
              onChange={(e) => {
                const id = e.target.value === "" ? "" : Number(e.target.value);
                setAccountId(id);
                void load("ledger", id);
              }}
            >
              <option value="">{ar.money.pickAccount}</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {!pointInTime && (
          <label className="field narrow">
            {ar.reports.from}
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
        )}
        <label className="field narrow">
          {pointInTime ? ar.reports.asOf : ar.reports.to}
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button type="submit" className="btn btn-primary">
          {ar.reports.show}
        </button>
      </form>
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      {built && (
        <>
          <ExportBar key={tab} built={built} />
          {entry && <EntryCard entry={entry} onClose={() => setEntry(null)} />}
          <ReportView table={built.table(currentLanguage())} onRow={onRow} />
          {box && built.vat && (
            <VatDocuments
              box={box}
              rows={built.vat.transactions.filter((t) => t.section === box.section && t.taxKind === box.taxKind)}
              onEntry={(id) => void openEntry(id)}
            />
          )}
          {(built.accounts || built.entries || built.vat) && (
            <p className="muted">{built.accounts ? ar.reports.drillAccount : built.vat ? ar.reports.drillVat : ar.reports.drillEntry}</p>
          )}
        </>
      )}
      {!built && tab === "ledger" && !error && <p className="muted">{ar.reports.pickLedger}</p>}
    </>
  );
}
