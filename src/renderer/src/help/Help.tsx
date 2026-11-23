import { useId, useMemo, useState } from "react";
import { help, searchHelp, type HelpField, type HelpHit, type HelpScreen } from "./index";
import type { Guide } from "./types";

/**
 * A "?" beside a field: what to enter there and why (#97, note 11, level 1). It sits inside the
 * field's label, so it is a span acting as a button: a real button would become the label's
 * control, and clicking the label's text would open the help instead of focusing the field.
 */
export function FieldHelp({ field }: { field: HelpField }) {
  const h = help();
  const [open, setOpen] = useState(false);
  const id = useId();
  const toggle = (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen(!open);
  };
  return (
    <>
      <span
        role="button"
        tabIndex={0}
        className="help-dot"
        aria-label={h.fieldHelp(h.fieldNames[field])}
        aria-expanded={open}
        aria-controls={id}
        onClick={toggle}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && toggle(e)}
      >
        ?
      </span>
      {open && (
        <span id={id} role="note" className="help-note">
          {h.fields[field]}
        </span>
      )}
    </>
  );
}

function GuideSteps({ guide, onGo }: { guide: Guide; onGo?: (screen: HelpScreen) => void }) {
  const h = help();
  return (
    <ol className="help-steps">
      {guide.steps.map((s, i) => (
        <li key={i}>
          {s.text}
          {s.screen && onGo && (
            <>
              {" "}
              <button type="button" className="link" onClick={() => onGo(s.screen!)}>
                {h.goTo}: {h.screens[s.screen].title}
              </button>
            </>
          )}
        </li>
      ))}
    </ol>
  );
}

/** What a screen is for and how to use it, with the guides that pass through it (level 2). */
export function ScreenHelpPanel({ screen, onClose, onManual }: { screen: HelpScreen; onClose: () => void; onManual: () => void }) {
  const h = help();
  const s = h.screens[screen];
  const [guide, setGuide] = useState<string | null>(null);
  return (
    <aside className="card help-panel" aria-labelledby="screen-help-title">
      <div className="row">
        <h2 id="screen-help-title">{s.title}</h2>
        <button type="button" className="btn btn-small" onClick={onClose}>
          {h.close}
        </button>
      </div>
      <p>{s.purpose}</p>
      <ul className="help-points">
        {s.points.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      {s.guides.length > 0 && (
        <>
          <h3>{h.sections.guides}</h3>
          {s.guides.map((id) => {
            const g = h.guides.find((x) => x.id === id)!;
            return (
              <div key={id}>
                <button type="button" className="link" aria-expanded={guide === id} onClick={() => setGuide(guide === id ? null : id)}>
                  {g.title}
                </button>
                {guide === id && <GuideSteps guide={g} />}
              </div>
            );
          })}
        </>
      )}
      <button type="button" className="link" onClick={onManual}>
        {h.openManual}
      </button>
    </aside>
  );
}

type Open = Pick<HelpHit, "kind" | "id">;

function Article({ open, onGo }: { open: Open; onGo: (screen: HelpScreen) => void }) {
  const h = help();
  if (open.kind === "screen") {
    const s = h.screens[open.id as HelpScreen];
    return (
      <article aria-labelledby="help-article">
        <h2 id="help-article">{s.title}</h2>
        <p>{s.purpose}</p>
        <ul className="help-points">
          {s.points.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        <button type="button" className="btn" onClick={() => onGo(open.id as HelpScreen)}>
          {h.goTo}
        </button>
      </article>
    );
  }
  if (open.kind === "guide") {
    const g = h.guides.find((x) => x.id === open.id)!;
    return (
      <article aria-labelledby="help-article">
        <h2 id="help-article">{g.title}</h2>
        <p className="muted">{g.summary}</p>
        <GuideSteps guide={g} onGo={onGo} />
      </article>
    );
  }
  if (open.kind === "concept") {
    const c = h.concepts.find((x) => x.id === open.id)!;
    return (
      <article aria-labelledby="help-article">
        <h2 id="help-article">{c.title}</h2>
        {c.paragraphs.map((p) => (
          <p key={p}>{p}</p>
        ))}
      </article>
    );
  }
  const f = open.id as HelpField;
  return (
    <article aria-labelledby="help-article">
      <h2 id="help-article">{h.fieldNames[f]}</h2>
      <p>{h.fields[f]}</p>
    </article>
  );
}

/** The whole help in one place, browsed or searched, without the internet (all four levels). */
export function HelpManual({ onGo }: { onGo: (screen: HelpScreen) => void }) {
  const h = help();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Open | null>(null);
  const hits = useMemo(() => searchHelp(h, query), [h, query]);

  const link = (o: Open, title: string) => (
    <li key={`${o.kind}-${o.id}`}>
      <button type="button" className="link" aria-current={open?.kind === o.kind && open.id === o.id ? "true" : undefined} onClick={() => setOpen(o)}>
        {title}
      </button>
    </li>
  );

  return (
    <>
      <header className="screen-head">
        <div>
          <h1>{h.manualTitle}</h1>
          <span className="muted">{h.manualIntro}</span>
        </div>
      </header>
      <div className="row">
        <label className="field">
          {h.searchLabel}
          <input type="search" placeholder={h.searchHint} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>
      <div className="help-manual">
        <nav className="card help-toc" aria-label={h.manualTitle}>
          {query.trim() !== "" ? (
            hits.length === 0 ? (
              <p className="muted">{h.noResults}</p>
            ) : (
              <ul>{hits.map((x) => link(x, x.title))}</ul>
            )
          ) : (
            <>
              <h3>{h.sections.guides}</h3>
              <ul>{h.guides.map((g) => link({ kind: "guide", id: g.id }, g.title))}</ul>
              <h3>{h.sections.screens}</h3>
              <ul>{(Object.keys(h.screens) as HelpScreen[]).map((id) => link({ kind: "screen", id }, h.screens[id].title))}</ul>
              <h3>{h.sections.concepts}</h3>
              <ul>{h.concepts.map((c) => link({ kind: "concept", id: c.id }, c.title))}</ul>
              <h3>{h.sections.fields}</h3>
              <ul>{(Object.keys(h.fields) as HelpField[]).map((id) => link({ kind: "field", id }, h.fieldNames[id]))}</ul>
            </>
          )}
        </nav>
        <section className="card help-article">{open ? <Article open={open} onGo={onGo} /> : <p className="muted">{h.manualIntro}</p>}</section>
      </div>
    </>
  );
}
