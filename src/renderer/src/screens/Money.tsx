import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Account } from "../../../shared/books/ledger";
import type { AccountLine, Expense, MoneyAccount, MoneyTransfer, Reconciliation } from "../../../shared/books/money";
import type { Supplier } from "../../../shared/books/purchases";
import type { Result } from "../../../shared/api";
import { formatMoney, parseMoney } from "../../../shared/money";
import { business, errorText, today } from "../api";
import { ar } from "../strings";
import { FieldHelp } from "../help/Help";

type Tab = "accounts" | "expense" | "transfer" | "reconcile" | "lock";
const TABS: Tab[] = ["accounts", "expense", "transfer", "reconcile", "lock"];
const startOfMonth = () => `${today().slice(0, 7)}-01`;

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

function AccountSelect({
  label,
  accounts,
  value,
  onChange,
}: {
  label: string;
  accounts: { id: number; code: string; name: string }[];
  value: number | "";
  onChange: (id: number | "") => void;
}) {
  return (
    <label className="field">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}>
        <option value="">{ar.money.pickAccount}</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.code} {a.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A void button that asks once more before posting the reversing entry. */
function VoidButton({ entryId, onDone, onError }: { entryId: number; onDone: () => Promise<void>; onError: (text: string | null) => void }) {
  const [sure, setSure] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-small"
      onClick={async () => {
        if (!sure) {
          setSure(true);
          return;
        }
        const result = await business.voidEntry(entryId, today());
        onError(errorText(result));
        setSure(false);
        if (result.ok) await onDone();
      }}
    >
      {sure ? ar.money.confirmVoid : ar.money.voidIt}
    </button>
  );
}

/** Cash, bank and wallet accounts: balances, expenses, transfers, bank reconciliation and the lock date. */
export function Money() {
  const [tab, setTab] = useState<Tab>("accounts");
  const [money, setMoney] = useState<MoneyAccount[]>([]);
  const [asOf, setAsOf] = useState(today());

  const reload = useCallback(async () => {
    const r = await business.moneyAccounts(asOf);
    if (r.ok) setMoney(r.value);
  }, [asOf]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <>
      <header className="screen-head">
        <div>
          <h1>{ar.nav.money}</h1>
          <span className="muted">{ar.money.hint}</span>
        </div>
      </header>
      <div role="tablist" aria-label={ar.nav.money} className="pills">
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={t === tab} className="pill" onClick={() => setTab(t)}>
            {ar.money.tabs[t]}
          </button>
        ))}
      </div>
      {tab === "accounts" && (
        <>
          <div className="card form-row">
            <label className="field narrow">
              {ar.money.asOf}
              <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
            </label>
          </div>
          <section className="table-card" aria-label={ar.money.tabs.accounts}>
            <table>
              <thead>
                <tr>
                  <th className="col-code">{ar.accounts.code}</th>
                  <th>{ar.money.account}</th>
                  <th className="col-money">{ar.money.balance}</th>
                </tr>
              </thead>
              <tbody>
                {money.map((a) => (
                  <tr key={a.id}>
                    <td className="muted">{a.code}</td>
                    <td>{a.name}</td>
                    <td className="num">{formatMoney(a.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
      {tab === "expense" && <ExpenseForm money={money} onChange={reload} />}
      {tab === "transfer" && <TransferForm money={money} onChange={reload} />}
      {tab === "reconcile" && <Reconcile money={money} />}
      {tab === "lock" && <LockDate />}
    </>
  );
}

function ExpenseForm({ money, onChange }: { money: MoneyAccount[]; onChange: () => Promise<void> }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [date, setDate] = useState(today());
  const [expenseAccountId, setExpenseAccountId] = useState<number | "">("");
  const [amount, setAmount] = useState("");
  const [vat, setVat] = useState("");
  const [onAccount, setOnAccount] = useState(false);
  const [fromId, setFromId] = useState<number | "">("");
  const [supplierId, setSupplierId] = useState<number | "">("");
  const [memo, setMemo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const r = await business.expenses();
    if (r.ok) setExpenses(r.value);
  }, []);

  useEffect(() => {
    void business.accounts().then((r) => r.ok && setAccounts(r.value.filter((a) => a.type === "expense" && a.active)));
    void business.suppliers().then((r) => r.ok && setSuppliers(r.value.filter((s) => s.active && s.currency === "EGP")));
    void reload();
  }, [reload]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setDone(null);
    const value = parseMoney(amount);
    const tax = vat.trim() === "" ? 0 : parseMoney(vat);
    if (value === null || value === 0 || tax === null) {
      setError(ar.errors["amount_invalid"]!);
      return;
    }
    const paidFrom = onAccount ? (supplierId === "" ? null : { supplierId }) : fromId === "" ? null : { accountId: fromId };
    if (expenseAccountId === "" || paidFrom === null) {
      setError(ar.errors["account_not_allowed"]!);
      return;
    }
    const result = await business.recordExpense({ date, expenseAccountId, amount: value, vat: tax, paidFrom, memo });
    setError(errorText(result));
    if (result.ok) {
      setDone(ar.money.recorded(result.value.number));
      setAmount("");
      setVat("");
      setMemo("");
      await Promise.all([reload(), onChange()]);
    }
  }

  return (
    <>
      <form className="card" onSubmit={submit} aria-label={ar.money.tabs.expense}>
        <Notice error={error} done={done} />
        <div className="row">
          <AccountSelect label={ar.money.expenseAccount} accounts={accounts} value={expenseAccountId} onChange={setExpenseAccountId} />
          <label className="field narrow">
            {ar.money.date}
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="field narrow">
            {ar.money.amount}
            <input dir="ltr" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label className="field narrow">
            {ar.money.vat}
            <input dir="ltr" inputMode="decimal" placeholder="0.00" value={vat} onChange={(e) => setVat(e.target.value)} />
          </label>
        </div>
        <div className="row">
          <label className="check">
            <input type="checkbox" checked={onAccount} onChange={(e) => setOnAccount(e.target.checked)} />
            {ar.money.onAccount}
          </label>
          {onAccount ? (
            <label className="field">
              {ar.money.supplier}
              <select value={supplierId} onChange={(e) => setSupplierId(e.target.value === "" ? "" : Number(e.target.value))}>
                <option value="">{ar.parties.pickSupplier}</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <AccountSelect label={ar.money.paidFrom} accounts={money} value={fromId} onChange={setFromId} />
          )}
          <label className="field">
            {ar.money.memo}
            <input value={memo} onChange={(e) => setMemo(e.target.value)} />
          </label>
        </div>
        <div className="row">
          <button type="submit" className="btn btn-primary">
            {ar.money.record}
          </button>
        </div>
      </form>
      <section className="table-card" aria-label={ar.money.expenses}>
        <div className="row table-head">
          <strong>{ar.money.expenses}</strong>
          <span className="muted small">{ar.money.voidHint}</span>
        </div>
        {expenses.length === 0 ? (
          <p className="muted empty">{ar.money.noExpenses}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th className="col-type">{ar.money.date}</th>
                <th>{ar.money.expenseAccount}</th>
                <th>{ar.money.paidFrom}</th>
                <th className="col-money">{ar.money.amount}</th>
                <th className="col-money">{ar.money.vat}</th>
                <th className="col-actions" />
              </tr>
            </thead>
            <tbody>
              {expenses.map((x) => (
                <tr key={x.id} className={x.voided ? "inactive" : undefined}>
                  <td className="muted">{x.date}</td>
                  <td>
                    {x.number} · {x.accountName}
                    {x.memo && <div className="muted small">{x.memo}</div>}
                  </td>
                  <td>{x.paidFrom}</td>
                  <td className="num">{formatMoney(x.amount)}</td>
                  <td className="num">{x.vat > 0 && formatMoney(x.vat)}</td>
                  <td>
                    {x.voided ? (
                      <span className="chip chip-warn">{ar.money.voided}</span>
                    ) : (
                      <VoidButton entryId={x.entryId} onError={setError} onDone={async () => void (await Promise.all([reload(), onChange()]))} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function TransferForm({ money, onChange }: { money: MoneyAccount[]; onChange: () => Promise<void> }) {
  const [transfers, setTransfers] = useState<MoneyTransfer[]>([]);
  const [date, setDate] = useState(today());
  const [fromId, setFromId] = useState<number | "">("");
  const [toId, setToId] = useState<number | "">("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const r = await business.moneyTransfers();
    if (r.ok) setTransfers(r.value);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setDone(null);
    const value = parseMoney(amount);
    if (value === null || value === 0) {
      setError(ar.errors["amount_invalid"]!);
      return;
    }
    if (fromId === "" || toId === "") {
      setError(ar.errors["account_not_allowed"]!);
      return;
    }
    const result = await business.transferMoney({ date, fromAccountId: fromId, toAccountId: toId, amount: value, memo });
    setError(errorText(result));
    if (result.ok) {
      setDone(ar.money.transferred(result.value.number));
      setAmount("");
      setMemo("");
      await Promise.all([reload(), onChange()]);
    }
  }

  return (
    <>
      <form className="card" onSubmit={submit} aria-label={ar.money.tabs.transfer}>
        <Notice error={error} done={done} />
        <div className="row">
          <AccountSelect label={ar.money.from} accounts={money} value={fromId} onChange={setFromId} />
          <AccountSelect label={ar.money.to} accounts={money} value={toId} onChange={setToId} />
        </div>
        <div className="row">
          <label className="field narrow">
            {ar.money.date}
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="field narrow">
            {ar.money.transferAmount}
            <input dir="ltr" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label className="field">
            {ar.money.memo}
            <input value={memo} onChange={(e) => setMemo(e.target.value)} />
          </label>
        </div>
        <div className="row">
          <button type="submit" className="btn btn-primary">
            {ar.money.transfer}
          </button>
        </div>
      </form>
      <section className="table-card" aria-label={ar.money.transfers}>
        <div className="row table-head">
          <strong>{ar.money.transfers}</strong>
        </div>
        {transfers.length === 0 ? (
          <p className="muted empty">{ar.money.noTransfers}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th className="col-type">{ar.money.date}</th>
                <th>{ar.money.from}</th>
                <th>{ar.money.to}</th>
                <th className="col-money">{ar.money.transferAmount}</th>
                <th className="col-actions" />
              </tr>
            </thead>
            <tbody>
              {transfers.map((t) => (
                <tr key={t.id} className={t.voided ? "inactive" : undefined}>
                  <td className="muted">{t.date}</td>
                  <td>
                    {t.number} · {t.from}
                    {t.memo && <div className="muted small">{t.memo}</div>}
                  </td>
                  <td>{t.to}</td>
                  <td className="num">{formatMoney(t.amount)}</td>
                  <td>
                    {t.voided ? (
                      <span className="chip chip-warn">{ar.money.voided}</span>
                    ) : (
                      <VoidButton entryId={t.entryId} onError={setError} onDone={async () => void (await Promise.all([reload(), onChange()]))} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function Reconcile({ money }: { money: MoneyAccount[] }) {
  const [accountId, setAccountId] = useState<number | "">("");
  const [from, setFrom] = useState(startOfMonth());
  const [to, setTo] = useState(today());
  const [statementText, setStatementText] = useState("");
  const [lines, setLines] = useState<AccountLine[]>([]);
  const [rec, setRec] = useState<Reconciliation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const statement = parseMoney(statementText) ?? 0;

  const reload = useCallback(async () => {
    if (accountId === "") return;
    const [l, r] = await Promise.all([business.accountLines(accountId, from, to), business.reconciliation(accountId, statement)]);
    setError(errorText(l as Result<unknown>) ?? errorText(r as Result<unknown>));
    setLines(l.ok ? l.value : []);
    setRec(r.ok ? r.value : null);
  }, [accountId, from, to, statement]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function tick(line: AccountLine, cleared: boolean) {
    if (accountId === "") return;
    setLines(lines.map((l) => (l.lineId === line.lineId ? { ...l, cleared } : l)));
    const result = await business.setCleared(accountId, [line.lineId], cleared);
    setError(errorText(result));
    await reload();
  }

  return (
    <>
      <div className="card">
        <Notice error={error} />
        <div className="row">
          <AccountSelect label={ar.money.account} accounts={money} value={accountId} onChange={setAccountId} />
          <label className="field narrow">
            {ar.parties.from}
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="field narrow">
            {ar.parties.to}
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label className="field narrow">
            {ar.money.statement}
            <input dir="ltr" inputMode="decimal" value={statementText} onChange={(e) => setStatementText(e.target.value)} />
          </label>
        </div>
        {rec && (
          <div className="row small" aria-label={ar.money.difference}>
            <span>
              {ar.money.bookBalance}: <strong>{formatMoney(rec.balance)}</strong>
            </span>
            <span>
              {ar.money.cleared}: <strong>{formatMoney(rec.cleared)}</strong>
            </span>
            <span className={rec.difference === 0 ? undefined : "warn-text"}>
              {ar.money.difference}: <strong>{formatMoney(rec.difference)}</strong>
            </span>
          </div>
        )}
      </div>
      {accountId !== "" && (
        <section className="table-card" aria-label={ar.money.tabs.reconcile}>
          {lines.length === 0 ? (
            <p className="muted empty">{ar.money.noLines}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th className="col-type">{ar.money.tick}</th>
                  <th className="col-type">{ar.money.date}</th>
                  <th>{ar.money.memo}</th>
                  <th className="col-money">{ar.money.debit}</th>
                  <th className="col-money">{ar.money.credit}</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.lineId}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`${ar.money.tick} ${l.memo}`}
                        checked={l.cleared}
                        onChange={(e) => void tick(l, e.target.checked)}
                      />
                    </td>
                    <td className="muted">{l.date}</td>
                    <td>{l.memo}</td>
                    <td className="num">{l.debit > 0 && formatMoney(l.debit)}</td>
                    <td className="num">{l.credit > 0 && formatMoney(l.credit)}</td>
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

function LockDate() {
  const [date, setDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    void business.lockDate().then((r) => r.ok && setDate(r.value ?? ""));
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    const result = await business.setLockDate(date === "" ? null : date);
    setError(errorText(result));
    setDone(result.ok ? ar.money.lockSaved : null);
  }

  return (
    <form className="card" onSubmit={save} aria-label={ar.money.tabs.lock}>
      <Notice error={error} done={done} />
      <p className="muted small">{ar.money.lockHint}</p>
      <div className="row">
        <label className="field narrow">
          {ar.money.lockDate}
          <FieldHelp field="lockDate" />
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <button type="submit" className="btn btn-primary">
          {ar.money.saveLock}
        </button>
      </div>
    </form>
  );
}
