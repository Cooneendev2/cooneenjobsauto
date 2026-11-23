# Cooneen vacancy notifier

A small Cloudflare Worker that checks the internal vacancy board every hour and emails when a site's vacancies **start** or **end**,
so the right Yodeck screen can be switched by hand. It never changes Yodeck and never changes the board.

| Site | Screen | Counts vacancies whose location contains |
|---|---|---|
| Fivemiletown | Canteen FMT | `fivemiletown` |
| Wrexham | Wrexham | `wrexham` |
| Manchester | Manchester | `manchester` |

That is the same rule the board's `?location=` uses, so the notifier counts exactly what each screen shows. Sites live in `src/config.js`.

## Emails (To: Hugh, CC: Kevin)

| When | Subject |
|---|---|
| First run | Vacancy notifier started – current status |
| A site goes from none to some | Internal Vacancies Available – *Site* – Board Action Required (lists titles and closing dates) |
| A site goes from some to none | No Internal Vacancies – *Site* – Board Action Required (names the last vacancy) |
| An open vacancy matches no site | Internal vacancy not shown on any site screen – check location (once per vacancy) |
| No fresh data for 6 hours | Vacancy notifier – can't get current vacancy data (once), then "back to normal" |

Nothing else sends email: more vacancies at a site that already has some, or a site staying empty, is silent.
A failed read of the board is never treated as "no vacancies". If an email fails to send, it is retried on the next run.

## Set up

1. **GitHub**: put this folder in its own repository (or its own top-level folder in the board's repository).
2. **KV store**: run `npx wrangler kv namespace create STATE` and paste the id it prints into `wrangler.jsonc`
   (replacing `REPLACE_WITH_KV_NAMESPACE_ID`).
3. **Board link**: `services` in `wrangler.jsonc` points at the board Worker, `cooneenjobs3`. Change it if the board Worker is renamed.
4. **Secrets** (never in GitHub): in the dashboard, Workers → `cooneen-vacancy-notifier` → Settings → Variables and Secrets, add as **Secret**:
   - `RESEND_API_KEY` – a Resend key with sending access only
   - `RUN_TOKEN` – optional, any long random string; turns on `/run` and `/status`

   Or from a terminal: `npx wrangler secret put RESEND_API_KEY`.
5. **Sender**: set `EMAIL_FROM` in `wrangler.jsonc`.
   - Until a domain is verified in Resend, use `Vacancy Notifier <onboarding@resend.dev>`. Resend then only delivers to the address the
     Resend account was made with, so the Worker leaves Kevin off automatically.
   - Once a domain (ideally a subdomain of cooneen.com) is verified, change it to an address on that domain and Kevin is copied in.
6. **Deploy**: `npx wrangler deploy`, or connect the repository in the dashboard with the deploy command `npx wrangler deploy`
   (root directory = this folder).

Until `RESEND_API_KEY` is set and `EMAIL_FROM` is no longer the placeholder, every run just logs the email it would have sent
(Workers → this Worker → Logs) and remembers nothing, so the first email goes out as soon as both are in place.

## Checking it by hand (needs `RUN_TOKEN`)

```
https://cooneen-vacancy-notifier.<your-subdomain>.workers.dev/run?dry=1&token=<RUN_TOKEN>   what it would send now; sends and saves nothing
https://cooneen-vacancy-notifier.<your-subdomain>.workers.dev/run?token=<RUN_TOKEN>         a real check, same as the hourly one
https://cooneen-vacancy-notifier.<your-subdomain>.workers.dev/status?token=<RUN_TOKEN>      what it currently remembers
```

Without `RUN_TOKEN` both addresses answer 404. To start over (and get a fresh "notifier started" email), delete the key
`state-v1` from the `STATE` KV namespace.

## Timing

The board gets new data from Talos at 08:00 and 12:00 London time, so a vacancy posted at 13:00 is emailed about after 08:00 the next day,
when it also appears on the screens. The notifier runs at 5 past every hour; most runs find nothing new.

## Files

```
src/index.js          Cloudflare entry: hourly cron, /run, /status
src/monitor.js        the rules (no Cloudflare code; portable)
src/board.js          reads /api/jobs, works out each site's vacancies
src/emails.js         wording of every email
src/notify/resend.js  sending through Resend (swap this file to change provider)
src/state.js          what is remembered between runs (one KV value)
src/config.js         sites, board address settings, greeting
tests/                npm test (Node 20+, no packages)
```
