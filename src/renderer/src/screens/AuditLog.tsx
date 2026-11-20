import { useEffect, useState } from "react";
import type { AuditEntry } from "../../../core/users";
import { business } from "../api";
import { ar } from "../strings";

const when = new Intl.DateTimeFormat("ar-EG-u-nu-latn", {
  dateStyle: "medium",
  timeStyle: "short",
});

/** Who changed what and when, newest first. */
export function AuditLog() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);

  useEffect(() => {
    void business.auditLog().then((r) => r.ok && setEntries(r.value));
  }, []);

  return (
    <>
      <header className="screen-head">
        <div>
          <h1>{ar.audit.title}</h1>
          <span className="muted">{ar.audit.hint}</span>
        </div>
      </header>
      <section className="table-card" aria-label={ar.audit.title}>
        {entries.length === 0 ? (
          <p className="muted empty">{ar.audit.empty}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th className="col-when">{ar.audit.at}</th>
                <th className="col-type">{ar.audit.user}</th>
                <th>{ar.audit.action}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="muted small">{when.format(new Date(e.at))}</td>
                  <td>{e.userName}</td>
                  <td>
                    {ar.audit.actions[e.action] ?? e.action}
                    {e.entityId !== null && (
                      <span className="muted small"> · #{e.entityId}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
