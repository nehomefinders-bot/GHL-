# Realtor.com Agent Scraper — Cloud version (by JAWAD AHMAD)

A web app you host in the cloud. You paste a **list of zip codes**, it scrapes
realtor.com agents **one zip at a time** in the background, and gives you a
**downloadable CSV after each zip**. The job runs on the server, so it keeps
going **even if you close your browser or shut down your PC**.

> ⚠️ **Important reality check.** realtor.com uses PerimeterX/HUMAN bot
> protection that blocks **datacenter / cloud IPs** very aggressively. Running
> from a free cloud host, you should expect the "Your request could not be
> processed" block, and zips will return **0 agents**. This is the same wall the
> desktop `.exe` hit. To actually get data from the cloud you must route traffic
> through a **residential proxy** — set it in the `SCRAPER_PROXY` environment
> variable (see below). Without that, treat this as a test harness.

## What it does

- Textarea for zip codes (one per line).
- Optional "max pages per zip" (blank = all pages).
- Background worker scrapes each zip in turn using a headless Chromium (so the
  site's JavaScript runs and the agent list renders).
- Writes `realtor_agents_<zip>.csv` after each zip; download links appear on the
  page (which auto-refreshes while running).
- `/health` endpoint for uptime pings.

## Deploy free on Render.com (easiest)

1. Push this repo to GitHub (already done if you're reading this there).
2. Create a free account at <https://render.com> and connect your GitHub.
3. Click **New + → Blueprint**, pick this repo. Render reads `cloud/render.yaml`
   and builds the Docker service on the **free** plan.
   - (Or **New + → Web Service → Docker**, set root/context to `cloud`.)
4. When it's live you get a URL like `https://realtor-agent-scraper.onrender.com`.
5. Open it, paste zip codes, click **Start scraping**.

### Keep it awake with your PC off (free)

Render's free plan sleeps a service after ~15 minutes with no web traffic. To
keep a long job running while your PC is off, add a free uptime pinger:

1. Sign up at <https://uptimerobot.com> (free) or <https://cron-job.org> (free).
2. Add an HTTP monitor for `https://<your-app>.onrender.com/health` every 5 min.

That steady ping keeps the instance awake so the background scrape continues.

### Make it actually get past realtor.com (residential proxy)

In Render → your service → **Environment** → add:

```
SCRAPER_PROXY = http://USER:PASS@HOST:PORT
```

Use a **residential** proxy (e.g. from a provider's free trial). Datacenter
proxies are usually blocked too. Redeploy; no code change needed.

## Other free hosts

- **Railway** (<https://railway.app>) — deploy from GitHub, $5 free trial credit,
  stays up continuously (good for unattended runs).
- **Fly.io** (<https://fly.io>) — `fly launch` in the `cloud/` folder; free
  allowance keeps a small VM running.

Both use the same `Dockerfile`.

## Run locally (optional)

```
cd cloud
pip install -r requirements.txt
python app.py
# open http://localhost:8000  (needs Chrome/Chromium installed)
```

## Notes

- One job at a time; starting a new one replaces the previous job's list.
- Free instances have ~512MB RAM — Chromium is heavy, so scrape a few zips at a
  time for stability.
- Use responsibly and in line with realtor.com's terms of service.
