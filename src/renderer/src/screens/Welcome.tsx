import { useEffect, useState, type FormEvent } from "react";
import type { BusinessSettings, FoundServer, Result } from "../../../shared/api";
import { errorText } from "../api";
import { ar } from "../strings";

const blank: BusinessSettings = {
  name: "",
  address: "",
  taxRegistrationNumber: "",
  vatRegistered: true,
  fiscalYearStartMonth: 1,
};

/** Create a business file or open one; shown until a business is open. */
export function Welcome({
  onOpen,
}: {
  onOpen: (settings: BusinessSettings) => void;
}) {
  const [draft, setDraft] = useState(blank);
  const [manager, setManager] = useState({ name: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => {
    void window.api.recentFiles().then(setRecent);
  }, []);

  function handle(result: Result<BusinessSettings | null>) {
    setError(errorText(result));
    if (result.ok && result.value) onOpen(result.value);
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    handle(await window.api.createBusiness(draft, manager));
  }

  return (
    <main className="welcome">
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
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label className="field">
            {ar.address}
            <input
              value={draft.address}
              onChange={(e) => setDraft({ ...draft, address: e.target.value })}
            />
          </label>
        </div>
        <div className="row">
          <label className="field">
            {ar.taxRegistrationNumber}
            <input
              inputMode="numeric"
              value={draft.taxRegistrationNumber}
              onChange={(e) =>
                setDraft({ ...draft, taxRegistrationNumber: e.target.value })
              }
            />
          </label>
          <label className="field">
            {ar.fiscalYearStartMonth}
            <input
              type="number"
              min={1}
              max={12}
              value={draft.fiscalYearStartMonth}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  fiscalYearStartMonth: Number(e.target.value),
                })
              }
            />
          </label>
        </div>
        <h2>{ar.manager}</h2>
        <div className="row">
          <label className="field">
            {ar.managerName}
            <input
              value={manager.name}
              onChange={(e) => setManager({ ...manager, name: e.target.value })}
            />
          </label>
          <label className="field">
            {ar.password}
            <input
              type="password"
              placeholder={ar.passwordHint}
              value={manager.password}
              onChange={(e) =>
                setManager({ ...manager, password: e.target.value })
              }
            />
          </label>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.vatRegistered}
            onChange={(e) =>
              setDraft({ ...draft, vatRegistered: e.target.checked })
            }
          />
          {ar.vatRegistered}
        </label>
        <p className="muted" id="create-hint">
          {ar.createHint}
        </p>
        <div className="row">
          <button type="submit" className="btn btn-primary" aria-describedby="create-hint">
            {ar.create}
          </button>
          <button
            type="button"
            className="btn"
            onClick={async () => handle(await window.api.openBusiness())}
          >
            {ar.openFile}
          </button>
        </div>
      </form>
      <ServerConnect onConnected={handle} />
      {recent.length > 0 && (
        <section className="card">
          <h2>{ar.recent}</h2>
          {recent.map((path) => (
            <button
              key={path}
              type="button"
              className="link"
              dir="ltr"
              onClick={async () => handle(await window.api.openBusiness(path))}
            >
              {path}
            </button>
          ))}
        </section>
      )}
    </main>
  );
}

/** Finds servers on the network, or takes an address, and connects as a client. */
function ServerConnect({ onConnected }: { onConnected: (result: Result<BusinessSettings | null>) => void }) {
  const [found, setFound] = useState<FoundServer[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [last, setLast] = useState<FoundServer | null>(null);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("47100");

  useEffect(() => {
    void window.api.lastServer().then(setLast);
  }, []);

  async function search() {
    setSearching(true);
    setFound(await window.api.discoverServers());
    setSearching(false);
  }

  async function connect(to: { host: string; port: number }) {
    onConnected(await window.api.connectServer(to.host, to.port));
  }

  return (
    <section className="card" aria-label={ar.network.title}>
      <h2>{ar.network.title}</h2>
      <span className="muted">{ar.network.hint}</span>
      <div className="row">
        {last && (
          <button type="button" className="btn btn-primary" onClick={() => void connect(last)}>
            {ar.network.last(last.name)}
          </button>
        )}
        <button type="button" className="btn" disabled={searching} onClick={() => void search()}>
          {searching ? ar.network.searching : ar.network.search}
        </button>
      </div>
      {found && found.length === 0 && <p className="muted">{ar.network.none}</p>}
      {found?.map((s) => (
        <button key={`${s.host}:${s.port}`} type="button" className="link" onClick={() => void connect(s)}>
          {s.name} <span dir="ltr">({s.host}:{s.port})</span>
        </button>
      ))}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void connect({ host: host.trim(), port: Number(port) || 47100 });
        }}
      >
        <label className="field">
          {ar.network.host}
          <input dir="ltr" placeholder="192.168.1.10" value={host} onChange={(e) => setHost(e.target.value)} />
        </label>
        <label className="field narrow">
          {ar.network.port}
          <input dir="ltr" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
        </label>
        <button type="submit" className="btn">
          {ar.network.connect}
        </button>
      </form>
    </section>
  );
}
