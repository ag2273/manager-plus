import { useState, type FormEvent } from "react";
import type { BusinessSettings, User } from "../../../shared/api";
import { errorText } from "../api";
import { ar } from "../strings";

/** Shown after a business file is opened: each user signs in with their name and password. */
export function SignIn({
  settings,
  onSignedIn,
  onOtherFile,
}: {
  settings: BusinessSettings;
  onSignedIn: (user: User) => void;
  onOtherFile: () => void;
}) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await window.api.signIn({ name, password });
    setError(errorText(result));
    if (result.ok) onSignedIn(result.value);
    else setPassword("");
  }

  return (
    <main className="sign-in">
      <form className="card" onSubmit={submit} aria-label={ar.signIn.title}>
        <div className="stack">
          <h1>{settings.name}</h1>
          <span className="muted">{ar.signIn.title}</span>
        </div>
        {error && (
          <div role="alert" className="error">
            {error}
          </div>
        )}
        <label className="field">
          {ar.signIn.name}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            autoComplete="username"
          />
        </label>
        <label className="field">
          {ar.signIn.password}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        <button type="submit" className="btn btn-primary">
          {ar.signIn.submit}
        </button>
        <button type="button" className="link" onClick={onOtherFile}>
          {ar.signIn.otherFile}
        </button>
      </form>
    </main>
  );
}
