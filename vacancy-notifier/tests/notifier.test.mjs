/* node --test tests/      (Node 20+, no packages needed)
   The vacancies below are obvious test records, not real data. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SITES } from '../src/config.js';
import { parseBoardPayload, groupBySite, fetchBoard } from '../src/board.js';
import { runCheck } from '../src/monitor.js';
import { createResendNotifier, createRecordingNotifier } from '../src/notify/resend.js';
import { render } from '../src/emails.js';
import worker from '../src/index.js';

const NOW = Date.parse('2026-11-23T10:05:00Z');
const HOUR = 3600000;
const SETTINGS = { boardOrigin: 'https://board.example', staleAlertHours: 6 };
const urlFor = (site) => 'https://board.example/?location=' + site.boardLocation;

const job = (id, title, location, closingDate) => ({ id, title, location, closingDate: closingDate || '2099-01-01T23:59:59Z' });
const board = (jobs, meta) => parseBoardPayload({ jobs, meta: Object.assign({ stale: false, fetchedAt: '2026-11-23T08:00:00Z' }, meta) }, 'HIT');

async function check(previous, boardResult, opts) {
  const notifier = (opts && opts.notifier) || createRecordingNotifier();
  const result = await runCheck({
    nowMs: (opts && opts.nowMs) || NOW, boardResult, previous, sites: SITES, notifier, settings: SETTINGS, boardUrlFor: urlFor
  });
  return { result, sent: notifier.sent || [] };
}

async function started(jobs) {
  const { result } = await check(null, board(jobs));
  return result.state;
}

test('site matching follows the board: any capitalisation, closed vacancies left out, unmatched kept apart', () => {
  const jobs = [
    job('1', 'Test A', 'Fivemiletown, Co. Tyrone'),
    job('2', 'Test B', 'WREXHAM'),
    job('3', 'Test C', 'Manchester'),
    job('4', 'Test D', 'Fivemiletown', '2026-11-20T23:59:59Z'), // closed
    job('5', 'Test E', 'Head office'),
    job('6', 'Test F', 'Wrexham / Manchester')
  ];
  const { bySite, unmatched } = groupBySite(jobs, SITES, NOW);
  assert.deepEqual(bySite.fivemiletown.map((j) => j.id), ['1']);
  assert.deepEqual(bySite.wrexham.map((j) => j.id).sort(), ['2', '6']);
  assert.deepEqual(bySite.manchester.map((j) => j.id).sort(), ['3', '6']);
  assert.deepEqual(unmatched.map((j) => j.id), ['5']);
});

test('bad or stale board data is never read as "no vacancies"', () => {
  assert.equal(parseBoardPayload({ jobs: 'x', meta: {} }).ok, false);
  assert.equal(parseBoardPayload({ jobs: [{ nope: 1 }], meta: {} }).ok, false);
  assert.equal(parseBoardPayload({ jobs: [], meta: { stale: true } }).stale, true);
  assert.equal(parseBoardPayload({ jobs: [], meta: {} }, 'STALE').stale, true);
  const empty = parseBoardPayload({ jobs: [], meta: {} }, 'HIT');
  assert.equal(empty.ok, true);
  assert.equal(empty.stale, false);
});

test('first run sends one status email and remembers every site', async () => {
  const { result, sent } = await check(null, board([job('1', 'Test A', 'Fivemiletown'), job('5', 'Test E', 'Head office')]));
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /notifier started/);
  assert.match(sent[0].text, /Fivemiletown \(Canteen FMT\): 1 open – Test A/);
  assert.match(sent[0].text, /Wrexham \(Wrexham\): no open vacancies/);
  assert.match(sent[0].text, /Test E – location "Head office"/);
  assert.ok(result.state.startedAt);
  assert.deepEqual(result.state.unmatchedNotified, ['5']);
});

test('vacancies appearing at one site email once, for that site only', async () => {
  const state = await started([]);
  const first = await check(state, board([job('1', 'Test Planner', 'Wrexham', '2026-11-30T23:59:59Z')]));
  assert.equal(first.sent.length, 1);
  assert.equal(first.sent[0].subject, 'Internal Vacancies Available – Wrexham – Board Action Required');
  assert.match(first.sent[0].text, /1 internal vacancy is now open for Wrexham/);
  assert.match(first.sent[0].text, /Test Planner – closes 30 November/);
  assert.match(first.sent[0].text, /switch the Wrexham screen in Yodeck to the Thanks \+ Vacancies playlist/);

  const again = await check(first.result.state, board([job('1', 'Test Planner', 'Wrexham'), job('2', 'Test Two', 'Wrexham')]));
  assert.equal(again.sent.length, 0, 'more vacancies at an active site: no email');
});

test('last vacancy at a site going emails once and names it', async () => {
  const state = await started([job('1', 'Test A', 'Manchester')]);
  const gone = await check(state, board([]));
  assert.equal(gone.sent.length, 1);
  assert.equal(gone.sent[0].subject, 'No Internal Vacancies – Manchester – Board Action Required');
  assert.match(gone.sent[0].text, /Last listed:\n\n • Test A/);
  const quiet = await check(gone.result.state, board([]));
  assert.equal(quiet.sent.length, 0);
});

test('a vacancy passing its closing date counts as gone, as it does on the screen', async () => {
  const state = await started([job('1', 'Test A', 'Manchester', '2026-11-23T23:59:59Z')]);
  const nextDay = await check(state, board([job('1', 'Test A', 'Manchester', '2026-11-23T23:59:59Z')]), { nowMs: NOW + 24 * HOUR });
  assert.equal(nextDay.sent.length, 1);
  assert.match(nextDay.sent[0].subject, /No Internal Vacancies – Manchester/);
});

test('a failed email is retried on the next run, not lost', async () => {
  const state = await started([]);
  const failing = { send: async () => ({ ok: false, error: 'resend_500' }) };
  const failed = await check(state, board([job('1', 'Test A', 'Fivemiletown')]), { notifier: failing });
  assert.equal(failed.result.events[0].ok, false);
  assert.deepEqual(failed.result.state.sites.fivemiletown.jobs, []);
  const retry = await check(failed.result.state, board([job('1', 'Test A', 'Fivemiletown')]));
  assert.equal(retry.sent.length, 1);
  assert.match(retry.sent[0].subject, /Available – Fivemiletown/);
});

test('stale or unreachable data: no decisions, one problem email after 6 hours, one when it recovers', async () => {
  const state = await started([job('1', 'Test A', 'Fivemiletown')]);
  const staleBoard = board([], { stale: true, staleReason: 'upstream_timeout' });

  const h0 = await check(state, staleBoard);
  assert.equal(h0.sent.length, 0, 'stale empty list must not trigger "No Internal Vacancies"');
  const h5 = await check(h0.result.state, { ok: false, reason: 'board_http_502' }, { nowMs: NOW + 5 * HOUR });
  assert.equal(h5.sent.length, 0);
  const h6 = await check(h5.result.state, staleBoard, { nowMs: NOW + 6 * HOUR });
  assert.equal(h6.sent.length, 1);
  assert.match(h6.sent[0].subject, /can't get current vacancy data/);
  assert.match(h6.sent[0].text, /Talos is not answering \(upstream_timeout\)/);
  const h7 = await check(h6.result.state, staleBoard, { nowMs: NOW + 7 * HOUR });
  assert.equal(h7.sent.length, 0, 'problem email is not repeated');

  const back = await check(h7.result.state, board([job('1', 'Test A', 'Fivemiletown')]), { nowMs: NOW + 8 * HOUR });
  assert.equal(back.sent.length, 1);
  assert.match(back.sent[0].subject, /back to normal/);
  assert.equal(back.result.state.health.alerted, false);
});

test('an unmatched vacancy is reported once', async () => {
  const state = await started([]);
  const one = await check(state, board([job('9', 'Test Anywhere', 'All sites')]));
  assert.equal(one.sent.length, 1);
  assert.match(one.sent[0].text, /Test Anywhere – location "All sites"/);
  const two = await check(one.result.state, board([job('9', 'Test Anywhere', 'All sites')]));
  assert.equal(two.sent.length, 0);
});

test('Resend: correct request; CC dropped for the testing sender; placeholder means nothing is sent', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 'abc' }), { status: 200 });
  };
  const quietLog = { warn() {}, log() {} };
  const real = createResendNotifier({ apiKey: 'k', from: 'Notifier <alerts@example.com>', to: 'a@example.com', cc: 'b@example.com', fetchFn: fakeFetch, log: quietLog });
  const r = await real.send({ subject: 'S', text: 'T', html: '<p>T</p>', idempotencyKey: 'x' });
  assert.equal(r.ok, true);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k');
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'x');
  assert.deepEqual(calls[0].body.to, ['a@example.com']);
  assert.deepEqual(calls[0].body.cc, ['b@example.com']);

  const testing = createResendNotifier({ apiKey: 'k', from: 'Notifier <onboarding@resend.dev>', to: 'a@example.com', cc: 'b@example.com', fetchFn: fakeFetch, log: quietLog });
  await testing.send({ subject: 'S', text: 'T', html: '' });
  assert.equal(calls[1].body.cc, undefined);

  const placeholder = createResendNotifier({ apiKey: 'k', from: 'Notifier <REPLACE_WITH_VERIFIED_SENDER>', to: 'a@example.com', fetchFn: fakeFetch, log: quietLog });
  assert.equal((await placeholder.send({ subject: 'S', text: 'T' })).ok, false);
  const noKey = createResendNotifier({ apiKey: '', from: 'a@example.com', to: 'a@example.com', fetchFn: fakeFetch, log: quietLog });
  assert.equal((await noKey.send({ subject: 'S', text: 'T' })).ok, false);
  assert.equal(calls.length, 2);
});

test('email HTML is escaped', () => {
  const m = render('S', [{ p: '<b>x</b> & "y"' }]);
  assert.match(m.html, /&lt;b&gt;x&lt;\/b&gt; &amp; &quot;y&quot;/);
});

test('the Worker end to end: cron run reads the board through the binding, emails, saves; /run is hidden without a token', async () => {
  const kv = new Map();
  const env = {
    STATE: { get: async (k) => kv.get(k) || null, put: async (k, v) => { kv.set(k, v); } },
    BOARD: {
      fetch: async (req) => {
        assert.equal(new URL(req.url).pathname, '/api/jobs');
        return new Response(JSON.stringify({ jobs: [job('1', 'Test A', 'Fivemiletown')], meta: { stale: false } }), {
          status: 200, headers: { 'Content-Type': 'application/json', 'X-Jobs-Cache': 'HIT' }
        });
      }
    },
    BOARD_ORIGIN: 'https://board.example',
    EMAIL_FROM: 'Notifier <alerts@example.com>',
    EMAIL_TO: 'a@example.com',
    EMAIL_CC: 'b@example.com',
    STALE_ALERT_HOURS: '6',
    RESEND_API_KEY: 'k'
  };
  const realFetch = globalThis.fetch;
  const resendCalls = [];
  globalThis.fetch = async (url, init) => {
    resendCalls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: 'abc' }), { status: 200 });
  };
  const origLog = console.log;
  console.log = () => {};
  try {
    const pending = [];
    await worker.scheduled({}, env, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
  } finally {
    globalThis.fetch = realFetch;
    console.log = origLog;
  }
  assert.equal(resendCalls.length, 1);
  assert.match(resendCalls[0].subject, /notifier started/);
  assert.ok(JSON.parse(kv.get('state-v1')).startedAt);

  const res = await worker.fetch(new Request('https://notifier.example/run'), env);
  assert.equal(res.status, 404);
});

test('fetchBoard reports an unreachable board instead of throwing', async () => {
  const r = await fetchBoard({ origin: 'https://board.example', binding: { fetch: async () => { throw new Error('down'); } }, timeoutMs: 1000 });
  assert.deepEqual(r, { ok: false, reason: 'board_unreachable' });
});
