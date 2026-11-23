/* What the notifier remembers between runs, kept as one small JSON value in Workers KV. */

const KEY = 'state-v1';

export function emptyState() {
  return {
    v: 1,
    startedAt: null, // set once the "notifier started" email has gone
    sites: {}, // site key -> { jobs: [{ id, title, closingDate }], changedAt }
    health: { badSince: null, alerted: false, reason: '' },
    unmatchedNotified: [] // ids of unmatched vacancies already emailed about
  };
}

export async function loadState(kv) {
  const raw = await kv.get(KEY);
  if (!raw) return null;
  try {
    const state = JSON.parse(raw);
    return state && state.v === 1 ? state : null;
  } catch (err) {
    return null;
  }
}

export async function saveState(kv, state) {
  await kv.put(KEY, JSON.stringify(state));
}
