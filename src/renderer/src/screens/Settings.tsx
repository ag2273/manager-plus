import { useEffect, useState, type FormEvent } from "react";
import { NO_PRINTER, THEMES, type Connection, type PrinterSettings, type ServerStatus, type ThemeId } from "../../../shared/api";
import { errorText } from "../api";
import { ar } from "../strings";

/** Appearance settings: the theme picker from the approved design. */
export function Settings({
  theme,
  onTheme,
}: {
  theme: ThemeId;
  onTheme: (theme: ThemeId) => void;
}) {
  return (
    <>
      <header className="screen-head">
        <div>
          <h1>{ar.settings.appearance}</h1>
          <span className="muted">{ar.settings.appearanceHint}</span>
        </div>
      </header>
      <section aria-label={ar.settings.themes} className="themes">
        {THEMES.map((id) => (
          <button
            key={id}
            type="button"
            className="theme-card"
            aria-pressed={id === theme}
            onClick={() => onTheme(id)}
          >
            <div aria-hidden="true" className="theme-preview" data-theme={id}>
              <div className="tp-side">
                <i className="tp-soft" />
                <i />
                <i />
              </div>
              <div className="tp-main">
                <div className="tp-row">
                  <i />
                  <i />
                </div>
                <i className="tp-panel" />
                <i className="tp-accent" />
              </div>
            </div>
            <div className="theme-meta">
              <div>
                <strong>{ar.themes[id].name}</strong>
                <span className="muted">{ar.themes[id].desc}</span>
              </div>
              <span aria-hidden="true" className="swatches" data-theme={id}>
                <i className="sw-accent" />
                <i className="sw-soft" />
                <i className="sw-bg" />
              </span>
            </div>
            {id === theme && <span className="badge">{ar.settings.inUse}</span>}
          </button>
        ))}
      </section>
      <PrinterSetup />
      <ServerSetup />
    </>
  );
}

type Kind = PrinterSettings["kind"];
const KINDS: Kind[] = ["none", "windows", "network"];

/** Receipt printer of this computer: a Windows printer or an 80 mm printer on the network. */
function PrinterSetup() {
  const [printer, setPrinter] = useState<PrinterSettings>(NO_PRINTER);
  const [installed, setInstalled] = useState<string[]>([]);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void window.api.preferences().then((p) => setPrinter(p.printer));
    void window.api.printers().then(setInstalled);
  }, []);

  function choose(kind: Kind) {
    const footer = printer.kind === "none" ? "" : printer.footer;
    if (kind === "none") setPrinter(NO_PRINTER);
    if (kind === "windows") setPrinter({ kind, deviceName: installed[0] ?? "", autoPrint: true, footer });
    if (kind === "network") setPrinter({ kind, host: "", port: 9100, openDrawer: true, autoPrint: true, footer });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    await window.api.setPreferences({ printer });
    setMessage({ ok: true, text: ar.printer.saved });
  }

  async function test() {
    await window.api.setPreferences({ printer });
    const result = await window.api.print({ kind: "test" });
    setMessage(result.ok ? { ok: true, text: ar.printer.testSent } : { ok: false, text: errorText(result)! });
  }

  return (
    <form className="card printer-card" onSubmit={save} aria-label={ar.printer.title}>
      <div className="stack">
        <h2>{ar.printer.title}</h2>
        <span className="muted">{ar.printer.hint}</span>
      </div>
      {message && (
        <div role={message.ok ? "status" : "alert"} className={message.ok ? "ok" : "error"}>
          {message.text}
        </div>
      )}
      <div role="radiogroup" aria-label={ar.printer.kind} className="pills">
        {KINDS.map((k) => (
          <button key={k} type="button" role="radio" aria-checked={printer.kind === k} className="pill" onClick={() => choose(k)}>
            {ar.printer.kinds[k]}
          </button>
        ))}
      </div>
      {printer.kind === "windows" && (
        <label className="field">
          {ar.printer.device}
          <select value={printer.deviceName} onChange={(e) => setPrinter({ ...printer, deviceName: e.target.value })}>
            {installed.length === 0 && <option value="">{ar.printer.noneInstalled}</option>}
            {installed.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <span className="small">{ar.printer.windowsDrawer}</span>
        </label>
      )}
      {printer.kind === "network" && (
        <div className="row">
          <label className="field">
            {ar.printer.host}
            <input dir="ltr" value={printer.host} placeholder="192.168.1.50" onChange={(e) => setPrinter({ ...printer, host: e.target.value })} />
          </label>
          <label className="field narrow">
            {ar.printer.port}
            <input
              dir="ltr"
              inputMode="numeric"
              value={String(printer.port)}
              onChange={(e) => setPrinter({ ...printer, port: Number(e.target.value) || 0 })}
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={printer.openDrawer} onChange={(e) => setPrinter({ ...printer, openDrawer: e.target.checked })} />
            {ar.printer.openDrawer}
          </label>
        </div>
      )}
      {printer.kind !== "none" && (
        <>
          <label className="check">
            <input type="checkbox" checked={printer.autoPrint} onChange={(e) => setPrinter({ ...printer, autoPrint: e.target.checked })} />
            {ar.printer.autoPrint}
          </label>
          <label className="field">
            {ar.printer.footer}
            <textarea rows={2} value={printer.footer} onChange={(e) => setPrinter({ ...printer, footer: e.target.value })} />
          </label>
        </>
      )}
      <div className="row">
        <button type="submit" className="btn btn-primary">
          {ar.save}
        </button>
        {printer.kind !== "none" && (
          <button type="button" className="btn" onClick={() => void test()}>
            {ar.printer.test}
          </button>
        )}
      </div>
    </form>
  );
}

/** Serving the open file to other PCs (ADR 0002), or which server this PC is a client of. */
function ServerSetup() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [port, setPort] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.api.connection().then(setConnection);
    void window.api.serverStatus().then((s) => {
      setStatus(s);
      setPort(String(s.port));
    });
    const timer = setInterval(() => void window.api.serverStatus().then(setStatus), 5_000);
    return () => clearInterval(timer);
  }, []);

  async function toggle(on: boolean) {
    const result = await window.api.setServing(on, Number(port));
    setError(errorText(result));
    if (result.ok) setStatus(result.value);
  }

  if (!connection || !status) return null;
  if (connection.mode === "client") {
    return (
      <section className="card printer-card" aria-label={ar.network.title}>
        <h2>{ar.network.title}</h2>
        <div role="status" className="ok">
          {ar.network.connectedTo(connection.name, connection.host, connection.port)}
        </div>
      </section>
    );
  }
  return (
    <section className="card printer-card" aria-label={ar.network.serverTitle}>
      <div className="stack">
        <h2>{ar.network.serverTitle}</h2>
        <span className="muted">{ar.network.serverHint}</span>
      </div>
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      <div role="status" className={status.serving ? "ok" : "muted"}>
        {status.serving ? ar.network.running : ar.network.stopped}
        {status.serving && ` · ${ar.network.clients(status.clients)}`}
      </div>
      {status.serving && (
        <dl className="server-facts">
          <dt>{ar.network.addresses}</dt>
          <dd dir="ltr">{status.addresses.map((a) => `${a}:${status.port}`).join("  ")}</dd>
          <dt>{ar.network.fingerprint}</dt>
          <dd dir="ltr">{status.fingerprint}</dd>
        </dl>
      )}
      <div className="row">
        <label className="field narrow">
          {ar.network.port}
          <input dir="ltr" inputMode="numeric" disabled={status.serving} value={port} onChange={(e) => setPort(e.target.value)} />
        </label>
        {status.serving ? (
          <button type="button" className="btn" onClick={() => void toggle(false)}>
            {ar.network.stop}
          </button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={() => void toggle(true)}>
            {ar.network.serve}
          </button>
        )}
      </div>
      <span className="small muted">{ar.network.managerOnly}</span>
    </section>
  );
}
