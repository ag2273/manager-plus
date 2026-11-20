import type { BusinessSettings } from "../../../shared/api";
import { ar } from "../strings";

/** Landing screen after opening a business. The full dashboard arrives with the reports ticket. */
export function Home({ settings, onGo }: { settings: BusinessSettings; onGo: (screen: "items" | "accounts" | "settings") => void }) {
  return (
    <>
      <header className="screen-head">
        <div>
          <h1>{settings.name}</h1>
          <span className="muted">{settings.address}</span>
        </div>
      </header>
      <section className="tiles">
        <button type="button" className="card tile" onClick={() => onGo("items")}>
          <strong>{ar.nav.items}</strong>
          <span className="muted">{ar.home.items}</span>
        </button>
        <button type="button" className="card tile" onClick={() => onGo("accounts")}>
          <strong>{ar.nav.accounts}</strong>
          <span className="muted">{ar.home.accounts}</span>
        </button>
        <button type="button" className="card tile" onClick={() => onGo("settings")}>
          <strong>{ar.settings.appearance}</strong>
          <span className="muted">{ar.home.appearance}</span>
        </button>
      </section>
    </>
  );
}
