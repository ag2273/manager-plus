import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Role } from "../../../shared/books/users";
import type { Result, User } from "../../../shared/api";
import { business, errorText } from "../api";
import { ar } from "../strings";

const ROLES: Role[] = ["manager", "accountant", "cashier", "storekeeper"];

/** Managers add users, change their role or password, and stop them. */
export function Users({ me }: { me: User }) {
  const [users, setUsers] = useState<User[]>([]);
  const [draft, setDraft] = useState({
    name: "",
    role: "cashier" as Role,
    password: "",
  });
  const [resetting, setResetting] = useState<{
    id: number;
    password: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const result = await business.users();
    if (result.ok) setUsers(result.value);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function run(
    work: Promise<Result<unknown>>,
    done?: string,
  ): Promise<boolean> {
    const result = await work;
    setError(errorText(result));
    setNotice(result.ok && done ? done : null);
    if (result.ok) await reload();
    return result.ok;
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (await run(business.addUser(draft)))
      setDraft({ ...draft, name: "", password: "" });
  }

  return (
    <>
      <header className="screen-head">
        <div>
          <h1>{ar.users.title}</h1>
          <span className="muted">{ar.users.hint}</span>
        </div>
      </header>
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="ok">
          {notice}
        </div>
      )}
      <form className="card form-row" onSubmit={add}>
        <label className="field">
          {ar.users.name}
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <label className="field narrow">
          {ar.users.role}
          <select
            value={draft.role}
            onChange={(e) =>
              setDraft({ ...draft, role: e.target.value as Role })
            }
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ar.roles[r]}
              </option>
            ))}
          </select>
        </label>
        <label className="field narrow">
          {ar.users.password}
          <input
            type="password"
            placeholder={ar.passwordHint}
            value={draft.password}
            onChange={(e) => setDraft({ ...draft, password: e.target.value })}
          />
        </label>
        <button type="submit" className="btn btn-primary">
          {ar.users.add}
        </button>
      </form>
      <section className="table-card" aria-label={ar.users.title}>
        <table>
          <thead>
            <tr>
              <th>{ar.users.name}</th>
              <th className="col-type">{ar.users.role}</th>
              <th className="col-actions" />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={u.active ? undefined : "inactive"}>
                <td>
                  {u.name}
                  {u.id === me.id && (
                    <span className="chip">{ar.users.you}</span>
                  )}
                  {!u.active && (
                    <span className="chip chip-warn">{ar.users.inactive}</span>
                  )}
                </td>
                <td>
                  <select
                    aria-label={`${ar.users.role}: ${u.name}`}
                    value={u.role}
                    onChange={(e) =>
                      run(
                        business.updateUser(u.id, {
                          role: e.target.value as Role,
                        }),
                      )
                    }
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ar.roles[r]}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <div className="actions">
                    {resetting?.id === u.id ? (
                      <>
                        <input
                          type="password"
                          aria-label={ar.users.newPassword}
                          placeholder={ar.users.newPassword}
                          value={resetting.password}
                          onChange={(e) =>
                            setResetting({
                              ...resetting,
                              password: e.target.value,
                            })
                          }
                        />
                        <button
                          type="button"
                          className="btn btn-small btn-primary"
                          onClick={async () => {
                            if (
                              await run(
                                business.resetPassword(
                                  u.id,
                                  resetting.password,
                                ),
                                ar.users.passwordReset,
                              )
                            )
                              setResetting(null);
                          }}
                        >
                          {ar.save}
                        </button>
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() => setResetting(null)}
                        >
                          {ar.cancel}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() => setResetting({ id: u.id, password: "" })}
                      >
                        {ar.users.resetPassword}
                      </button>
                    )}
                    {u.active ? (
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() => run(business.deactivateUser(u.id))}
                      >
                        {ar.users.deactivate}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() => run(business.reactivateUser(u.id))}
                      >
                        {ar.users.reactivate}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
