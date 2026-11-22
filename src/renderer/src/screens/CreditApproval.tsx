import { useState } from "react";
import type { Credentials } from "../../../shared/books/users";
import { formatMoney } from "../../../shared/money";
import { ar } from "../strings";

/** Errors from the manager's sign-in itself, which leave the approval prompt open. */
export const APPROVAL_ERRORS = ["sign_in_failed", "approval_not_manager"];

/**
 * Shown when a document would take a customer past their credit limit: the amount over, and a
 * manager's name and password to approve it on the spot.
 */
export function CreditApprovalPrompt({
  over,
  onApprove,
  onCancel,
}: {
  over: number;
  onApprove: (approval: Credentials) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const approve = () => onApprove({ name, password });
  return (
    <div role="alertdialog" aria-label={ar.creditLimit.title} className="card warn stack">
      <strong>{ar.creditLimit.over(formatMoney(over))}</strong>
      <span className="muted small">{ar.creditLimit.hint}</span>
      <div className="row">
        <label className="field">
          {ar.creditLimit.manager}
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          {ar.creditLimit.password}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              approve();
            }}
          />
        </label>
      </div>
      <div className="row">
        <button type="button" className="btn btn-primary" onClick={approve}>
          {ar.creditLimit.approve}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          {ar.cancel}
        </button>
      </div>
    </div>
  );
}
