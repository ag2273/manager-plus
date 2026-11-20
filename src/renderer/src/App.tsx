import { useEffect, useState, type FormEvent } from "react";
import type { BusinessSettings, Result } from "../../shared/api";
import { ar } from "./strings";

const blank: BusinessSettings = {
  name: "",
  address: "",
  taxRegistrationNumber: "",
  vatRegistered: true,
  fiscalYearStartMonth: 1,
};

function errorText(result: Result<unknown>): string | null {
  if (result.ok) return null;
  return ar.errors[result.code] ?? ar.errors["unexpected"]!;
}

export function App() {
  const [draft, setDraft] = useState(blank);
  const [open, setOpen] = useState<BusinessSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => {
    void window.api.recentFiles().then(setRecent);
  }, [open]);

  function handle(result: Result<BusinessSettings | null>) {
    setError(errorText(result));
    if (result.ok && result.value) setOpen(result.value);
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    handle(await window.api.createBusiness(draft));
  }

  if (open) {
    return (
      <main className="page">
        <h1>{open.name}</h1>
        <div className="card">
          <span className="muted">{ar.opened}</span>
          <span>{open.address}</span>
          {open.taxRegistrationNumber && <span>{open.taxRegistrationNumber}</span>}
        </div>
      </main>
    );
  }

  return (
    <main className="page">
      <h1>
        <span dir="ltr">{ar.appName}</span>
      </h1>
      <p className="muted">{ar.welcome}</p>
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      <form className="card" onSubmit={create}>
        <h2>{ar.newBusiness}</h2>
        <div className="row">
          <label className="field">
            {ar.name}
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className="field">
            {ar.address}
            <input value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} />
          </label>
        </div>
        <div className="row">
          <label className="field">
            {ar.taxRegistrationNumber}
            <input
              inputMode="numeric"
              value={draft.taxRegistrationNumber}
              onChange={(e) => setDraft({ ...draft, taxRegistrationNumber: e.target.value })}
            />
          </label>
          <label className="field">
            {ar.fiscalYearStartMonth}
            <input
              type="number"
              min={1}
              max={12}
              value={draft.fiscalYearStartMonth}
              onChange={(e) => setDraft({ ...draft, fiscalYearStartMonth: Number(e.target.value) })}
            />
          </label>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.vatRegistered}
            onChange={(e) => setDraft({ ...draft, vatRegistered: e.target.checked })}
          />
          {ar.vatRegistered}
        </label>
        <div className="row">
          <button type="submit" className="btn btn-primary">
            {ar.create}
          </button>
          <button type="button" className="btn" onClick={async () => handle(await window.api.openBusiness())}>
            {ar.openFile}
          </button>
        </div>
      </form>
      {recent.length > 0 && (
        <section className="card">
          <h2>{ar.recent}</h2>
          {recent.map((path) => (
            <button key={path} type="button" className="recent" onClick={async () => handle(await window.api.openBusiness(path))}>
              {path}
            </button>
          ))}
        </section>
      )}
    </main>
  );
}
