/**
 * Outbound email.
 *
 * Two callers need it — the poller telling someone their import finished, and
 * the sign-in link — and neither should carry its own copy of a transport.
 *
 * Email is treated as optional infrastructure everywhere it is used: with no
 * RESEND_API_KEY the send is a reported failure rather than a thrown one, so a
 * deployment without mail configured degrades instead of breaking. The one
 * caller that genuinely cannot proceed without it (sign-in) checks
 * `emailEnabled()` and says so plainly.
 */

const ENDPOINT = 'https://api.resend.com/emails';

/**
 * Is a mail provider configured?
 *
 * @returns {boolean}
 */
export function emailEnabled() {
  return Boolean(process.env['RESEND_API_KEY']);
}

/**
 * Send one plain-text email.
 *
 * @param {{ to: string, subject: string, text: string, from?: string }} message
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function sendEmail(message) {
  const key = process.env['RESEND_API_KEY'];
  if (!key) return { ok: false, error: 'email-not-configured' };

  const from = message.from || process.env['EMAIL_FROM'] || 'RSS Amplifier <noreply@rssamplifier.com>';

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
    });

    if (!res.ok) {
      // The provider's own message is the only useful thing when a send fails,
      // and it is never shown to the person who triggered it.
      const detail = await res.text().catch(() => '');
      return { ok: false, error: `resend-${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}` };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}
