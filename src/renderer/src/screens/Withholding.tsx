import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { WithholdingCategory, WithholdingReport } from "../../../core/withholding";
import { formatMoney, parseMoney } from "../../../shared/money";
import { business, errorText, today } from "../api";
import { ar } from "../strings";

export const percent = (basisPoints: number) => `${basisPoints / 100}%`;
const currentRate = (c: WithholdingCategory) => c.rates.filter((r) => r.from <= today()).at(-1)?.rate ?? c.rates[0]?.rate ?? 0;

export function useWithholdingCategories(): [WithholdingCategory[], () => Promise<void>] {
  const [categories, setCategories] = useState<WithholdingCategory[]>([]);
  const reload = useCallback(async () => {
    const r = await business.withholdingCategories();
    if (r.ok) setCategories(r.value);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return [categories, reload];
}

/** Picks a withholding tax category, or none. */
export function WithholdingSelect({
  categories,
  value,
  onChange,
  label = ar.withholding.category,
}: {
  categories: WithholdingCategory[];
  value: number | null;
  onChange: (id: number | null) => void;
  label?: string;
}) {
  return (
    <select aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}>
      <option value="">{ar.withholding.none}</option>
      {categories.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name} ({percent(currentRate(c))})
        </option>
      ))}
    </select>
  );
}

const startOfQuarter = () => {
  const d = today();
  const month = Math.floor((Number(d.slice(5, 7)) - 1) / 3) * 3 + 1;
  return `${d.slice(0, 4)}-${String(month).padStart(2, "0")}-01`;
};

/** Withholding categories with their rates, and the report for the quarterly form. */
export function WithholdingView() {
  const [categories, reload] = useWithholdingCategories();
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [rateFrom, setRateFrom] = useState(today());
  const [rateText, setRateText] = useState("");
  const [from, setFrom] = useState(startOfQuarter());
  const [to, setTo] = useState(today());
  const [report, setReport] = useState<WithholdingReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    void business.withholdingReport(from, to).then((r) => {
      if (stale) return;
      setError(errorText(r));
      setReport(r.ok ? r.value : null);
    });
    return () => {
      stale = true;
    };
  }, [from, to]);

  async function addRate(event: FormEvent) {
    event.preventDefault();
    const rate = parseMoney(rateText);
    if (categoryId === null || rate === null) {
      setError(ar.errors[categoryId === null ? "withholding_category_not_found" : "tax_rate_invalid"]!);
      return;
    }
    const result = await business.addWithholdingRate(categoryId, {
      from: rateFrom,
      rate,
    });
    setError(errorText(result));
    if (result.ok) {
      setRateText("");
      await reload();
    }
  }

  return (
    <>
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      <section className="table-card" aria-label={ar.withholding.rates}>
        <div className="row table-head">
          <strong>{ar.withholding.rates}</strong>
        </div>
        <table>
          <thead>
            <tr>
              <th>{ar.withholding.category}</th>
              <th className="col-money">{ar.withholding.currentRate}</th>
              <th>{ar.withholding.from}</th>
            </tr>
          </thead>
          <tbody>
            {categories.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td className="num">{percent(currentRate(c))}</td>
                <td className="muted">{c.rates.map((r) => `${r.from}: ${percent(r.rate)}`).join(" · ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <form className="form-row" onSubmit={addRate} aria-label={ar.withholding.addRate}>
          <label className="field">
            {ar.withholding.category}
            <WithholdingSelect categories={categories} value={categoryId} onChange={setCategoryId} />
          </label>
          <label className="field narrow">
            {ar.withholding.from}
            <input type="date" value={rateFrom} onChange={(e) => setRateFrom(e.target.value)} />
          </label>
          <label className="field narrow">
            {ar.withholding.newRate}
            <input dir="ltr" inputMode="decimal" value={rateText} onChange={(e) => setRateText(e.target.value)} />
          </label>
          <button type="submit" className="btn">
            {ar.withholding.addRate}
          </button>
        </form>
      </section>
      <div className="card form-row">
        <label className="field narrow">
          {ar.parties.from}
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field narrow">
          {ar.parties.to}
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <span className="muted small">{ar.withholding.reportHint}</span>
      </div>
      {report && (
        <section className="table-card" aria-label={ar.withholding.report}>
          <div className="row table-head">
            <strong>{ar.withholding.report}</strong>
          </div>
          {report.rows.length === 0 ? (
            <p className="muted empty">{ar.withholding.empty}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th className="col-type">{ar.withholding.date}</th>
                  <th className="col-type">{ar.withholding.number}</th>
                  <th>{ar.withholding.party}</th>
                  <th className="col-type">{ar.withholding.taxRegistrationNumber}</th>
                  <th>{ar.withholding.category}</th>
                  <th className="col-money">{ar.withholding.rate}</th>
                  <th className="col-money">{ar.withholding.base}</th>
                  <th className="col-money">{ar.withholding.amount}</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr key={`${r.kind}-${r.number}`}>
                    <td className="muted">{r.date}</td>
                    <td>
                      {r.number}
                      <div className="muted small">{ar.withholding.kind[r.kind]}</div>
                    </td>
                    <td>{r.partyName}</td>
                    <td className="muted" dir="ltr">
                      {r.taxRegistrationNumber}
                    </td>
                    <td>{r.category}</td>
                    <td className="num">{percent(r.rate)}</td>
                    <td className="num">{formatMoney(r.base)}</td>
                    <td className="num">{formatMoney(r.tax)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={7}>
                    <strong>{ar.withholding.withheld}</strong>
                  </td>
                  <td className="num">
                    <strong>{formatMoney(report.withheld)}</strong>
                  </td>
                </tr>
                <tr>
                  <td colSpan={7}>
                    <strong>{ar.withholding.suffered}</strong>
                  </td>
                  <td className="num">
                    <strong>{formatMoney(report.suffered)}</strong>
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </section>
      )}
    </>
  );
}
