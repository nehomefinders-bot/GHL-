# Realtor.com Agent Scraper — Cloud / automated version

Run the scraper **on a server instead of your PC**, unattended. You give it a
list of zip codes, it scrapes realtor.com agents **one zip at a time**, and you
get a **CSV per zip**. It keeps going even with your computer off.

> ⚠️ **The one thing you must know.** realtor.com uses PerimeterX / HUMAN bot
> protection that blocks **datacenter / cloud IPs** (GitHub, Render, AWS — all of
> them). From a cloud host, with no unblock service, every zip returns **0
> agents**. This is not a bug — it's why the Chrome extension (which runs on your
> home IP) is the reliable free tool. To make the *cloud* version pull data, you
> add **one** paid-but-free-to-trial ingredient: a **scraping API key** *or* a
> **residential proxy**. Setup is below — it's literally one secret to paste.

## The three modes (chosen automatically)

The scraper looks at your environment variables and picks a backend:

| Mode | Turns on when… | What it does |
|---|---|---|
| **api** | `SCRAPER_API_KEY` is set | Fetches pages through a scraping API that supplies home IPs + solves the bot check + runs the page JS. **Easiest, most reliable.** No browser needed on the server. |
| **proxy** | `SCRAPER_PROXY` is set | Runs a headless Chrome through your residential proxy so the site's JS renders. |
| **direct** | neither is set | Plain headless Chrome, no proxy. Works from a home IP (your PC) but **blocked from the cloud** → 0 agents. |

Set **just one**. If both are set, the API key wins.

---

## Make it actually get data — pick ONE provider

Both options below have **free trials** (usually ~1,000 pages), enough to test on
a few zips before paying anything.

### ✅ Option A — Scraping API (recommended, easiest)

A scraping API gives you a single **API key**. Their servers handle the home IPs
and the bot check for you.

1. **Sign up** for a free trial (no charge to start):
   - **ScraperAPI** — <https://www.scraperapi.com> (~1,000 free credits), or
   - **ScrapingBee** — <https://www.scrapingbee.com> (~1,000 free credits)
2. **Copy your API key** from the provider's dashboard.
3. In GitHub: open your repo → **Settings** → **Secrets and variables** →
   **Actions** → **New repository secret**:
   - **Name:** `SCRAPER_API_KEY`  **Value:** *(paste your key)* → **Add secret**
4. **Only if you chose ScrapingBee** (ScraperAPI is the default), add a second secret:
   - **Name:** `SCRAPER_API_PROVIDER`  **Value:** `scrapingbee`
5. Start a run (see "How to start it" below). CSVs will now contain agents. 🎉

Optional extra secrets:
- `SCRAPER_API_COUNTRY` — exit-IP country, default `us`.
- `SCRAPER_API_RENDER` — `0` to skip JavaScript rendering (cheaper on credits; try
  it, and if zips come back empty, remove it so rendering is on).

### Option B — Residential proxy

A residential proxy routes traffic through real home IPs. You get one URL.

1. **Sign up** for a residential proxy (pay-as-you-go; some have trials):
   e.g. **IPRoyal**, **Decodo (Smartproxy)**, **Bright Data**.
2. From the dashboard, get the connection string, which looks like:
   `http://USERNAME:PASSWORD@HOST:PORT`
   (use the **US, residential, rotating** endpoint if they offer a choice).
3. GitHub → **Settings** → **Secrets and variables** → **Actions** →
   **New repository secret**:
   - **Name:** `SCRAPER_PROXY`  **Value:** `http://USERNAME:PASSWORD@HOST:PORT`
4. Start a run. Done.

---

## How to start it (free, on GitHub — no card, PC can be off)

GitHub Actions runs your code on GitHub's servers for free. This repo already
includes the workflow.

### Easiest: edit `cloud/zips.txt`

1. On GitHub, open **`cloud/zips.txt`** → click the **pencil (Edit)** icon.
2. Put your **zip codes, one per line** (delete the samples). Optional: a line
   `pages: 2` limits pages per zip while testing.
3. Click **Commit changes** — that commit **auto-starts** the scraper.
4. **Actions** tab → the running **Scrape Realtor Zips** job → when it finishes,
   download the **realtor-csvs** artifact (one `realtor_agents_<zip>.csv` per zip).

### Or: the Run workflow button

Actions tab → **Scrape Realtor Zips** → **Run workflow** → paste zips → Run.

### Run it automatically on a schedule

Open `.github/workflows/scrape-zips.yml`, find the `schedule:` block near the top,
and delete the `#` marks to enable it. The example runs **every Monday ~9am US
Eastern** using whatever zips are in `cloud/zips.txt`. Edit the cron to taste
(<https://crontab.guru> helps). Only enable this **after** you've set a provider
secret, or it will just email you empty CSVs.

---

## Deploy as an always-on web app (optional)

Instead of GitHub Actions, you can host `app.py` as a small website where you
paste zips in a form. Same three modes; set the provider as an **environment
variable / secret** on the host (`SCRAPER_API_KEY` or `SCRAPER_PROXY`).

- **Render** — `cloud/render.yaml` blueprint included (free plan now needs card
  verification).
- **Hugging Face Spaces** (Docker) — upload `Dockerfile`, `app.py`, `scraper.py`,
  `requirements.txt`; set the provider secret under **Settings → Variables and
  secrets**. Listens on port **7860**.
- **Railway / Fly.io** — same `Dockerfile`, card required.

## Run locally (optional)

```
cd cloud
pip install -r requirements.txt
python app.py            # open http://localhost:7860  (needs Chrome for browser modes)
```

From your home IP, "direct" mode may work without any provider — handy for testing.

## Notes

- One job at a time; starting a new one replaces the previous list.
- Free cloud instances have modest RAM — Chromium is heavy, so in browser modes
  scrape a handful of zips at a time. "api" mode needs no browser and is lighter.
- Use responsibly and in line with realtor.com's terms of service.
</content>
