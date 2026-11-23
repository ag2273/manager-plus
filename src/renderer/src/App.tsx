import { useEffect, useState } from "react";
import type { Role } from "../../shared/books/users";
import type { LicenceMode } from "../../shared/books/business";
import type { LicenceStatus } from "../../shared/books/licence/licence";
import type { BusinessSettings, FileStatus, Preferences, ThemeId, User } from "../../shared/api";
import { Accounts } from "./screens/Accounts";
import { AuditLog } from "./screens/AuditLog";
import { Home } from "./screens/Home";
import { SetupBanner } from "./screens/Setup";
import { Items } from "./screens/Items";
import { Money } from "./screens/Money";
import { Reports } from "./screens/Reports";
import { Settings } from "./screens/Settings";
import { SignIn } from "./screens/SignIn";
import { Users } from "./screens/Users";
import { Purchases } from "./screens/Purchases";
import { Customers } from "./screens/Customers";
import { SalesInvoices } from "./screens/SalesInvoices";
import { Till } from "./screens/Till";
import { Warehouses } from "./screens/Warehouses";
import { Welcome } from "./screens/Welcome";
import { setDigitStyle } from "../../shared/digits";
import { ar, locale, setScreenLanguage } from "./strings";
import { SERVER_BACK, SERVER_LOST, business } from "./api";

type Screen =
  | "home"
  | "till"
  | "items"
  | "warehouses"
  | "purchases"
  | "customers"
  | "salesInvoices"
  | "money"
  | "reports"
  | "accounts"
  | "users"
  | "audit"
  | "settings";

const ALL: Role[] = ["manager", "accountant", "cashier", "storekeeper"];

/**
 * Screens of the main menu and the roles that see them. The core checks every
 * command itself; this only hides what a role cannot use. Entries without a
 * screen yet are shown but disabled.
 */
const nav = (): { label: string; screen?: Screen; roles: Role[] }[] => [
  { label: ar.nav.home, screen: "home", roles: ALL },
  { label: ar.nav.till, screen: "till", roles: ["manager", "cashier"] },
  { label: ar.nav.items, screen: "items", roles: ALL },
  { label: ar.nav.warehouses, screen: "warehouses", roles: ["manager", "accountant", "storekeeper"] },
  { label: ar.nav.purchases, screen: "purchases", roles: ["manager", "accountant", "storekeeper"] },
  { label: ar.nav.salesInvoices, screen: "salesInvoices", roles: ["manager", "accountant"] },
  { label: ar.nav.customers, screen: "customers", roles: ["manager", "accountant", "cashier"] },
  { label: ar.nav.money, screen: "money", roles: ["manager", "accountant"] },
  {
    label: ar.nav.accounts,
    screen: "accounts",
    roles: ["manager", "accountant"],
  },
  { label: ar.nav.reports, screen: "reports", roles: ["manager", "accountant"] },
  { label: ar.nav.users, screen: "users", roles: ["manager"] },
  { label: ar.nav.audit, screen: "audit", roles: ["manager", "accountant"] },
  { label: ar.nav.settings, screen: "settings", roles: ALL },
];

/** Says so when another PC had this file open, which loses work when the file sits in a sync folder. */
function FileWarning() {
  const [status, setStatus] = useState<FileStatus | null>(null);
  useEffect(() => {
    void window.api.fileStatus().then(setStatus);
  }, []);
  if (!status?.openElsewhere) return null;
  const since = new Date(status.openElsewhere.at).toLocaleString(locale(), { timeStyle: "short", dateStyle: "short" });
  return (
    <div role="alert" className="error">
      {ar.backup.openElsewhere(status.openElsewhere.host, since)} {status.syncFolder && ar.backup.inSyncFolder(status.syncFolder)}
    </div>
  );
}

export function App() {
  const [open, setOpen] = useState<BusinessSettings | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [screen, setScreen] = useState<Screen>("home");
  // Bumped when the first steps finish, so the banner reads the setup again.
  const [setupRound, setSetupRound] = useState(0);
  const [theme, setTheme] = useState<ThemeId>("calm");
  const [languageKey, setLanguageKey] = useState("ar-western");
  const [serverLost, setServerLost] = useState(false);

  // A client PC whose server went away says so on every screen and keeps trying.
  useEffect(() => {
    const lost = () => setServerLost(true);
    const back = () => setServerLost(false);
    window.addEventListener(SERVER_LOST, lost);
    window.addEventListener(SERVER_BACK, back);
    return () => {
      window.removeEventListener(SERVER_LOST, lost);
      window.removeEventListener(SERVER_BACK, back);
    };
  }, []);

  useEffect(() => {
    if (!serverLost) return;
    const timer = setInterval(() => void business.settings(), 5_000);
    return () => clearInterval(timer);
  }, [serverLost]);

  useEffect(() => {
    void window.api.preferences().then((p) => {
      setTheme(p.theme);
      chooseLanguage(p);
    });
  }, []);

  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
  }, [theme]);

  /** Applies the screen language and digits; every screen reads them on render, so the shell re-renders under a new key. */
  function chooseLanguage(p: Pick<Preferences, "screenLanguage" | "digits">) {
    setScreenLanguage(p.screenLanguage);
    setDigitStyle(p.digits);
    setLanguageKey(`${p.screenLanguage}-${p.digits}`);
  }

  function chooseTheme(next: ThemeId) {
    setTheme(next);
    void window.api.setPreferences({ theme: next });
  }

  async function opened(settings: BusinessSettings) {
    setOpen(settings);
    setScreen("home");
    // A newly created business comes back with its first manager already signed in.
    const me = await window.api.call("currentUser", []);
    setUser(me.ok ? (me.value as User | null) : null);
  }

  async function signOut() {
    await window.api.signOut();
    setUser(null);
  }

  if (!open) return <Welcome key={languageKey} onOpen={opened} />;
  if (!user)
    return (
      <SignIn
        key={languageKey}
        settings={open}
        onSignedIn={(u) => {
          setUser(u);
          setScreen("home");
        }}
        onOtherFile={() => setOpen(null)}
      />
    );

  return (
    <div className="shell" key={languageKey}>
      <nav aria-label={ar.nav.label} className="sidebar">
        <strong className="brand" dir="ltr">
          {ar.appName}
        </strong>
        <span className="muted business-name">{open.name}</span>
        {nav().filter((item) => item.roles.includes(user.role)).map((item) =>
          item.screen ? (
            <button
              key={item.label}
              type="button"
              className="nav-item"
              aria-current={item.screen === screen ? "page" : undefined}
              onClick={() => item.screen && setScreen(item.screen)}
            >
              {item.label}
            </button>
          ) : (
            <span
              key={item.label}
              className="nav-item nav-soon"
              title={ar.nav.soon}
            >
              {item.label}
              <small>{ar.nav.soon}</small>
            </span>
          ),
        )}
        <div className="sidebar-foot">
          <span>{user.name}</span>
          <span className="muted small">{ar.roles[user.role]}</span>
          <button type="button" className="link" onClick={signOut}>
            {ar.signIn.signOut}
          </button>
        </div>
      </nav>
      <main className="content">
        <LicenceBanner key={screen} onActivate={() => setScreen("settings")} />
        {serverLost && (
          <div role="alert" className="error server-lost">
            {ar.errors["server_unreachable"]}{" "}
            <button type="button" className="link" onClick={() => void business.settings()}>
              {ar.network.retry}
            </button>
          </div>
        )}
        <FileWarning />
        {screen !== "home" && <SetupBanner key={`setup-${screen}-${setupRound}`} screenKey={screen} onOpen={() => setScreen("home")} />}
        {screen === "home" && (
          <Home
            settings={open}
            canKeepBooks={user.role === "manager" || user.role === "accountant"}
            isManager={user.role === "manager"}
            onGo={setScreen}
            onSetupFinished={() => setSetupRound((n) => n + 1)}
          />
        )}
        {screen === "items" && <Items canImport={user.role === "manager"} />}
        {screen === "till" && <Till />}
        {screen === "purchases" && <Purchases canSeeBalances={user.role === "manager" || user.role === "accountant"} />}
        {screen === "customers" && <Customers keepsBooks={user.role === "manager" || user.role === "accountant"} />}
        {screen === "salesInvoices" && <SalesInvoices />}
        {screen === "warehouses" && <Warehouses canChange={user.role === "manager" || user.role === "storekeeper"} />}
        {screen === "money" && <Money />}
        {screen === "accounts" && <Accounts />}
        {screen === "reports" && <Reports vatRegistered={open.vatRegistered} />}
        {screen === "users" && <Users me={user} />}
        {screen === "audit" && <AuditLog />}
        {screen === "settings" && (
          <Settings
            theme={theme}
            onTheme={chooseTheme}
            onLanguage={chooseLanguage}
            isManager={user.role === "manager"}
            onRestored={(settings) => {
              setOpen(settings);
              setUser(null);
            }}
          />
        )}
      </main>
    </div>
  );
}

/** Says on every screen when the trial is running or the app is read-only, with the way to activate. */
function LicenceBanner({ onActivate }: { onActivate: () => void }) {
  const [mode, setMode] = useState<LicenceMode | null>(null);
  const [status, setStatus] = useState<LicenceStatus | null>(null);
  const [update, setUpdate] = useState<string | null>(null);
  useEffect(() => {
    void business.licenceMode().then((r) => r.ok && setMode(r.value));
    void window.api.licenceStatus().then(setStatus);
    void window.api.checkUpdate(true).then((r) => r.ok && r.value.kind === "available" && setUpdate(r.value.manifest.version));
  }, []);
  const readOnly = mode?.readOnly ?? (status?.mode === "read_only" ? status.reason : null);
  if (readOnly) {
    return (
      <div role="alert" className="error licence-banner">
        {ar.licence.readOnly[readOnly]}{" "}
        {status && (
          <button type="button" className="link" onClick={onActivate}>
            {ar.licence.activateLink}
          </button>
        )}
      </div>
    );
  }
  if (status?.mode !== "trial") return update ? (
    <div role="note" className="notice licence-banner">
      {ar.updates.banner(update)}{" "}
      <button type="button" className="link" onClick={onActivate}>
        {ar.updates.open}
      </button>
    </div>
  ) : null;
  return (
    <div role="note" className="notice licence-banner">
      {ar.licence.trial(status.daysLeft)}{" "}
      <button type="button" className="link" onClick={onActivate}>
        {ar.licence.activateLink}
      </button>
    </div>
  );
}
