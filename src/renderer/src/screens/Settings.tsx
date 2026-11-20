import { useEffect, useState, type FormEvent } from "react";
import { NO_PRINTER, THEMES, type PrinterSettings, type ThemeId } from "../../../shared/api";
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
