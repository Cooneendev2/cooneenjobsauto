/* The sites the notifier watches.

   `match` is the same rule the board uses for ?location=: a vacancy belongs to a site when its
   location contains one of these words, in any capitalisation. So the notifier counts exactly the
   vacancies that the site's screen shows.

   `boardLocation` is the value in that screen's board address (used for the link in the emails).
   `screen` is how the emails name the Yodeck screen. */
export const SITES = [
  { key: 'fivemiletown', name: 'Fivemiletown', screen: 'Canteen FMT', match: ['fivemiletown'], boardLocation: 'Fivemiletown' },
  { key: 'wrexham', name: 'Wrexham', screen: 'Wrexham', match: ['wrexham'], boardLocation: 'wrexham' },
  { key: 'manchester', name: 'Manchester', screen: 'Manchester', match: ['manchester'], boardLocation: 'manchester' }
];

/* The settings every site's board address shares (location= is added per site). */
export const BOARD_QUERY = 'mode=duo&showLocation=1&fullLocation=0';

export const GREETING = 'Hi Hugh,';

export const DEFAULTS = {
  staleAlertHours: 6,
  boardTimeoutMs: 30000,
  timezone: 'Europe/London'
};
