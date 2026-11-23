/* Cloudflare entry point: the hourly cron, plus two optional addresses for checking by hand.
     GET /status            the remembered state (needs RUN_TOKEN)
     GET /run               run a check now, sending real emails (needs RUN_TOKEN)
     GET /run?dry=1         run a check now, but send nothing and save nothing (needs RUN_TOKEN)
   Give the token as "Authorization: Bearer <token>" or ?token=<token>. Without a RUN_TOKEN secret
   both addresses answer 404. */

import { SITES, BOARD_QUERY, DEFAULTS } from './config.js';
import { fetchBoard } from './board.js';
import { loadState, saveState } from './state.js';
import { runCheck } from './monitor.js';
import { createResendNotifier, createRecordingNotifier } from './notify/resend.js';

function settingsFrom(env) {
  const hours = Number(env.STALE_ALERT_HOURS);
  return {
    boardOrigin: String(env.BOARD_ORIGIN || '').replace(/\/+$/, ''),
    staleAlertHours: Number.isFinite(hours) && hours > 0 ? hours : DEFAULTS.staleAlertHours
  };
}

async function execute(env, { dry }) {
  const nowMs = Date.now();
  const settings = settingsFrom(env);
  const previous = await loadState(env.STATE);
  const boardResult = await fetchBoard({ origin: settings.boardOrigin, binding: env.BOARD, timeoutMs: DEFAULTS.boardTimeoutMs });
  const notifier = dry
    ? createRecordingNotifier()
    : createResendNotifier({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM, to: env.EMAIL_TO, cc: env.EMAIL_CC });

  const result = await runCheck({
    nowMs: nowMs,
    boardResult: boardResult,
    previous: previous,
    sites: SITES,
    notifier: notifier,
    settings: settings,
    boardUrlFor: (site) => settings.boardOrigin + '/?' + BOARD_QUERY + '&location=' + encodeURIComponent(site.boardLocation)
  });

  const changed = JSON.stringify(result.state) !== JSON.stringify(previous);
  if (!dry && changed) await saveState(env.STATE, result.state);

  const report = {
    evt: 'check',
    dry: dry,
    at: new Date(nowMs).toISOString(),
    healthy: result.healthy,
    summary: result.summary,
    emails: result.events,
    saved: !dry && changed
  };
  console.log(JSON.stringify(report));
  if (dry) report.wouldSend = notifier.sent;
  return report;
}

async function tokenOk(request, env) {
  const expected = env.RUN_TOKEN;
  if (!expected) return false;
  const url = new URL(request.url);
  const auth = request.headers.get('Authorization') || '';
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : url.searchParams.get('token') || '';
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

function json(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      execute(env, { dry: false }).catch((err) => {
        console.error(JSON.stringify({ evt: 'check_failed', error: String(err && err.message ? err.message : err) }));
      })
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'GET' || (url.pathname !== '/run' && url.pathname !== '/status')) {
      return new Response('Not found', { status: 404 });
    }
    if (!(await tokenOk(request, env))) return new Response('Not found', { status: 404 });

    if (url.pathname === '/status') return json(await loadState(env.STATE));
    try {
      return json(await execute(env, { dry: url.searchParams.get('dry') === '1' }));
    } catch (err) {
      return json({ error: String(err && err.message ? err.message : err) }, 500);
    }
  }
};
