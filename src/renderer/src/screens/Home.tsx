import { useEffect, useState } from "react";
import type { Dashboard } from "../../../shared/books/reports";
import type { BusinessSettings } from "../../../shared/api";
import { formatMoney } from "../../../shared/money";
import { business, today } from "../api";
import { ar } from "../strings";
import { SetupChecklist, type SetupScreen } from "./Setup";

/** Today's sales, profit, cash in the drawer and low stock, for the roles that keep the books. */
function DashboardCards({ onGo }: { onGo: (screen: "reports" | "warehouses") => void }) {
  const [figures, setFigures] = useState<Dashboard | null>(null);
  useEffect(() => {
    void business.dashboard(today()).then((r) => r.ok && setFigures(r.value));
  }, []);
  if (!figures) return null;
  const money = (value: number) => <span dir="ltr">{formatMoney(value)}</span>;
  return (
    <section className="tiles" aria-label={ar.home.today}>
      <button type="button" className="card tile" onClick={() => onGo("reports")}>
        <span className="muted">{ar.home.sales}</span>
        <strong className="figure">{money(figures.sales)}</strong>
      </button>
      <button type="button" className="card tile" onClick={() => onGo("reports")}>
        <span className="muted">{ar.home.grossProfit}</span>
        <strong className="figure">{money(figures.grossProfit)}</strong>
      </button>
      <div className="card tile">
        <span className="muted">{ar.home.cashExpected}</span>
        <strong className="figure">
          {figures.cashExpected === null ? <span className="muted">{ar.home.noShift}</span> : money(figures.cashExpected)}
        </strong>
      </div>
      <button type="button" className={figures.lowStock > 0 ? "card tile warn" : "card tile"} onClick={() => onGo("warehouses")}>
        <span className="muted">{ar.home.lowStock}</span>
        <strong className="figure">{figures.lowStock}</strong>
      </button>
    </section>
  );
}

/** Landing screen after signing in: the first steps until they are done, today's figures, then shortcuts. */
export function Home({
  settings,
  canKeepBooks,
  isManager,
  onGo,
  onSetupFinished,
}: {
  settings: BusinessSettings;
  canKeepBooks: boolean;
  isManager: boolean;
  onGo: (screen: SetupScreen | "reports") => void;
  onSetupFinished: () => void;
}) {
  const [finished, setFinished] = useState(false);
  return (
    <>
      <header className="screen-head">
        <div>
          <h1>{settings.name}</h1>
          <span className="muted">{settings.address}</span>
        </div>
      </header>
      <SetupChecklist
        isManager={isManager}
        onGo={onGo}
        onFinished={() => {
          setFinished(true);
          onSetupFinished();
        }}
      />
      {finished && (
        <div role="status" className="ok">
          {ar.setup.finished}
        </div>
      )}
      {canKeepBooks && <DashboardCards onGo={onGo} />}
      <section className="tiles">
        <button type="button" className="card tile" onClick={() => onGo("items")}>
          <strong>{ar.nav.items}</strong>
          <span className="muted">{ar.home.items}</span>
        </button>
        {canKeepBooks && (
          <button type="button" className="card tile" onClick={() => onGo("reports")}>
            <strong>{ar.nav.reports}</strong>
            <span className="muted">{ar.home.reports}</span>
          </button>
        )}
        {canKeepBooks && (
          <button type="button" className="card tile" onClick={() => onGo("accounts")}>
            <strong>{ar.nav.accounts}</strong>
            <span className="muted">{ar.home.accounts}</span>
          </button>
        )}
        <button type="button" className="card tile" onClick={() => onGo("settings")}>
          <strong>{ar.settings.appearance}</strong>
          <span className="muted">{ar.home.appearance}</span>
        </button>
      </section>
    </>
  );
}
