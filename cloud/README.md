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

## Deploy free on Hugging Face Spaces (NO credit card) — recommended

Render/Railway/Fly all ask for a card now. **Hugging Face Spaces is free, needs
no card, and gives more RAM (good for Chromium).** It also only sleeps after
~48h idle (not 15 min), so a long job keeps running with your PC off.

1. Make a free account at <https://huggingface.co/join> (no card).
2. Go to <https://huggingface.co/new-space>:
   - **Space name**: e.g. `realtor-agent-scraper`
   - **SDK**: choose **Docker** → **Blank**
   - Visibility: Public is fine (or Private).
   - Click **Create Space**.
3. On the Space page open the **Files** tab → **Add file → Upload files**, and
   upload these four files from the `cloud/` folder:
   - `Dockerfile`
   - `app.py`
   - `scraper.py`
   - `requirements.txt`
   Commit. The Space builds automatically (a few minutes — watch the **Logs**).
4. When it says *Running*, click **App**. Your URL looks like
   `https://<username>-realtor-agent-scraper.hf.space`.
5. Paste zip codes, click **Start scraping**. The job runs on Hugging Face's
   server — close your browser / PC and it keeps going.

> The app listens on port **7860**, which is what Docker Spaces expect — no extra
> config needed.

### Make it actually get past realtor.com (residential proxy)

Cloud IPs are blocked by realtor.com. To fix, add a proxy env var:
Space → **Settings** → **Variables and secrets** → **New secret**:

```
SCRAPER_PROXY = http://USER:PASS@HOST:PORT
```

Use a **residential** proxy (many providers have free trials). Datacenter
proxies are usually blocked too. The Space restarts and uses it — no code change.

## Other hosts (these ask for a card)

- **Render** (<https://render.com>) — `cloud/render.yaml` blueprint is included,
  but the free plan now requires card verification.
- **Railway** (<https://railway.app>) — $5 trial credit, card required.
- **Fly.io** (<https://fly.io>) — `fly launch` in `cloud/`, card required.

All use the same `Dockerfile`.

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
