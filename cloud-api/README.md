# Realtor Agent Scraper — Cloud edition (no PC, no browser, no proxy)

This is the **cloud** version of the scraper. It runs on GitHub's servers, so
your PC can be **off**. It pulls realtor.com agent contact info (name, phone,
brokerage, office, website) by ZIP code and hands you a CSV.

It talks to realtor.com's own data API directly — no Chrome, no Selenium, no
residential proxy. That API answers from a plain datacenter IP, which is why
this works from GitHub for free.

---

## The easy way — run it from the Actions tab

1. Go to the repo's **Actions** tab on GitHub.
2. On the left, click **“Scrape Realtor Agents (API - cloud, no proxy)”**.
3. Click **Run workflow** (top right).
4. In the **ZIP codes** box, paste your ZIPs — comma, space, or newline
   separated, e.g. `30002, 78628, 76522`. (Leave it blank to use the ZIPs
   saved in `cloud-api/zips.txt`.)
5. Click the green **Run workflow** button.
6. Wait for the run to finish (green check), open it, and scroll to
   **Artifacts** at the bottom. Download **`realtor-agent-csvs`** — a zip with:
   - `realtor_agents_<zip>.csv` — one file per ZIP, and
   - `realtor_agents_ALL.csv` — everything combined.

That's it. Open the CSV in Excel. The phone column holds **only the agent's own
listed number** — if an agent has no phone on realtor, that cell is blank
(the office/brokerage line is kept separately in `contact_information`, labeled
`Office ph:`, so it never masquerades as the agent's cell).

## The other easy way — edit the ZIP list

Edit **`cloud-api/zips.txt`** (one ZIP per line), commit it, and the workflow
runs itself. Grab the CSVs from that run's **Artifacts** as above.

## Recurring runs (fully hands-off)

Open `.github/workflows/scrape-agents.yml` and uncomment the `schedule` block:

```yaml
schedule:
  - cron: "0 13 * * 1"   # every Monday 13:00 UTC
```

It'll run on that schedule with your PC off and stash the CSVs on each run.

---

## Run it on your own machine (optional)

Needs Node 18+ (for built-in `fetch`).

```bash
cd cloud-api

# ZIPs via env var:
ZIPS="30002,78628,76522" node scraper.js

# ...or as arguments:
node scraper.js 30002 78628

# ...or one per line in zips.txt, then just:
node scraper.js
```

CSVs land in `cloud-api/output/`.

### Settings (environment variables)

| Variable      | Default              | What it does                                        |
|---------------|----------------------|-----------------------------------------------------|
| `ZIPS`        | (falls back to file) | ZIPs to scrape (comma / space / newline separated). |
| `OUTPUT_DIR`  | `cloud-api/output`   | Where the CSVs are written.                         |
| `CACHE_FILE`  | `cloud-api/.agent_cache.json` | 7-day cache of fetched agents.             |
| `PACE_MS`     | `700`                | Starting delay between requests (ms). Auto-adjusts. |

---

## How it stays fast without getting blocked

- **Adaptive pacing.** It starts brisk (~0.7s between calls) and speeds up while
  things are healthy. The instant realtor pushes back (HTTP 429/403), it eases
  off automatically and recovers — no more “waits n waits n waits” stalls.
- **7-day cache.** Agents already fetched in the last week are reused, so
  repeat runs are near-instant and gentle. The Actions workflow carries this
  cache across runs for you.
- **Batching.** Agent profiles are fetched several at a time in one request,
  with a single-request fallback if the batch endpoint is unavailable.

## Files

| File                                   | What it is                                  |
|----------------------------------------|---------------------------------------------|
| `scraper.js`                           | The scraper (Node, zero dependencies).      |
| `zips.txt`                             | Default ZIP list (edit + commit to run).    |
| `output/`                              | Generated CSVs (created on run).             |
| `../.github/workflows/scrape-agents.yml` | The GitHub Actions workflow that runs it. |

> This is a companion to the Chrome extension in `../extension/`. Same data,
> same rules — this one just runs in the cloud instead of your browser.
