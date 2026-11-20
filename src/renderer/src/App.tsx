import { useEffect, useState } from "react";
import type { BusinessSettings, ThemeId } from "../../shared/api";
import { Accounts } from "./screens/Accounts";
import { Home } from "./screens/Home";
import { Items } from "./screens/Items";
import { Settings } from "./screens/Settings";
import { Welcome } from "./screens/Welcome";
import { ar } from "./strings";

type Screen = "home" | "items" | "accounts" | "settings";

/** Screens of the main menu. Those without a screen yet are shown but disabled. */
const NAV: { label: string; screen?: Screen }[] = [
  { label: ar.nav.home, screen: "home" },
  { label: ar.nav.till },
  { label: ar.nav.items, screen: "items" },
  { label: ar.nav.purchases },
  { label: ar.nav.customers },
  { label: ar.nav.money },
  { label: ar.nav.accounts, screen: "accounts" },
  { label: ar.nav.reports },
  { label: ar.nav.settings, screen: "settings" },
];

export function App() {
  const [open, setOpen] = useState<BusinessSettings | null>(null);
  const [screen, setScreen] = useState<Screen>("home");
  const [theme, setTheme] = useState<ThemeId>("calm");

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

  if (!open) return <Welcome onOpen={setOpen} />;

  return (
    <div className="shell">
      <nav aria-label={ar.nav.label} className="sidebar">
        <strong className="brand" dir="ltr">
          {ar.appName}
        </strong>
        <span className="muted business-name">{open.name}</span>
        {NAV.map((item) =>
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
            <span key={item.label} className="nav-item nav-soon" title={ar.nav.soon}>
              {item.label}
              <small>{ar.nav.soon}</small>
            </span>
          ),
        )}
      </nav>
      <main className="content">
        {screen === "home" && <Home settings={open} onGo={setScreen} />}
        {screen === "items" && <Items />}
        {screen === "accounts" && <Accounts />}
        {screen === "settings" && <Settings theme={theme} onTheme={chooseTheme} />}
      </main>
    </div>
  );
}
