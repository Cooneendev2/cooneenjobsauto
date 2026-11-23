/* The wording of every email. Each function returns { subject, text, html }.
   Nothing here knows how email is sent, so the provider can change without touching this file. */

import { GREETING, DEFAULTS } from './config.js';

const dayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: DEFAULTS.timezone, day: 'numeric', month: 'long' });
const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: DEFAULTS.timezone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

const FOOTER = 'Sent automatically by the vacancy notifier. It never changes Yodeck.';

function closes(job) {
  const t = Date.parse(job.closingDate);
  return Number.isFinite(t) ? ' – closes ' + dayFmt.format(t) : '';
}

function vacancyLine(job) {
  return job.title + closes(job);
}

function plural(n, one, many) {
  return n === 1 ? one : many;
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* blocks: { p } a paragraph, { p, url } a paragraph ending in a link, { list: [...] } bullet points. */
export function render(subject, blocks) {
  const all = [{ p: GREETING }].concat(blocks, [{ p: FOOTER, quiet: true }]);
  const text = all
    .map((b) => (b.list ? b.list.map((x) => ' • ' + x).join('\n') : b.url ? b.p + ' ' + b.url : b.p))
    .join('\n\n');
  const html =
    '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5;color:#222">' +
    all
      .map((b) => {
        if (b.list) return '<ul style="margin:0 0 12px 0">' + b.list.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>';
        if (b.url) return '<p>' + esc(b.p) + ' <a href="' + esc(b.url) + '">' + esc(b.url) + '</a></p>';
        return b.quiet ? '<p style="color:#777;font-size:12px">' + esc(b.p) + '</p>' : '<p>' + esc(b.p) + '</p>';
      })
      .join('') +
    '</div>';
  return { subject, text, html };
}

export function vacanciesAppeared({ site, jobs, boardUrl }) {
  const n = jobs.length;
  return render('Internal Vacancies Available – ' + site.name + ' – Board Action Required', [
    { p: n + ' internal ' + plural(n, 'vacancy is', 'vacancies are') + ' now open for ' + site.name + ':' },
    { list: jobs.map(vacancyLine) },
    { p: 'Action: switch the ' + site.screen + ' screen in Yodeck to the Thanks + Vacancies playlist, unless it is deliberately showing something else at the moment.' },
    { p: 'Board for this screen:', url: boardUrl }
  ]);
}

export function vacanciesEnded({ site, lastJobs, boardUrl }) {
  const blocks = [{ p: 'There are no longer any open internal vacancies for ' + site.name + '.' }];
  if (lastJobs && lastJobs.length) {
    blocks.push({ p: 'Last listed:' }, { list: lastJobs.map((j) => j.title) });
  }
  blocks.push(
    { p: 'Action: review the ' + site.screen + ' screen in Yodeck and switch it to whatever it should show now (usually the ' + site.name + ' Thanks playlist).' },
    { p: 'Board for this screen:', url: boardUrl }
  );
  return render('No Internal Vacancies – ' + site.name + ' – Board Action Required', blocks);
}

export function notifierStarted({ sites, bySite, unmatched }) {
  const lines = sites.map((site) => {
    const jobs = bySite[site.key] || [];
    const label = site.name + ' (' + site.screen + ')';
    if (!jobs.length) return label + ': no open vacancies';
    return label + ': ' + jobs.length + ' open – ' + jobs.map((j) => j.title).join(', ');
  });
  const blocks = [
    { p: 'The vacancy notifier is now running. It checks the vacancy board every hour and emails only when a site\'s vacancies start or end.' },
    { p: 'Current status:' },
    { list: lines }
  ];
  if (unmatched.length) {
    blocks.push(
      { p: 'Also open, but not shown on any of the three site screens because the location matches no site:' },
      { list: unmatched.map((j) => j.title + ' – location "' + (j.location || 'blank') + '"') }
    );
  }
  blocks.push({ p: 'No action is needed for this email unless a screen above is showing the wrong thing.' });
  return render('Vacancy notifier started – current status', blocks);
}

export function unmatchedVacancies({ jobs, sites }) {
  const names = sites.map((s) => s.name);
  const siteList = names.slice(0, -1).join(', ') + ' or ' + names[names.length - 1];
  return render('Internal vacancy not shown on any site screen – check location', [
    { p: plural(jobs.length, 'This open internal vacancy has', 'These open internal vacancies have') + ' a location that does not match ' + siteList + ', so ' + plural(jobs.length, 'it will not', 'they will not') + ' appear on any of the three site screens:' },
    { list: jobs.map((j) => j.title + ' – location "' + (j.location || 'blank') + '"') },
    { p: 'If a vacancy is meant for one of those sites, its location in Talos needs to include the site name.' }
  ]);
}

const REASONS = {
  board_unreachable: 'the vacancy board could not be reached',
  board_timeout: 'the vacancy board took too long to answer',
  board_not_json: 'the vacancy board did not return readable data',
  board_bad_shape: 'the vacancy board\'s data was not in the expected format'
};

export function reasonText(reason) {
  if (REASONS[reason]) return REASONS[reason];
  const http = /^board_http_(\d+)$/.exec(reason || '');
  if (http) return 'the vacancy board returned an error (HTTP ' + http[1] + ')';
  const stale = /^stale:?(.*)$/.exec(reason || '');
  if (stale) return 'the board is showing an older copy because Talos is not answering' + (stale[1] ? ' (' + stale[1] + ')' : '');
  return reason || 'unknown';
}

export function dataProblem({ since, reason, boardOrigin }) {
  return render('Vacancy notifier – can\'t get current vacancy data', [
    { p: 'The vacancy notifier has not been able to get fresh vacancy data since ' + timeFmt.format(Date.parse(since)) + '.' },
    { p: 'Reason: ' + reasonText(reason) + '.' },
    { p: 'The screens keep showing the last list they had. Emails about vacancies starting or ending are paused until this clears, and you will get an email when it does.' },
    { p: 'The board\'s own diagnostics:', url: String(boardOrigin).replace(/\/+$/, '') + '/api/jobs?diag=1' }
  ]);
}

export function dataRecovered({ since }) {
  return render('Vacancy notifier – vacancy data back to normal', [
    { p: 'Fresh vacancy data is available again (the problem started ' + timeFmt.format(Date.parse(since)) + ').' },
    { p: 'Normal emails resume now. If a site\'s vacancies started or ended in the meantime, that email follows this one.' }
  ]);
}
