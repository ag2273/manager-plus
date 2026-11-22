import { useEffect, useState, type FormEvent } from "react";
import { DEFAULT_PREFERENCES, NO_PRINTER, THEMES, type Connection, type Preferences, type PrinterSettings, type ServerStatus, type ThemeId } from "../../../shared/api";
import type { BackupStatus } from "../../../core/backup";
import type { EtaSettings } from "../../../core/eta/store";
import type { EtaReceiptSettings } from "../../../core/eta/receipts-store";
import type { LicenceMode } from "../../../core/business";
import type { LicenceStatus } from "../../../core/licence/licence";
import type { TokenCertificate } from "../../../shared/api";
import type { BusinessSettings } from "../../../shared/api";
import { business, errorText } from "../api";
import { ar, locale } from "../strings";

/** Appearance settings: the theme picker from the approved design. */
export function Settings({
  theme,
  onTheme,
  onLanguage,
  isManager,
  onRestored,
}: {
  theme: ThemeId;
  onTheme: (theme: ThemeId) => void;
  onLanguage: (p: Pick<Preferences, "screenLanguage" | "digits">) => void;
  isManager: boolean;
  onRestored: (settings: BusinessSettings) => void;
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
      <LicenceSetup />
      <LanguageSetup onLanguage={onLanguage} />
      <PrinterSetup />
      <ServerSetup />
      {isManager && <BackupSetup onRestored={onRestored} />}
      {isManager && <EtaSetup />}
      {isManager && <EtaReceiptSetup />}
    </>
  );
}

type LanguagePrefs = Pick<Preferences, "screenLanguage" | "documentLanguage" | "digits">;

/** Screen language, document language and digits: each saved at once, for this PC. */
function LanguageSetup({ onLanguage }: { onLanguage: (p: Pick<Preferences, "screenLanguage" | "digits">) => void }) {
  const [prefs, setPrefs] = useState<LanguagePrefs>(DEFAULT_PREFERENCES);
  useEffect(() => {
    void window.api.preferences().then(setPrefs);
  }, []);

  function change(next: Partial<LanguagePrefs>) {
    const all = { ...prefs, ...next };
    setPrefs(all);
    void window.api.setPreferences(next).then(() => {
      if (next.screenLanguage || next.digits) onLanguage(all);
    });
  }

  const languages = [
    { value: "ar", label: "العربية" },
    { value: "en", label: "English" },
  ] as const;
  const group = (label: string, value: string, options: readonly { value: string; label: string }[], pick: (v: string) => void) => (
    <div className="field">
      <span>{label}</span>
      <div role="radiogroup" aria-label={label} className="pills">
        {options.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className="pill" onClick={() => pick(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <section className="card printer-card" aria-label={ar.settings.language}>
      <div className="stack">
        <h2>{ar.settings.language}</h2>
        <span className="muted">{ar.settings.languageHint}</span>
      </div>
      {group(ar.settings.screenLanguage, prefs.screenLanguage, languages, (v) => change({ screenLanguage: v as LanguagePrefs["screenLanguage"] }))}
      {group(ar.settings.documentLanguage, prefs.documentLanguage, languages, (v) => change({ documentLanguage: v as LanguagePrefs["documentLanguage"] }))}
      {group(
        ar.settings.digits,
        prefs.digits,
        (["western", "arabic"] as const).map((d) => ({ value: d, label: ar.settings.digitStyles[d] })),
        (v) => change({ digits: v as LanguagePrefs["digits"] }),
      )}
    </section>
  );
}

/** The backup folder, backing up now, and restoring a backup; on the PC that holds the file. */
function BackupSetup({ onRestored }: { onRestored: (settings: BusinessSettings) => void }) {
  const [local, setLocal] = useState(false);
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  async function reload() {
    const result = await business.backupStatus();
    if (result.ok) setStatus(result.value);
  }

  useEffect(() => {
    void window.api.fileStatus().then((f) => {
      setLocal(f !== null);
      if (f) void reload();
    });
  }, []);

  async function chooseFolder() {
    const folder = await window.api.chooseFolder();
    if (!folder) return;
    const result = await business.setBackupFolder(folder);
    setMessage(result.ok ? null : { ok: false, text: errorText(result)! });
    await reload();
  }

  async function backup() {
    const result = await business.backupNow();
    setMessage(result.ok ? { ok: true, text: ar.backup.done(result.value.name) } : { ok: false, text: errorText(result)! });
    await reload();
  }

  async function restore(path: string | null) {
    if (path !== null && confirming !== path) {
      setConfirming(path);
      return;
    }
    setConfirming(null);
    const result = await window.api.restoreBackup(path);
    if (!result.ok) setMessage({ ok: false, text: errorText(result)! });
    else if (result.value) onRestored(result.value);
  }

  if (!local || !status) return null;
  const when = (iso: string) => new Date(iso).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" });
  return (
    <section className="card printer-card" aria-label={ar.backup.title}>
      <div className="stack">
        <h2>{ar.backup.title}</h2>
        <span className="muted">{ar.backup.hint}</span>
      </div>
      {message && (
        <div role={message.ok ? "status" : "alert"} className={message.ok ? "ok" : "error"}>
          {message.text}
        </div>
      )}
      <dl className="server-facts">
        <dt>{ar.backup.folder}</dt>
        <dd dir="ltr">{status.folder ?? ar.backup.noFolder}</dd>
        <dt>{ar.backup.last}</dt>
        <dd>{status.lastBackupAt ? when(status.lastBackupAt) : ar.backup.never}</dd>
      </dl>
      <div className="row">
        <button type="button" className="btn" onClick={() => void chooseFolder()}>
          {ar.backup.chooseFolder}
        </button>
        <button type="button" className="btn btn-primary" disabled={!status.folder} onClick={() => void backup()}>
          {ar.backup.now}
        </button>
        <button type="button" className="btn" onClick={() => void restore(null)}>
          {ar.backup.restoreOther}
        </button>
      </div>
      {status.backups.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>{ar.backup.when}</th>
              <th className="col-money">{ar.backup.size}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {status.backups.map((b) => (
              <tr key={b.path}>
                <td>{when(b.at)}</td>
                <td className="num">{(b.size / 1024 / 1024).toFixed(1)} MB</td>
                <td>
                  <button type="button" className="btn btn-small" onClick={() => void restore(b.path)}>
                    {confirming === b.path ? ar.backup.confirmRestore : ar.backup.restore}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
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

/** E-invoicing with the ETA: off unless turned on; set up by a manager on the PC that holds the file and the token. */
function EtaSetup() {
  const [local, setLocal] = useState(false);
  const [settings, setSettings] = useState<EtaSettings | null>(null);
  const [secret, setSecret] = useState("");
  const [certificates, setCertificates] = useState<TokenCertificate[]>([]);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function loadCertificates() {
    setCertificates(await window.api.etaCertificates());
  }
  useEffect(() => {
    void window.api.fileStatus().then((f) => setLocal(f !== null));
    void business.etaSettings().then((r) => r.ok && setSettings(r.value));
    void loadCertificates();
  }, []);
  if (!settings) return null;
  const s = settings;
  const set = (changes: Partial<EtaSettings>) => setSettings({ ...s, ...changes });
  const setAddress = (changes: Partial<EtaSettings["address"]>) => set({ address: { ...s.address, ...changes } });

  async function save(event: FormEvent) {
    event.preventDefault();
    const input = {
      enabled: s.enabled,
      environment: s.environment,
      clientId: s.clientId,
      activityCode: s.activityCode,
      address: s.address,
      certificate: s.certificate,
    };
    const result = await window.api.saveEtaSettings(secret.trim() ? { ...input, clientSecret: secret } : input);
    setMessage(result.ok ? { ok: true, text: ar.eta.saved } : { ok: false, text: errorText(result)! });
    if (result.ok) {
      setSecret("");
      void business.etaSettings().then((r) => r.ok && setSettings(r.value));
    }
  }

  async function sendNow() {
    const result = await window.api.sendEtaNow();
    setMessage(result.ok ? { ok: true, text: ar.eta.sent(result.value) } : { ok: false, text: errorText(result)! });
  }

  const text = (label: string, value: string, change: (v: string) => void, ltr = false) => (
    <label className="field narrow">
      {label}
      <input dir={ltr ? "ltr" : undefined} value={value} disabled={!local} onChange={(e) => change(e.target.value)} />
    </label>
  );

  return (
    <form className="card printer-card" onSubmit={save} aria-label={ar.eta.title}>
      <div className="stack">
        <h2>{ar.eta.title}</h2>
        <span className="muted">{local ? ar.eta.hint : ar.eta.localOnly}</span>
      </div>
      {message && (
        <div role={message.ok ? "status" : "alert"} className={message.ok ? "ok" : "error"}>
          {message.text}
        </div>
      )}
      <label className="check">
        <input type="checkbox" checked={s.enabled} disabled={!local} onChange={(e) => set({ enabled: e.target.checked })} />
        {ar.eta.enabled}
      </label>
      {s.enabled && (
        <>
          <div className="row">
            <label className="field narrow">
              {ar.eta.environment}
              <select value={s.environment} disabled={!local} onChange={(e) => set({ environment: e.target.value as EtaSettings["environment"] })}>
                <option value="preprod">{ar.eta.environments.preprod}</option>
                <option value="production">{ar.eta.environments.production}</option>
              </select>
            </label>
            {text(ar.eta.clientId, s.clientId, (v) => set({ clientId: v }), true)}
            <label className="field narrow">
              {ar.eta.clientSecret}
              <input
                dir="ltr"
                type="password"
                autoComplete="off"
                value={secret}
                disabled={!local}
                placeholder={s.hasSecret ? ar.eta.secretKept : ""}
                onChange={(e) => setSecret(e.target.value)}
              />
            </label>
            {text(ar.eta.activityCode, s.activityCode, (v) => set({ activityCode: v }), true)}
          </div>
          <span className="small muted">{ar.eta.issuerAddress}</span>
          <div className="row">
            {text(ar.eta.governate, s.address.governate, (v) => setAddress({ governate: v }))}
            {text(ar.eta.regionCity, s.address.regionCity, (v) => setAddress({ regionCity: v }))}
            {text(ar.eta.street, s.address.street, (v) => setAddress({ street: v }))}
            {text(ar.eta.buildingNumber, s.address.buildingNumber, (v) => setAddress({ buildingNumber: v }))}
          </div>
          <div className="row">
            <label className="field">
              {ar.eta.certificate}
              <select value={s.certificate} disabled={!local} onChange={(e) => set({ certificate: e.target.value })}>
                <option value="">{certificates.length === 0 ? ar.eta.noCertificates : "—"}</option>
                {certificates.map((c) => (
                  <option key={c.thumbprint} value={c.thumbprint}>
                    {c.subject} · {c.notAfter}
                  </option>
                ))}
                {s.certificate && !certificates.some((c) => c.thumbprint === s.certificate) && <option value={s.certificate}>{s.certificate}</option>}
              </select>
            </label>
            <button type="button" className="btn" disabled={!local} onClick={() => void loadCertificates()}>
              {ar.eta.refresh}
            </button>
          </div>
        </>
      )}
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={!local}>
          {ar.save}
        </button>
        {s.enabled && (
          <button type="button" className="btn" disabled={!local} onClick={() => void sendNow()}>
            {ar.eta.sendNow}
          </button>
        )}
      </div>
    </form>
  );
}

/** The POS registration for e-receipts, on top of e-invoicing's account and address. */
function EtaReceiptSetup() {
  const [local, setLocal] = useState(false);
  const [invoicing, setInvoicing] = useState(false);
  const [settings, setSettings] = useState<EtaReceiptSettings | null>(null);
  const [secrets, setSecrets] = useState({ posClientSecret: "", presharedKey: "" });
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const t = ar.eta.receipts;

  function load() {
    void business.etaSettings().then((r) => r.ok && setInvoicing(r.value.enabled));
    void business.etaReceiptSettings().then((r) => r.ok && setSettings(r.value));
  }
  useEffect(() => {
    void window.api.fileStatus().then((f) => setLocal(f !== null));
    load();
  }, []);
  if (!settings) return null;
  const s = settings;
  const set = (changes: Partial<EtaReceiptSettings>) => setSettings({ ...s, ...changes });

  async function save(event: FormEvent) {
    event.preventDefault();
    const input = {
      enabled: s.enabled,
      posSerial: s.posSerial,
      posOsVersion: s.posOsVersion,
      posModel: s.posModel,
      posClientId: s.posClientId,
      ...(secrets.posClientSecret.trim() ? { posClientSecret: secrets.posClientSecret } : {}),
      ...(secrets.presharedKey.trim() ? { presharedKey: secrets.presharedKey } : {}),
    };
    const result = await window.api.saveEtaReceiptSettings(input);
    setMessage(result.ok ? { ok: true, text: t.saved } : { ok: false, text: errorText(result)! });
    if (result.ok) {
      setSecrets({ posClientSecret: "", presharedKey: "" });
      load();
    }
  }

  const field = (label: string, value: string, change: (v: string) => void, secret = false) => (
    <label className="field narrow">
      {label}
      <input
        dir="ltr"
        type={secret ? "password" : "text"}
        autoComplete="off"
        value={value}
        disabled={!local}
        placeholder={secret && s.hasPosSecrets ? ar.eta.secretKept : ""}
        onChange={(e) => change(e.target.value)}
      />
    </label>
  );

  return (
    <form className="card printer-card" onSubmit={save} aria-label={t.title}>
      <div className="stack">
        <h2>{t.title}</h2>
        <span className="muted">{!local ? ar.eta.localOnly : invoicing ? t.hint : t.needsInvoicing}</span>
      </div>
      {message && (
        <div role={message.ok ? "status" : "alert"} className={message.ok ? "ok" : "error"}>
          {message.text}
        </div>
      )}
      <label className="check">
        <input type="checkbox" checked={s.enabled} disabled={!local || (!invoicing && !s.enabled)} onChange={(e) => set({ enabled: e.target.checked })} />
        {t.enabled}
      </label>
      {s.enabled && (
        <div className="row">
          {field(t.posSerial, s.posSerial, (v) => set({ posSerial: v }))}
          {field(t.posOsVersion, s.posOsVersion, (v) => set({ posOsVersion: v }))}
          {field(t.posModel, s.posModel, (v) => set({ posModel: v }))}
          {field(t.posClientId, s.posClientId, (v) => set({ posClientId: v }))}
          {field(t.posClientSecret, secrets.posClientSecret, (v) => setSecrets({ ...secrets, posClientSecret: v }), true)}
          {field(t.presharedKey, secrets.presharedKey, (v) => setSecrets({ ...secrets, presharedKey: v }), true)}
        </div>
      )}
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={!local}>
          {ar.save}
        </button>
      </div>
    </form>
  );
}

/** The licence on this PC: what it covers, and activating a key. */
function LicenceSetup() {
  const [status, setStatus] = useState<LicenceStatus | null | undefined>(undefined);
  const [mode, setMode] = useState<LicenceMode | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const t = ar.licence;

  function load() {
    void window.api.licenceStatus().then(setStatus);
    void business.licenceMode().then((r) => r.ok && setMode(r.value));
  }
  useEffect(load, []);
  if (status === undefined) return null;

  async function activate(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const result = await window.api.activateLicence(key);
    setBusy(false);
    setMessage(result.ok ? { ok: true, text: t.activated } : { ok: false, text: errorText(result)! });
    if (result.ok) {
      setKey("");
      load();
    }
  }

  const date = (iso: string) => new Date(iso).toLocaleDateString(locale());
  const summary =
    status === null
      ? t.onClient
      : status.mode === "trial"
        ? t.statusTrial(status.daysLeft, date(status.trialEndsAt))
        : status.mode === "licensed"
          ? t.statusLicensed(status.company, status.users, date(status.supportUntil))
          : t.readOnly[status.reason];

  return (
    <form className="card printer-card" onSubmit={activate} aria-label={t.title}>
      <div className="stack">
        <h2>{t.title}</h2>
        <span>{summary}</span>
        {mode?.users != null && <span className="muted small">{t.users(mode.signedIn, mode.users)}</span>}
        {status !== null && <span className="muted small">{t.hint}</span>}
      </div>
      {message && (
        <div role={message.ok ? "status" : "alert"} className={message.ok ? "ok" : "error"}>
          {message.text}
        </div>
      )}
      {status !== null && (
        <div className="row">
          <label className="field">
            {t.key}
            <input dir="ltr" autoComplete="off" value={key} placeholder="XXXX-XXXX-XXXX-XXXX" onChange={(e) => setKey(e.target.value)} />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy || key.trim() === ""}>
            {t.activate}
          </button>
        </div>
      )}
    </form>
  );
}
