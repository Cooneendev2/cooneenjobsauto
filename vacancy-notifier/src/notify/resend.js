/* Email through Resend's HTTP API. Every notifier has the same shape:
     { name, configured, send({ subject, text, html, idempotencyKey }) -> { ok, id?, error? } }
   so another provider (Microsoft Graph, Cloudflare Email, SMTP relay) can replace this file without
   touching the vacancy logic. */

const RESEND_URL = 'https://api.resend.com/emails';

export function splitList(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function createResendNotifier({ apiKey, from, to, cc, fetchFn, log }) {
  const logger = log || console;
  const toList = splitList(to);
  const ccRequested = splitList(cc);
  const placeholder = !from || /REPLACE/i.test(from);
  const configured = Boolean(apiKey) && !placeholder && toList.length > 0;

  // Resend's test sender (onboarding@resend.dev) only delivers to the Resend account's own address,
  // and rejects the whole email if anyone else is on it - so leave the CC out until a domain is verified.
  const testingSender = /@resend\.dev\s*>?\s*$/i.test(from || '');
  const ccList = testingSender ? [] : ccRequested;

  return {
    name: 'resend',
    configured: configured,
    async send(message) {
      if (!configured) {
        logger.warn(JSON.stringify({
          evt: 'email_not_sent',
          why: !apiKey ? 'RESEND_API_KEY secret not set' : placeholder ? 'EMAIL_FROM is still the placeholder' : 'EMAIL_TO is empty',
          subject: message.subject
        }));
        logger.log(message.text);
        return { ok: false, error: 'not_configured' };
      }
      if (testingSender && ccRequested.length) {
        logger.warn(JSON.stringify({ evt: 'cc_skipped', why: 'testing sender (resend.dev) cannot send to other addresses' }));
      }

      const body = { from: from, to: toList, subject: message.subject, text: message.text, html: message.html };
      if (ccList.length) body.cc = ccList;
      const headers = { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' };
      if (message.idempotencyKey) headers['Idempotency-Key'] = message.idempotencyKey;

      try {
        const res = await (fetchFn || fetch)(RESEND_URL, { method: 'POST', headers: headers, body: JSON.stringify(body) });
        if (!res.ok) {
          let detail = '';
          try {
            detail = (await res.text()).slice(0, 300);
          } catch (e) {
            detail = '';
          }
          return { ok: false, error: 'resend_' + res.status, detail: detail };
        }
        let data = {};
        try {
          data = await res.json();
        } catch (e) {
          data = {};
        }
        return { ok: true, id: data && data.id ? String(data.id) : '' };
      } catch (err) {
        return { ok: false, error: 'resend_unreachable' };
      }
    }
  };
}

/* Used by /run?dry=1 and the tests: records what would be sent, sends nothing. */
export function createRecordingNotifier() {
  const sent = [];
  return {
    name: 'recorder',
    configured: true,
    sent: sent,
    async send(message) {
      sent.push({ subject: message.subject, text: message.text });
      return { ok: true, id: 'dry-run' };
    }
  };
}
