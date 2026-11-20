import { THEMES, type ThemeId } from "../../../shared/api";
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
    </>
  );
}
