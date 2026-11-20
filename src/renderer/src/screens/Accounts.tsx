import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import type { AccountType } from "../../../core/chart-of-accounts";
import type { Account, JournalLine, TrialBalance } from "../../../core/ledger";
import type { Result } from "../../../shared/api";
import { formatMoney, parseMoney } from "../../../shared/money";
import { business, errorText, today } from "../api";
import { ar } from "../strings";

type Tab = "chart" | "journal" | "opening" | "trial";
const TABS: Tab[] = ["chart", "journal", "opening", "trial"];
const TYPES: AccountType[] = [
  "asset",
  "liability",
  "equity",
  "income",
  "expense",
];

/** Chart of accounts, manual journal entries, opening balances and the trial balance. */
export function Accounts() {
  const [tab, setTab] = useState<Tab>("chart");
  const [accounts, setAccounts] = useState<Account[]>([]);

  const reload = useCallback(async () => {
    const result = await business.accounts();
    if (result.ok) setAccounts(result.value);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <>
      <header className="screen-head">
        <div>
          <h1>{ar.nav.accounts}</h1>
          <span className="muted">{ar.accounts.hint}</span>
        </div>
      </header>
      <div role="tablist" aria-label={ar.nav.accounts} className="pills">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={t === tab}
            className="pill"
            onClick={() => setTab(t)}
          >
            {ar.accounts.tabs[t]}
          </button>
        ))}
      </div>
      {tab === "chart" && (
        <ChartOfAccounts accounts={accounts} onChange={reload} />
      )}
      {tab === "journal" && <EntryForm accounts={accounts} mode="journal" />}
      {tab === "opening" && <EntryForm accounts={accounts} mode="opening" />}
      {tab === "trial" && <TrialBalanceView />}
    </>
  );
}

function Alert({
  text,
  kind = "error",
}: {
  text: string | null;
  kind?: "error" | "ok";
}) {
  if (!text) return null;
  return (
    <div role={kind === "error" ? "alert" : "status"} className={kind}>
      {text}
    </div>
  );
}

function ChartOfAccounts({
  accounts,
  onChange,
}: {
  accounts: Account[];
  onChange: () => Promise<void>;
}) {
  const [draft, setDraft] = useState({
    code: "",
    name: "",
    type: "expense" as AccountType,
  });
  const [editing, setEditing] = useState<{
    id: number;
    code: string;
    name: string;
  } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(work: Promise<Result<unknown>>): Promise<boolean> {
    const result = await work;
    setError(errorText(result));
    if (result.ok) await onChange();
    return result.ok;
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (await run(business.addAccount(draft)))
      setDraft({ ...draft, code: "", name: "" });
  }

  async function save() {
    if (
      editing &&
      (await run(
        business.updateAccount(editing.id, {
          code: editing.code,
          name: editing.name,
        }),
      ))
    ) {
      setEditing(null);
    }
  }

  return (
    <>
      <Alert text={error} />
      <form className="card form-row" onSubmit={add}>
        <label className="field narrow">
          {ar.accounts.code}
          <input
            value={draft.code}
            inputMode="numeric"
            onChange={(e) => setDraft({ ...draft, code: e.target.value })}
          />
        </label>
        <label className="field">
          {ar.accounts.name}
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <label className="field narrow">
          {ar.accounts.type}
          <select
            value={draft.type}
            onChange={(e) =>
              setDraft({ ...draft, type: e.target.value as AccountType })
            }
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {ar.accountTypes[t]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn-primary">
          {ar.accounts.add}
        </button>
      </form>
      <section className="table-card" aria-label={ar.accounts.tabs.chart}>
        <table>
          <thead>
            <tr>
              <th className="col-code">{ar.accounts.code}</th>
              <th>{ar.accounts.name}</th>
              <th className="col-type">{ar.accounts.type}</th>
              <th className="col-actions" />
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id} className={a.active ? undefined : "inactive"}>
                {editing?.id === a.id ? (
                  <>
                    <td>
                      <input
                        aria-label={ar.accounts.code}
                        value={editing.code}
                        onChange={(e) =>
                          setEditing({ ...editing, code: e.target.value })
                        }
                      />
                    </td>
                    <td>
                      <input
                        aria-label={ar.accounts.name}
                        value={editing.name}
                        onChange={(e) =>
                          setEditing({ ...editing, name: e.target.value })
                        }
                      />
                    </td>
                    <td>{ar.accountTypes[a.type]}</td>
                    <td>
                      <div className="actions">
                        <button
                          type="button"
                          className="btn btn-small btn-primary"
                          onClick={save}
                        >
                          {ar.save}
                        </button>
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() => setEditing(null)}
                        >
                          {ar.cancel}
                        </button>
                      </div>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="muted">{a.code}</td>
                    <td>
                      {a.name}
                      {a.role && (
                        <span className="chip">{ar.accounts.system}</span>
                      )}
                      {!a.active && (
                        <span className="chip chip-warn">
                          {ar.accounts.inactive}
                        </span>
                      )}
                    </td>
                    <td className="muted">{ar.accountTypes[a.type]}</td>
                    <td>
                      <div className="actions">
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() =>
                            setEditing({ id: a.id, code: a.code, name: a.name })
                          }
                        >
                          {ar.edit}
                        </button>
                        {!a.role &&
                          (a.active ? (
                            <button
                              type="button"
                              className="btn btn-small"
                              onClick={() =>
                                run(business.deactivateAccount(a.id))
                              }
                            >
                              {ar.accounts.deactivate}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-small"
                              onClick={() =>
                                run(business.reactivateAccount(a.id))
                              }
                            >
                              {ar.accounts.reactivate}
                            </button>
                          ))}
                        {!a.role &&
                          (confirmDelete === a.id ? (
                            <button
                              type="button"
                              className="btn btn-small btn-danger"
                              onClick={async () => {
                                setConfirmDelete(null);
                                await run(business.deleteAccount(a.id));
                              }}
                            >
                              {ar.accounts.confirmDelete}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-small"
                              onClick={() => setConfirmDelete(a.id)}
                            >
                              {ar.delete}
                            </button>
                          ))}
                      </div>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

type DraftLine = {
  accountId: number | "";
  debit: string;
  credit: string;
  memo: string;
};
const emptyLine = (): DraftLine => ({
  accountId: "",
  debit: "",
  credit: "",
  memo: "",
});

/** A manual journal entry, or opening balances (where the app adds the balancing line). */
function EntryForm({
  accounts,
  mode,
}: {
  accounts: Account[];
  mode: "journal" | "opening";
}) {
  const [date, setDate] = useState(today());
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine(), emptyLine()]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const active = accounts.filter(
    (a) => a.active && (mode === "journal" || a.role !== "opening_balances"),
  );

  // Totals are only shown while typing; the core checks the entry when it is posted.
  const totals = useMemo(() => {
    const sum = (key: "debit" | "credit") =>
      lines.reduce((t, l) => t + (parseMoney(l[key]) ?? 0), 0);
    return { debit: sum("debit"), credit: sum("credit") };
  }, [lines]);

  function setLine(index: number, change: Partial<DraftLine>) {
    setLines(lines.map((l, i) => (i === index ? { ...l, ...change } : l)));
  }

  function toLines(): JournalLine[] | null {
    const out: JournalLine[] = [];
    for (const l of lines) {
      if (l.accountId === "" && l.debit.trim() === "" && l.credit.trim() === "")
        continue;
      const debit = l.debit.trim() === "" ? undefined : parseMoney(l.debit);
      const credit = l.credit.trim() === "" ? undefined : parseMoney(l.credit);
      if (debit === null || credit === null) return null;
      out.push({
        accountId: l.accountId === "" ? 0 : l.accountId,
        ...(debit !== undefined && { debit }),
        ...(credit !== undefined && { credit }),
        memo: l.memo,
      });
    }
    return out;
  }

  async function post(event: FormEvent) {
    event.preventDefault();
    setDone(null);
    const entryLines = toLines();
    if (!entryLines) {
      setError(ar.errors["line_amount_invalid"]!);
      return;
    }
    const result =
      mode === "journal"
        ? await business.postJournalEntry({ date, memo, lines: entryLines })
        : await business.postOpeningBalances(date, entryLines);
    setError(errorText(result));
    if (result.ok) {
      setDone(
        mode === "journal" ? ar.journal.posted : ar.journal.openingPosted,
      );
      setMemo("");
      setLines([emptyLine(), emptyLine()]);
    }
  }

  const difference = totals.debit - totals.credit;

  return (
    <form className="card" onSubmit={post}>
      {mode === "opening" && <p className="muted">{ar.journal.openingHint}</p>}
      <Alert text={error} />
      <Alert text={done} kind="ok" />
      <div className="row">
        <label className="field narrow">
          {ar.journal.date}
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        {mode === "journal" && (
          <label className="field">
            {ar.journal.memo}
            <input value={memo} onChange={(e) => setMemo(e.target.value)} />
          </label>
        )}
      </div>
      <table className="lines">
        <thead>
          <tr>
            <th>{ar.journal.account}</th>
            <th className="col-money">{ar.journal.debit}</th>
            <th className="col-money">{ar.journal.credit}</th>
            <th>{ar.journal.lineMemo}</th>
            <th className="col-remove" />
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td>
                <select
                  aria-label={ar.journal.account}
                  value={l.accountId}
                  onChange={(e) =>
                    setLine(i, {
                      accountId:
                        e.target.value === "" ? "" : Number(e.target.value),
                    })
                  }
                >
                  <option value="">{ar.journal.pickAccount}</option>
                  {active.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  aria-label={ar.journal.debit}
                  inputMode="decimal"
                  dir="ltr"
                  value={l.debit}
                  onChange={(e) => setLine(i, { debit: e.target.value })}
                />
              </td>
              <td>
                <input
                  aria-label={ar.journal.credit}
                  inputMode="decimal"
                  dir="ltr"
                  value={l.credit}
                  onChange={(e) => setLine(i, { credit: e.target.value })}
                />
              </td>
              <td>
                <input
                  aria-label={ar.journal.lineMemo}
                  value={l.memo}
                  onChange={(e) => setLine(i, { memo: e.target.value })}
                />
              </td>
              <td>
                {lines.length > 2 && (
                  <button
                    type="button"
                    className="btn btn-small"
                    aria-label={ar.journal.removeLine}
                    onClick={() => setLines(lines.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>
              <button
                type="button"
                className="btn btn-small"
                onClick={() => setLines([...lines, emptyLine()])}
              >
                {ar.journal.addLine}
              </button>
            </td>
            <td className="num">{formatMoney(totals.debit)}</td>
            <td className="num">{formatMoney(totals.credit)}</td>
            <td
              colSpan={2}
              className={
                difference === 0 || mode === "opening" ? "muted" : "warn-text"
              }
            >
              {mode === "journal"
                ? difference === 0
                  ? ar.journal.balanced
                  : `${ar.journal.difference} ${formatMoney(Math.abs(difference))}`
                : difference !== 0 &&
                  `${ar.journal.toOpening} ${formatMoney(Math.abs(difference))}`}
            </td>
          </tr>
        </tfoot>
      </table>
      <div className="row">
        <button type="submit" className="btn btn-primary">
          {mode === "journal" ? ar.journal.post : ar.journal.postOpening}
        </button>
      </div>
    </form>
  );
}

function TrialBalanceView() {
  const [asOf, setAsOf] = useState(today());
  const [tb, setTb] = useState<TrialBalance | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void business.trialBalance(asOf).then((result) => {
      setError(errorText(result));
      setTb(result.ok ? result.value : null);
    });
  }, [asOf]);

  return (
    <>
      <div className="row">
        <label className="field narrow">
          {ar.trial.asOf}
          <input
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
          />
        </label>
      </div>
      <Alert text={error} />
      {tb && (
        <section className="table-card" aria-label={ar.accounts.tabs.trial}>
          {tb.rows.length === 0 ? (
            <p className="muted empty">{ar.trial.empty}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th className="col-code">{ar.accounts.code}</th>
                  <th>{ar.accounts.name}</th>
                  <th className="col-money">{ar.journal.debit}</th>
                  <th className="col-money">{ar.journal.credit}</th>
                </tr>
              </thead>
              <tbody>
                {tb.rows.map((r) => (
                  <tr key={r.accountId}>
                    <td className="muted">{r.code}</td>
                    <td>{r.name}</td>
                    <td className="num">
                      {r.debit ? formatMoney(r.debit) : ""}
                    </td>
                    <td className="num">
                      {r.credit ? formatMoney(r.credit) : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td />
                  <td>{ar.trial.total}</td>
                  <td className="num">{formatMoney(tb.totalDebit)}</td>
                  <td className="num">{formatMoney(tb.totalCredit)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </section>
      )}
    </>
  );
}
