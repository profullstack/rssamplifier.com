'use client';

import { useState } from 'react';
import { ProfileFields } from '@profullstack/profile/react';

/**
 * The signup profile, editable: prefilled from the server, saved with
 * PATCH /api/v1/me/profile. Uncontrolled, so the inputs post as they are typed
 * and the server's normalized values come back on save.
 *
 * @param {{ initial: Record<string, string|null> }} props
 */
export default function ProfileForm({ initial }) {
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState({});
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  /** @param {React.FormEvent<HTMLFormElement>} event */
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setStatus('');
    try {
      const body = Object.fromEntries(new FormData(event.currentTarget).entries());
      const res = await fetch('/api/v1/me/profile', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setErrors({});
        setValues(data.profile ?? data);
        setStatus('Saved.');
      } else {
        setErrors(data.errors ?? {});
        setStatus(data.errors ? 'A few of those fields need another look.' : 'Could not save. Try again.');
      }
    } catch {
      setStatus('Could not save. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="submit-box" onSubmit={save}>
      {/* Keyed on the saved values so a save re-renders the inputs with what
          the server normalized them to. */}
      <ProfileFields key={JSON.stringify(values)} defaultValues={values} errors={errors} idPrefix="account-" />
      <div className="submit-actions">
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save profile'}
        </button>
        {status && <span className="hint">{status}</span>}
      </div>
    </form>
  );
}
