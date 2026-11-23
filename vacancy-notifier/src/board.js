/* Reading the vacancy board's own data (/api/jobs) and working out which site each vacancy is for.
   Nothing here talks to Talos directly: the notifier sees exactly what the screens see. */

/** Fetches /api/jobs from the board. Never throws: returns { ok: false, reason } on any problem. */
export async function fetchBoard({ origin, binding, timeoutMs, fetchFn }) {
  const url = String(origin || '').replace(/\/+$/, '') + '/api/jobs';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 30000);
  let response;
  try {
    const request = new Request(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'cooneen-vacancy-notifier' },
      signal: controller.signal
    });
    // Prefer the service binding: a plain fetch() between two Workers on one account fails (error 1042).
    response = binding ? await binding.fetch(request) : await (fetchFn || fetch)(request);
  } catch (err) {
    return { ok: false, reason: err && err.name === 'AbortError' ? 'board_timeout' : 'board_unreachable' };
  } finally {
    clearTimeout(timer);
  }

  const cacheHeader = response.headers.get('X-Jobs-Cache') || '';
  if (response.status !== 200) return { ok: false, reason: 'board_http_' + response.status };

  let data;
  try {
    data = await response.json();
  } catch (err) {
    return { ok: false, reason: 'board_not_json' };
  }
  return parseBoardPayload(data, cacheHeader);
}

/** Checks the shape of /api/jobs and keeps only the fields the notifier uses. */
export function parseBoardPayload(data, cacheHeader) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.jobs) || !data.meta || typeof data.meta !== 'object') {
    return { ok: false, reason: 'board_bad_shape' };
  }
  const jobs = [];
  for (const raw of data.jobs) {
    if (!raw || typeof raw !== 'object') continue;
    const id = typeof raw.id === 'string' || typeof raw.id === 'number' ? String(raw.id).trim() : '';
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (!id || !title) continue;
    jobs.push({
      id: id,
      title: title.slice(0, 200),
      location: typeof raw.location === 'string' ? raw.location.trim().slice(0, 200) : '',
      closingDate: typeof raw.closingDate === 'string' ? raw.closingDate : ''
    });
  }
  // A non-empty list in which nothing is usable means the format changed: don't treat it as "no vacancies".
  if (data.jobs.length > 0 && jobs.length === 0) return { ok: false, reason: 'board_bad_shape' };

  const stale = data.meta.stale === true || String(cacheHeader).toUpperCase() === 'STALE';
  return {
    ok: true,
    stale: stale,
    staleReason: typeof data.meta.staleReason === 'string' ? data.meta.staleReason : '',
    fetchedAt: typeof data.meta.fetchedAt === 'string' ? data.meta.fetchedAt : '',
    jobs: jobs
  };
}

/** Same rule as the board: a vacancy is open until its closing time (no closing date = open). */
export function isOpen(job, nowMs) {
  const t = Date.parse(job.closingDate);
  return !Number.isFinite(t) || t >= nowMs;
}

function matchesSite(job, site) {
  const hay = job.location.toLowerCase();
  return site.match.some((word) => hay.indexOf(String(word).toLowerCase()) >= 0);
}

function byClosingThenTitle(a, b) {
  const ta = Date.parse(a.closingDate);
  const tb = Date.parse(b.closingDate);
  const ca = Number.isFinite(ta) ? ta : Infinity;
  const cb = Number.isFinite(tb) ? tb : Infinity;
  if (ca !== cb) return ca - cb;
  return a.title.localeCompare(b.title, 'en-GB');
}

/** Open vacancies per site, plus open vacancies that match no site. A vacancy can count for more than one site. */
export function groupBySite(jobs, sites, nowMs) {
  const bySite = {};
  for (const site of sites) bySite[site.key] = [];
  const unmatched = [];
  for (const job of jobs) {
    if (!isOpen(job, nowMs)) continue;
    let matched = false;
    for (const site of sites) {
      if (matchesSite(job, site)) {
        bySite[site.key].push(job);
        matched = true;
      }
    }
    if (!matched) unmatched.push(job);
  }
  for (const key of Object.keys(bySite)) bySite[key].sort(byClosingThenTitle);
  unmatched.sort(byClosingThenTitle);
  return { bySite, unmatched };
}
