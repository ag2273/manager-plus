import { useEffect, useState } from "react";
import type { ImportReport, ImportSheet } from "../../../shared/books/import";
import type { Warehouse } from "../../../shared/books/stock";
import { BALANCE_COLUMNS, ITEM_COLUMNS } from "../../../shared/import-columns";
import { formatMoney } from "../../../shared/money";
import type { Lang } from "../../../shared/report-tables";
import { business, errorText, today } from "../api";
import { ar, currentLanguage } from "../strings";

const COLUMN_LABELS = new Map<string, string>([...ITEM_COLUMNS, ...BALANCE_COLUMNS].map((c) => [c.key, c.ar]));

/**
 * Items, opening stock and opening balances from an Excel or CSV file: get the template, pick
 * the file, check it (nothing is saved), then import.
 */
export function ImportPanel({ onClose, onImported }: { onClose: () => void; onImported: (report: ImportReport) => Promise<void> }) {
  const [lang, setLang] = useState<Lang>(currentLanguage());
  const [file, setFile] = useState<{ name: string; sheets: ImportSheet[] } | null>(null);
  const [date, setDate] = useState(today());
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState<number | "">("");
  const [report, setReport] = useState<ImportReport | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void business.warehouses().then((r) => {
      if (!r.ok) return;
      const active = r.value.filter((w) => w.active);
      setWarehouses(active);
      if (active[0]) setWarehouseId(active[0].id);
    });
  }, []);

  async function template() {
    const result = await window.api.saveImportTemplate(lang);
    if (!result.ok) setMessage({ ok: false, text: errorText(result)! });
    else if (result.value.saved) setMessage({ ok: true, text: ar.import.templateSaved(result.value.saved) });
  }

  async function pick() {
    const result = await window.api.openSpreadsheet();
    setReport(null);
    if (!result.ok) {
      setMessage({ ok: false, text: errorText(result)! });
      return;
    }
    if (!result.value) return;
    setFile(result.value);
    setMessage(null);
  }

  const input = () => (file && warehouseId !== "" ? { date, warehouseId, sheets: file.sheets } : null);

  async function check() {
    const request = input();
    if (!request) return;
    setBusy(true);
    const result = await business.checkImport(request);
    setBusy(false);
    setMessage(result.ok ? null : { ok: false, text: errorText(result)! });
    setReport(result.ok ? result.value : null);
  }

  async function run() {
    const request = input();
    if (!request) return;
    setBusy(true);
    const result = await business.importData(request);
    setBusy(false);
    if (!result.ok) {
      setMessage({ ok: false, text: errorText(result)! });
      return;
    }
    setMessage({ ok: true, text: ar.import.done(result.value.items, result.value.balances) });
    setReport(null);
    setFile(null);
    await onImported(result.value);
  }

  const clean = report !== null && report.problems.length === 0;

  return (
    <section className="card" aria-label={ar.import.title}>
      <div className="row spread">
        <strong>{ar.import.title}</strong>
        <button type="button" className="btn btn-small" onClick={onClose}>
          {ar.reports.close}
        </button>
      </div>
      <p className="muted">{ar.import.hint}</p>
      <div className="row">
        <label className="field narrow">
          {ar.import.templateLanguage}
          <select value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
            <option value="ar">العربية</option>
            <option value="en">English</option>
          </select>
        </label>
        <button type="button" className="btn" onClick={() => void template()}>
          {ar.import.template}
        </button>
      </div>
      <div className="row">
        <button type="button" className="btn" onClick={() => void pick()}>
          {ar.import.pick}
        </button>
        {file && (
          <span>
            {file.name} · {ar.import.rows(file.sheets.reduce((t, s) => t + Math.max(0, s.rows.length - 1), 0))}
          </span>
        )}
      </div>
      {file && (
        <div className="row">
          <label className="field narrow">
            {ar.import.date}
            <input
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                setReport(null);
              }}
            />
          </label>
          <label className="field">
            {ar.import.warehouse}
            <select
              value={warehouseId}
              onChange={(e) => {
                setWarehouseId(Number(e.target.value));
                setReport(null);
              }}
            >
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn" disabled={busy} onClick={() => void check()}>
            {ar.import.check}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !clean} onClick={() => void run()}>
            {ar.import.run}
          </button>
        </div>
      )}
      {message && (
        <div role={message.ok ? "status" : "alert"} className={message.ok ? "ok" : "error"}>
          {message.text}
        </div>
      )}
      {clean && (
        <div role="status" className="ok">
          {ar.import.ready(
            report.items,
            report.stockLines,
            formatMoney(report.stockValue),
            report.balances,
            report.newCustomers,
            report.newSuppliers,
          )}
        </div>
      )}
      {report && report.problems.length > 0 && (
        <>
          <div role="alert" className="error">
            {ar.import.problems(report.problems.length)}
          </div>
          <table>
            <thead>
              <tr>
                <th>{ar.import.sheet}</th>
                <th>{ar.import.row}</th>
                <th>{ar.import.column}</th>
                <th>{ar.import.problem}</th>
                <th>{ar.import.value}</th>
              </tr>
            </thead>
            <tbody>
              {report.problems.map((p, i) => (
                <tr key={i}>
                  <td>{p.sheet}</td>
                  <td className="num">{p.row || ""}</td>
                  <td>{p.column ? (COLUMN_LABELS.get(p.column) ?? p.column) : ""}</td>
                  <td>{ar.errors[p.code] ?? ar.errors["unexpected"]}</td>
                  <td>{p.code === "import_column_missing" ? "" : p.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
