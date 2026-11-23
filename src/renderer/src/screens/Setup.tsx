import { useEffect, useState } from "react";
import type { SetupStatus } from "../../../shared/books/setup";
import { business, errorText } from "../api";
import { ar } from "../strings";

export type SetupScreen = "settings" | "warehouses" | "items" | "accounts" | "users";

/** The setup's state from the core, read again whenever `key` changes. */
export function useSetupStatus(key: unknown): [SetupStatus | null, (s: SetupStatus) => void] {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  useEffect(() => {
    void business.setupStatus().then((r) => r.ok && setStatus(r.value));
  }, [key]);
  return [status, setStatus];
}

function Step({
  number,
  title,
  hint,
  done,
  optional,
  children,
}: {
  number: number;
  title: string;
  hint: string;
  done: boolean;
  optional?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <li className={done ? "setup-step done" : "setup-step"}>
      <span className="setup-mark" aria-hidden="true">
        {done ? "✓" : number}
      </span>
      <div className="setup-body">
        <strong>
          {title}
          {done && <span className="sr-only"> ({ar.setup.done})</span>}
          {optional && <small className="muted"> · {ar.setup.optional}</small>}
        </strong>
        <span className="muted">{hint}</span>
        {children && <div className="row setup-actions">{children}</div>}
      </div>
    </li>
  );
}

/**
 * The first-use setup on the home screen (#97, note 10): the steps in order, each with the way to
 * its screen, and the confirmation that opens sales and purchases. The core keeps them closed
 * until then; this only shows the way.
 */
export function SetupChecklist({
  isManager,
  onGo,
  onFinished,
}: {
  isManager: boolean;
  onGo: (screen: SetupScreen) => void;
  onFinished: () => void;
}) {
  const [status, setStatus] = useSetupStatus(null);
  const [fresh, setFresh] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!status || status.finished) return null;

  async function finish(mode: "opening" | "new") {
    const result = await business.finishSetup(mode);
    if (!result.ok) {
      setError(errorText(result));
      return;
    }
    setStatus(result.value);
    onFinished();
  }

  const t = ar.setup.steps;
  const go = (screen: SetupScreen, label: string) =>
    isManager && (
      <button type="button" className="btn" onClick={() => onGo(screen)}>
        {label}
      </button>
    );
  const opening = status.openingEntries > 0;
  return (
    <section className="card setup" aria-labelledby="setup-title">
      <h2 id="setup-title">{ar.setup.title}</h2>
      <p className="muted">{ar.setup.intro}</p>
      {!isManager && <p role="note">{ar.setup.managerOnly}</p>}
      <ol className="setup-steps">
        <Step number={1} title={t.business.title} hint={t.business.hint} done>
          {go("settings", t.business.go)}
        </Step>
        <Step number={2} title={t.warehouses.title} hint={t.warehouses.hint} done={status.warehouses > 0}>
          {go("warehouses", t.warehouses.go)}
        </Step>
        <Step number={3} title={t.items.title} hint={t.items.hint} done={status.items > 0}>
          {go("items", t.items.go)}
        </Step>
        <Step
          number={4}
          title={t.opening.title}
          hint={opening ? `${t.opening.hint} ${t.opening.entered(status.openingEntries)}` : t.opening.hint}
          done={opening}
        >
          {go("items", t.opening.import)}
          {go("accounts", t.opening.accounts)}
        </Step>
        <Step number={5} title={t.till.title} hint={t.till.hint} done={status.users > 1} optional>
          {go("settings", t.till.go)}
          {go("users", t.till.users)}
        </Step>
        <Step number={6} title={t.start.title} hint={t.start.hint} done={false}>
          {isManager && !fresh && (
            <>
              <button type="button" className="btn btn-primary" disabled={!opening} onClick={() => void finish("opening")}>
                {t.start.confirm}
              </button>
              <button type="button" className="btn" onClick={() => setFresh(true)}>
                {t.start.fresh}
              </button>
            </>
          )}
          {isManager && fresh && (
            <>
              <span role="alert">{t.start.freshCheck}</span>
              <button type="button" className="btn btn-primary" onClick={() => void finish("new")}>
                {t.start.freshYes}
              </button>
              <button type="button" className="btn" onClick={() => setFresh(false)}>
                {t.start.cancel}
              </button>
            </>
          )}
        </Step>
      </ol>
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
    </section>
  );
}

/** Says on every other screen that sales and purchases wait for the first steps, with the way back to them. */
export function SetupBanner({ screenKey, onOpen }: { screenKey: string; onOpen: () => void }) {
  const [status] = useSetupStatus(screenKey);
  if (!status || status.finished) return null;
  return (
    <div role="note" className="notice setup-banner">
      {ar.setup.locked}{" "}
      <button type="button" className="link" onClick={onOpen}>
        {ar.setup.openSteps}
      </button>
    </div>
  );
}
