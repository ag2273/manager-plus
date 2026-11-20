import { useEffect, useState, type FormEvent } from "react";
import type { Account } from "../../../core/ledger";
import type { Aging, OpenDocument, PartyKind, Statement } from "../../../core/settlements";
import type { A4Request, Result } from "../../../shared/api";
import { formatMoney, parseMoney } from "../../../shared/money";
import { business, errorText, today } from "../api";
import { ar } from "../strings";

/** A customer or supplier as the payment, statement and aging views need them. */
export type Party = { id: number; name: string; active: boolean };

const MONEY_ROLES = ["cash_drawer", "main_cash", "bank", "wallet"];
const startOfYear = () => `${today().slice(0, 4)}-01-01`;

function PartySelect({ kind, parties, value, onChange }: { kind: PartyKind; parties: Party[]; value: number | ""; onChange: (id: number | "") => void }) {
  return (
    <label className="field">
      {ar.parties[kind]}
      <select value={value} onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}>
        <option value="">{kind === "customer" ? ar.parties.pickCustomer : ar.parties.pickSupplier}</option>
        {parties.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Money received from a customer or paid to a supplier, optionally split over their open documents. */
export function PaymentForm({ kind, parties }: { kind: PartyKind; parties: Party[] }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [partyId, setPartyId] = useState<number | "">("");
  const [accountId, setAccountId] = useState<number | "">("");
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [documents, setDocuments] = useState<OpenDocument[]>([]);
  const [split, setSplit] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    void business.accounts().then((r) => {
      if (!r.ok) return;
      const money = r.value.filter((a) => a.active && a.type === "asset" && (a.role === null || MONEY_ROLES.includes(a.role)));
      setAccounts(money);
      setAccountId((current) => (current === "" ? (money.find((a) => a.role === "main_cash")?.id ?? money[0]?.id ?? "") : current));
    });
  }, []);

  async function loadDocuments(id: number | "") {
    setSplit({});
    if (id === "") {
      setDocuments([]);
      return;
    }
    const r = await business.openDocuments(kind, id);
    setDocuments(r.ok ? r.value : []);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setDone(null);
    const value = parseMoney(amount);
    if (partyId === "") {
      setError(ar.errors[kind === "customer" ? "customer_not_found" : "supplier_not_found"]!);
      return;
    }
    if (value === null || value === 0) {
      setError(ar.errors["amount_invalid"]!);
      return;
    }
    const allocations: { entryId: number; amount: number }[] = [];
    for (const d of documents) {
      const text = split[d.entryId]?.trim() ?? "";
      if (text === "") continue;
      const part = parseMoney(text);
      if (part === null) {
        setError(ar.errors["allocation_invalid"]!);
        return;
      }
      if (part > 0) allocations.push({ entryId: d.entryId, amount: part });
    }
    const input = { date, partyId, accountId: accountId === "" ? 0 : accountId, amount: value, reference, allocations };
    const result: Result<{ number: number }> =
      kind === "customer" ? await business.receiveCustomerPayment(input) : await business.paySupplier(input);
    setError(errorText(result));
    if (result.ok) {
      setDone(kind === "customer" ? ar.parties.received(result.value.number) : ar.parties.paid(result.value.number));
      setAmount("");
      setReference("");
      await loadDocuments(partyId);
    }
  }

  return (
    <form className="card" onSubmit={submit} aria-label={kind === "customer" ? ar.parties.receive : ar.parties.pay}>
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
        <PartySelect
          kind={kind}
          parties={parties}
          value={partyId}
          onChange={(id) => {
            setPartyId(id);
            void loadDocuments(id);
          }}
        />
        <label className="field narrow">
          {ar.parties.date}
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>
      <div className="row">
        <label className="field">
          {kind === "customer" ? ar.parties.accountIn : ar.parties.accountOut}
          <select value={accountId} onChange={(e) => setAccountId(Number(e.target.value))}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field narrow">
          {ar.parties.amount}
          <input dir="ltr" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="field narrow">
          {ar.parties.reference}
          <input dir="ltr" value={reference} onChange={(e) => setReference(e.target.value)} />
        </label>
      </div>
      {partyId !== "" && (
        <section aria-label={ar.parties.allocate}>
          <h2 className="small">{ar.parties.allocate}</h2>
          <span className="muted small">{ar.parties.allocateHint}</span>
          {documents.length === 0 ? (
            <p className="muted">{ar.parties.noOpen}</p>
          ) : (
            <table className="lines">
              <thead>
                <tr>
                  <th className="col-type">{ar.parties.date}</th>
                  <th>{ar.parties.document}</th>
                  <th className="col-money">{ar.parties.amount}</th>
                  <th className="col-money">{ar.parties.open}</th>
                  <th className="col-money">{ar.parties.allocation}</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((d) => (
                  <tr key={d.entryId}>
                    <td className="muted">{d.date}</td>
                    <td>{d.memo}</td>
                    <td className="num">{formatMoney(d.amount)}</td>
                    <td className="num">{formatMoney(d.open)}</td>
                    <td>
                      <input
                        aria-label={`${ar.parties.allocation} ${d.memo}`}
                        dir="ltr"
                        inputMode="decimal"
                        value={split[d.entryId] ?? ""}
                        onChange={(e) => setSplit({ ...split, [d.entryId]: e.target.value })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
      <div className="row">
        <button type="submit" className="btn btn-primary">
          {kind === "customer" ? ar.parties.receive : ar.parties.pay}
        </button>
      </div>
    </form>
  );
}

/** Sends an A4 page to the printer or a PDF file, reporting where the PDF went. */
export function useA4(): { message: { ok: boolean; text: string } | null; send: (request: A4Request) => Promise<void> } {
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  async function send(request: A4Request) {
    const result = await window.api.printA4(request);
    if (!result.ok) setMessage({ ok: false, text: errorText(result)! });
    else setMessage(result.value.saved ? { ok: true, text: ar.parties.savedPdf(result.value.saved) } : null);
  }
  return { message, send };
}

/** A customer's or supplier's account over a period, with print and PDF. */
export function StatementView({ kind, parties }: { kind: PartyKind; parties: Party[] }) {
  const [partyId, setPartyId] = useState<number | "">("");
  const [from, setFrom] = useState(startOfYear());
  const [to, setTo] = useState(today());
  const [statement, setStatement] = useState<Statement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const a4 = useA4();

  async function show(event: FormEvent) {
    event.preventDefault();
    if (partyId === "") return;
    const result = await business.statement(kind, partyId, from, to);
    setError(errorText(result));
    setStatement(result.ok ? result.value : null);
  }

  return (
    <>
      <form className="card form-row" onSubmit={show}>
        <PartySelect kind={kind} parties={parties} value={partyId} onChange={setPartyId} />
        <label className="field narrow">
          {ar.parties.from}
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field narrow">
          {ar.parties.to}
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button type="submit" className="btn btn-primary">
          {ar.parties.show}
        </button>
      </form>
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      {a4.message && (
        <div role={a4.message.ok ? "status" : "alert"} className={a4.message.ok ? "ok" : "error"}>
          {a4.message.text}
        </div>
      )}
      {statement && (
        <section className="table-card" aria-label={statement.name}>
          <div className="row table-head">
            <strong>{statement.name}</strong>
            <div className="actions">
              <button type="button" className="btn btn-small" onClick={() => void a4.send({ kind: "statement", party: kind, id: statement.partyId, from, to, output: "print" })}>
                {ar.parties.print}
              </button>
              <button type="button" className="btn btn-small" onClick={() => void a4.send({ kind: "statement", party: kind, id: statement.partyId, from, to, output: "pdf" })}>
                {ar.parties.pdf}
              </button>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th className="col-type">{ar.parties.date}</th>
                <th>{ar.parties.memo}</th>
                <th className="col-money">{ar.parties.debit}</th>
                <th className="col-money">{ar.parties.credit}</th>
                <th className="col-money">{ar.parties.balance}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="muted">{statement.from}</td>
                <td>{ar.parties.opening}</td>
                <td />
                <td />
                <td className="num">{formatMoney(statement.opening)}</td>
              </tr>
              {statement.lines.map((l) => (
                <tr key={l.entryId}>
                  <td className="muted">{l.date}</td>
                  <td>{l.memo}</td>
                  <td className="num">{l.debit > 0 && formatMoney(l.debit)}</td>
                  <td className="num">{l.credit > 0 && formatMoney(l.credit)}</td>
                  <td className="num">{formatMoney(l.balance)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4}>
                  <strong>{ar.parties.closing}</strong>
                </td>
                <td className="num">
                  <strong>{formatMoney(statement.closing)}</strong>
                </td>
              </tr>
            </tfoot>
          </table>
          {statement.lines.length === 0 && <p className="muted empty">{ar.parties.noLines}</p>}
        </section>
      )}
    </>
  );
}

/** Aged receivables or payables on a date. */
export function AgingView({ kind }: { kind: PartyKind }) {
  const [asOf, setAsOf] = useState(today());
  const [report, setReport] = useState<Aging | null>(null);

  useEffect(() => {
    let stale = false;
    void business.aging(kind, asOf).then((r) => !stale && setReport(r.ok ? r.value : null));
    return () => {
      stale = true;
    };
  }, [kind, asOf]);

  return (
    <>
      <div className="card form-row">
        <label className="field narrow">
          {ar.parties.asOf}
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </label>
      </div>
      <section className="table-card" aria-label={ar.parties.asOf}>
        {!report || report.rows.length === 0 ? (
          <p className="muted empty">{ar.parties.noAging}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{ar.parties[kind]}</th>
                {ar.parties.buckets.map((b) => (
                  <th key={b} className="col-money">
                    {b}
                  </th>
                ))}
                <th className="col-money">{ar.parties.unapplied}</th>
                <th className="col-money">{ar.parties.balance}</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((r) => (
                <tr key={r.partyId}>
                  <td>{r.name}</td>
                  {r.buckets.map((b, i) => (
                    <td key={i} className="num">
                      {b !== 0 && formatMoney(b)}
                    </td>
                  ))}
                  <td className="num">{r.unapplied !== 0 && formatMoney(r.unapplied)}</td>
                  <td className="num">{formatMoney(r.balance)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>
                  <strong>{ar.parties.total}</strong>
                </td>
                {report.totals.map((b, i) => (
                  <td key={i} className="num">
                    <strong>{formatMoney(b)}</strong>
                  </td>
                ))}
                <td className="num">
                  <strong>{formatMoney(report.unapplied)}</strong>
                </td>
                <td className="num">
                  <strong>{formatMoney(report.balance)}</strong>
                </td>
              </tr>
            </tfoot>
          </table>
        )}
      </section>
    </>
  );
}
