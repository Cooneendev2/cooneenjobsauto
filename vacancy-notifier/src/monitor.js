/* One check: compare what the board shows now with what was remembered last time, and email on a change.
   No Cloudflare APIs in here (the caller loads and saves the state), so it runs the same in tests or
   on any other server.

   Rules
   - Each site is judged on its own: open vacancies whose location contains the site word (the board's own rule).
   - No vacancies -> some  : email "Internal Vacancies Available"   (once)
   - Some -> no vacancies  : email "No Internal Vacancies"          (once)
   - Anything else         : no email
   - A site's remembered state only moves on once its email has actually been sent, so a failed email
     is retried on the next run instead of being lost.
   - If the board can't be read, or it is serving an older copy because Talos is down, nothing is
     decided that run (a failed read must never look like "no vacancies"). After STALE_ALERT_HOURS one
     problem email goes out, and one more when it recovers.
   - First run: one "notifier started" email with the current status, then normal behaviour.
   - Open vacancies matching no site: one email per vacancy (so an "all sites" label shows up). */

import { groupBySite } from './board.js';
import { emptyState } from './state.js';
import * as emails from './emails.js';

function iso(ms) {
  return new Date(ms).toISOString();
}

function hourStamp(ms) {
  return iso(ms).slice(0, 13);
}

function snapshot(jobs, changedAt) {
  return { jobs: jobs.map((j) => ({ id: j.id, title: j.title, closingDate: j.closingDate })), changedAt: changedAt };
}

export async function runCheck({ nowMs, boardResult, previous, sites, notifier, settings, boardUrlFor }) {
  const state = previous ? structuredClone(previous) : emptyState();
  const events = [];

  async function send(kind, key, message) {
    const result = await notifier.send(Object.assign({}, message, { idempotencyKey: kind + ':' + key + ':' + hourStamp(nowMs) }));
    events.push({ kind: kind, key: key, subject: message.subject, ok: result.ok, error: result.error || null });
    return result.ok;
  }

  // 1. Is the data fresh enough to act on?
  const healthy = boardResult.ok && !boardResult.stale;
  if (!healthy) {
    const reason = boardResult.ok ? 'stale:' + (boardResult.staleReason || '') : boardResult.reason;
    if (!state.health.badSince) state.health.badSince = iso(nowMs);
    state.health.reason = reason;
    const hoursBad = (nowMs - Date.parse(state.health.badSince)) / 3600000;
    if (!state.health.alerted && hoursBad >= settings.staleAlertHours) {
      const ok = await send('problem', 'health', emails.dataProblem({ since: state.health.badSince, reason: reason, boardOrigin: settings.boardOrigin }));
      if (ok) state.health.alerted = true;
    }
    return { state: state, events: events, healthy: false, summary: { reason: reason } };
  }

  if (state.health.alerted) {
    const ok = await send('recovered', 'health', emails.dataRecovered({ since: state.health.badSince }));
    if (ok) state.health = { badSince: null, alerted: false, reason: '' };
  } else if (state.health.badSince) {
    state.health = { badSince: null, alerted: false, reason: '' };
  }

  const { bySite, unmatched } = groupBySite(boardResult.jobs, sites, nowMs);
  const summary = { counts: {}, unmatched: unmatched.length };
  for (const site of sites) summary.counts[site.key] = bySite[site.key].length;

  // 2. First run: report the current status once, then remember it.
  if (!state.startedAt) {
    const ok = await send('started', 'all', emails.notifierStarted({ sites: sites, bySite: bySite, unmatched: unmatched }));
    if (ok) {
      state.startedAt = iso(nowMs);
      for (const site of sites) state.sites[site.key] = snapshot(bySite[site.key], iso(nowMs));
      state.unmatchedNotified = unmatched.map((j) => j.id);
    }
    return { state: state, events: events, healthy: true, summary: summary };
  }

  // 3. Each site on its own.
  for (const site of sites) {
    const jobs = bySite[site.key];
    const before = state.sites[site.key];
    if (!before) {
      // A site added to the config later: remember it quietly.
      state.sites[site.key] = snapshot(jobs, iso(nowMs));
      continue;
    }
    const had = before.jobs.length > 0;
    const has = jobs.length > 0;
    if (!had && has) {
      const ok = await send('appeared', site.key, emails.vacanciesAppeared({ site: site, jobs: jobs, boardUrl: boardUrlFor(site) }));
      if (ok) state.sites[site.key] = snapshot(jobs, iso(nowMs));
    } else if (had && !has) {
      const ok = await send('ended', site.key, emails.vacanciesEnded({ site: site, lastJobs: before.jobs, boardUrl: boardUrlFor(site) }));
      if (ok) state.sites[site.key] = snapshot(jobs, iso(nowMs));
    } else {
      // No change of state: keep the list current (for the "last listed" line later), no email.
      state.sites[site.key] = snapshot(jobs, before.changedAt);
    }
  }

  // 4. Open vacancies that no site screen shows: tell us once per vacancy.
  const notified = new Set(state.unmatchedNotified || []);
  const fresh = unmatched.filter((j) => !notified.has(j.id));
  if (fresh.length) {
    const ok = await send('unmatched', 'unmatched', emails.unmatchedVacancies({ jobs: fresh, sites: sites }));
    if (ok) fresh.forEach((j) => notified.add(j.id));
  }
  const stillOpen = new Set(unmatched.map((j) => j.id));
  state.unmatchedNotified = Array.from(notified).filter((id) => stillOpen.has(id));

  return { state: state, events: events, healthy: true, summary: summary };
}
