import { useEffect, useState } from "react";
import type { Role } from "../../core/users";
import type { BusinessSettings, ThemeId, User } from "../../shared/api";
import { Accounts } from "./screens/Accounts";
import { AuditLog } from "./screens/AuditLog";
import { Home } from "./screens/Home";
import { Items } from "./screens/Items";
import { Settings } from "./screens/Settings";
import { SignIn } from "./screens/SignIn";
import { Users } from "./screens/Users";
import { Purchases } from "./screens/Purchases";
import { Customers } from "./screens/Customers";
import { SalesInvoices } from "./screens/SalesInvoices";
import { Till } from "./screens/Till";
import { Warehouses } from "./screens/Warehouses";
import { Welcome } from "./screens/Welcome";
import { ar } from "./strings";
import { SERVER_BACK, SERVER_LOST, business } from "./api";

type Screen =
  | "home"
  | "till"
  | "items"
  | "warehouses"
  | "purchases"
  | "customers"
  | "salesInvoices"
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
const NAV: { label: string; screen?: Screen; roles: Role[] }[] = [
  { label: ar.nav.home, screen: "home", roles: ALL },
  { label: ar.nav.till, screen: "till", roles: ["manager", "cashier"] },
  { label: ar.nav.items, screen: "items", roles: ALL },
  { label: ar.nav.warehouses, screen: "warehouses", roles: ["manager", "accountant", "storekeeper"] },
  { label: ar.nav.purchases, screen: "purchases", roles: ["manager", "accountant", "storekeeper"] },
  { label: ar.nav.salesInvoices, screen: "salesInvoices", roles: ["manager", "accountant"] },
  { label: ar.nav.customers, screen: "customers", roles: ["manager", "accountant", "cashier"] },
  { label: ar.nav.money, roles: ["manager", "accountant"] },
  {
    label: ar.nav.accounts,
    screen: "accounts",
    roles: ["manager", "accountant"],
  },
  { label: ar.nav.reports, roles: ["manager", "accountant"] },
  { label: ar.nav.users, screen: "users", roles: ["manager"] },
  { label: ar.nav.audit, screen: "audit", roles: ["manager", "accountant"] },
  { label: ar.nav.settings, screen: "settings", roles: ALL },
];

export function App() {
  const [open, setOpen] = useState<BusinessSettings | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [screen, setScreen] = useState<Screen>("home");
  const [theme, setTheme] = useState<ThemeId>("calm");
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
    void window.api.preferences().then((p) => setTheme(p.theme));
  }, []);

  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
  }, [theme]);

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

  if (!open) return <Welcome onOpen={opened} />;
  if (!user)
    return (
      <SignIn
        settings={open}
        onSignedIn={(u) => {
          setUser(u);
          setScreen("home");
        }}
        onOtherFile={() => setOpen(null)}
      />
    );

  return (
    <div className="shell">
      <nav aria-label={ar.nav.label} className="sidebar">
        <strong className="brand" dir="ltr">
          {ar.appName}
        </strong>
        <span className="muted business-name">{open.name}</span>
        {NAV.filter((item) => item.roles.includes(user.role)).map((item) =>
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
        {serverLost && (
          <div role="alert" className="error server-lost">
            {ar.errors["server_unreachable"]}{" "}
            <button type="button" className="link" onClick={() => void business.settings()}>
              {ar.network.retry}
            </button>
          </div>
        )}
        {screen === "home" && (
          <Home
            settings={open}
            canKeepBooks={user.role === "manager" || user.role === "accountant"}
            onGo={setScreen}
          />
        )}
        {screen === "items" && <Items />}
        {screen === "till" && <Till />}
        {screen === "purchases" && <Purchases canSeeBalances={user.role === "manager" || user.role === "accountant"} />}
        {screen === "customers" && <Customers keepsBooks={user.role === "manager" || user.role === "accountant"} />}
        {screen === "salesInvoices" && <SalesInvoices />}
        {screen === "warehouses" && <Warehouses canChange={user.role === "manager" || user.role === "storekeeper"} />}
        {screen === "accounts" && <Accounts />}
        {screen === "users" && <Users me={user} />}
        {screen === "audit" && <AuditLog />}
        {screen === "settings" && (
          <Settings theme={theme} onTheme={chooseTheme} />
        )}
      </main>
    </div>
  );
}
