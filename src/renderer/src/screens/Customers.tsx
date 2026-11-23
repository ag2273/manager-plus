import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Customer, CustomerInput, PriceLevel } from "../../../shared/books/customers";
import type { Result } from "../../../shared/api";
import { formatMoney, parseMoney } from "../../../shared/money";
import { business, errorText } from "../api";
import { ar } from "../strings";
import { WithholdingSelect, useWithholdingCategories } from "./Withholding";
import { AgingView, PaymentForm, StatementView } from "./Parties";
import { FieldHelp } from "../help/Help";

type Tab = "customers" | "payment" | "statement" | "aging";

/** Customers and their balances; for managers and accountants also receipts, statements and aging. */
export function Customers({ keepsBooks }: { keepsBooks: boolean }) {
  const [tab, setTab] = useState<Tab>("customers");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const tabs: Tab[] = keepsBooks ? ["customers", "payment", "statement", "aging"] : ["customers"];

  const reload = useCallback(async () => {
    const result = await business.customers();
    if (result.ok) setCustomers(result.value);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <>
      <header className="screen-head">
        <div>
          <h1>{ar.customers.title}</h1>
          <span className="muted">{ar.customers.hint}</span>
        </div>
      </header>
      {tabs.length > 1 && (
        <div role="tablist" aria-label={ar.customers.title} className="pills">
          {tabs.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={t === tab} className="pill" onClick={() => setTab(t)}>
              {ar.customers.tabs[t]}
            </button>
          ))}
        </div>
      )}
      {tab === "customers" && <CustomerList customers={customers} onChange={reload} keepsBooks={keepsBooks} />}
      {tab === "payment" && <PaymentForm kind="customer" parties={customers} />}
      {tab === "statement" && <StatementView kind="customer" parties={customers} />}
      {tab === "aging" && <AgingView kind="customer" />}
    </>
  );
}

type Draft = {
  name: string;
  phone: string;
  taxRegistrationNumber: string;
  address: string;
  governate: string;
  regionCity: string;
  buildingNumber: string;
  priceLevel: PriceLevel;
  creditLimit: string;
  withholdingCategoryId: number | null;
};
const emptyDraft: Draft = {
  name: "",
  phone: "",
  taxRegistrationNumber: "",
  address: "",
  governate: "",
  regionCity: "",
  buildingNumber: "",
  priceLevel: "retail",
  creditLimit: "",
  withholdingCategoryId: null,
};
const draftOf = (c: Customer): Draft => ({
  name: c.name,
  phone: c.phone,
  taxRegistrationNumber: c.taxRegistrationNumber,
  address: c.address,
  governate: c.governate,
  regionCity: c.regionCity,
  buildingNumber: c.buildingNumber,
  priceLevel: c.priceLevel,
  creditLimit: c.creditLimit === null ? "" : formatMoney(c.creditLimit),
  withholdingCategoryId: c.withholdingCategoryId,
});

function CustomerList({ customers, onChange, keepsBooks }: { customers: Customer[]; onChange: () => Promise<void>; keepsBooks: boolean }) {
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editing, setEditing] = useState<number | null>(null);
  const [balances, setBalances] = useState<Record<number, number>>({});
  const [categories] = useWithholdingCategories();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all(customers.map((c) => business.customerBalance(c.id))).then((results) => {
      const next: Record<number, number> = {};
      results.forEach((r, i) => {
        if (r.ok) next[customers[i]!.id] = r.value;
      });
      setBalances(next);
    });
  }, [customers]);

  async function run(work: Promise<Result<unknown>>): Promise<boolean> {
    const result = await work;
    setError(errorText(result));
    if (result.ok) await onChange();
    return result.ok;
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const limit = draft.creditLimit.trim() === "" ? null : parseMoney(draft.creditLimit);
    if (draft.creditLimit.trim() !== "" && limit === null) {
      setError(ar.errors["credit_limit_invalid"]!);
      return;
    }
    const input: CustomerInput = { ...draft, creditLimit: limit };
    const ok = editing === null ? await run(business.addCustomer(input)) : await run(business.updateCustomer(editing, input));
    if (ok) {
      setDraft(emptyDraft);
      setEditing(null);
    }
  }

  return (
    <>
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      <form className="card" onSubmit={save} aria-label={ar.customers.add}>
        <div className="row">
          <label className="field">
            {ar.customers.name}
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className="field narrow">
            {ar.customers.phone}
            <input dir="ltr" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
          </label>
          <label className="field narrow">
            {ar.customers.taxRegistrationNumber}
            <FieldHelp field="customerTaxNumber" />
            <input dir="ltr" value={draft.taxRegistrationNumber} onChange={(e) => setDraft({ ...draft, taxRegistrationNumber: e.target.value })} />
          </label>
        </div>
        {keepsBooks && (
          <div className="row">
            <label className="field">
              {ar.customers.address}
              <input value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} />
            </label>
            <label className="field narrow">
              {ar.customers.priceLevel}
              <select value={draft.priceLevel} onChange={(e) => setDraft({ ...draft, priceLevel: e.target.value as PriceLevel })}>
                <option value="retail">{ar.customers.priceLevels.retail}</option>
                <option value="wholesale">{ar.customers.priceLevels.wholesale}</option>
              </select>
            </label>
            <label className="field narrow">
              {ar.customers.creditLimit}
              <FieldHelp field="customerCreditLimit" />
              <input
                dir="ltr"
                inputMode="decimal"
                placeholder={ar.customers.noLimit}
                value={draft.creditLimit}
                onChange={(e) => setDraft({ ...draft, creditLimit: e.target.value })}
              />
            </label>
            <label className="field narrow">
              {ar.withholding.category}
              <WithholdingSelect categories={categories} value={draft.withholdingCategoryId} onChange={(id) => setDraft({ ...draft, withholdingCategoryId: id })} />
            </label>
          </div>
        )}
        {keepsBooks && (
          <div className="row" aria-label={ar.customers.etaAddress}>
            <label className="field narrow">
              {ar.customers.governate}
              <input value={draft.governate} onChange={(e) => setDraft({ ...draft, governate: e.target.value })} />
            </label>
            <label className="field narrow">
              {ar.customers.regionCity}
              <input value={draft.regionCity} onChange={(e) => setDraft({ ...draft, regionCity: e.target.value })} />
            </label>
            <label className="field narrow">
              {ar.customers.buildingNumber}
              <input value={draft.buildingNumber} onChange={(e) => setDraft({ ...draft, buildingNumber: e.target.value })} />
            </label>
            <span className="small muted">{ar.customers.etaAddress}</span>
          </div>
        )}
        <div className="row">
          <button type="submit" className="btn btn-primary">
            {editing === null ? ar.customers.add : ar.save}
          </button>
          {editing !== null && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setEditing(null);
                setDraft(emptyDraft);
              }}
            >
              {ar.cancel}
            </button>
          )}
        </div>
      </form>
      <section className="table-card" aria-label={ar.customers.tabs.customers}>
        {customers.length === 0 ? (
          <p className="muted empty">{ar.customers.none}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{ar.customers.name}</th>
                <th className="col-type">{ar.customers.phone}</th>
                <th className="col-type">{ar.customers.taxRegistrationNumber}</th>
                <th className="col-type">{ar.customers.priceLevel}</th>
                <th className="col-money">{ar.customers.creditLimit}</th>
                <th className="col-money">{ar.customers.balance}</th>
                {keepsBooks && <th className="col-actions" />}
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id} className={c.active ? undefined : "inactive"}>
                  <td>
                    {c.name}
                    {!c.active && <span className="chip chip-warn">{ar.customers.stopped}</span>}
                    {c.address && <div className="muted small">{c.address}</div>}
                  </td>
                  <td className="muted" dir="ltr">
                    {c.phone}
                  </td>
                  <td className="muted" dir="ltr">
                    {c.taxRegistrationNumber}
                  </td>
                  <td className="muted">{ar.customers.priceLevels[c.priceLevel]}</td>
                  <td className="num muted">{c.creditLimit === null ? "—" : formatMoney(c.creditLimit)}</td>
                  <td className="num">{balances[c.id] !== undefined && formatMoney(balances[c.id]!)}</td>
                  {keepsBooks && (
                    <td>
                      <div className="actions">
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() => {
                            setEditing(c.id);
                            setDraft(draftOf(c));
                          }}
                        >
                          {ar.edit}
                        </button>
                        {c.active ? (
                          <button type="button" className="btn btn-small" onClick={() => run(business.deactivateCustomer(c.id))}>
                            {ar.customers.stop}
                          </button>
                        ) : (
                          <button type="button" className="btn btn-small" onClick={() => run(business.reactivateCustomer(c.id))}>
                            {ar.customers.restart}
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
