# Realtor.com Agent Scraper — cloud / automated (your own logic)

Run the scraper **unattended on a server or a home machine** instead of clicking
through it. You give it a list of zip codes; it scrapes realtor.com agents **one
zip at a time** and writes a **CSV per zip**.

**All the scraping is our own code.** A headless Chrome loads the find-an-agent
pages and each agent profile, and we read the name + contact details straight
from the page. No third-party scraping service is involved.

> ⚠️ **The one thing that matters: your IP.** realtor.com uses PerimeterX / HUMAN
> bot protection that blocks **datacenter / cloud IPs** (GitHub, Render, AWS…).
> It does **not** block ordinary home connections. So the only real question is
> *where you run this*:
>
> * **On a residential IP** (your own PC, or an always-on machine at home) →
>   **free, self-contained, and it gets data.** ✅
> * **On a cloud/datacenter host** → the IP is blocked → 0 agents, unless you send
>   the browser out through a **residential proxy** (an IP tunnel — it does no
>   scraping; our code still does all of it).

## The two modes (auto-selected)

| Mode | Turns on when… | Traffic goes out via |
|---|---|---|
| **direct** | nothing set | this machine's own IP (great from home) |
| **proxy** | `SCRAPER_PROXY` set | your residential proxy (for cloud/datacenter hosts) |

---

## ✅ Recommended free way: run it on a home/residential IP

No proxy, no service, no monthly fee — just your own code on a connection
realtor.com doesn't block.

### On your own PC (simplest)

```
cd cloud
pip install -r requirements.txt        # Flask, Selenium (needs Chrome installed)
python app.py                          # opens a little web page at http://localhost:7860
```

Paste your zips, click **Start scraping**, download a CSV per zip. Or skip the
web page and run a batch straight to CSV files:

```
cd cloud
ZIPS="30303 30305 30309" python run_zips.py    # writes outputs/realtor_agents_<zip>.csv
```

### Unattended at home (PC can be closed? use an always-on box)

To have it run on a schedule with your main PC off, put it on any cheap
always-on device on your home internet — an old laptop, a mini-PC, a Raspberry
Pi. Then schedule `run_zips.py`:

- **Windows:** Task Scheduler → new task → run `python C:\path\to\cloud\run_zips.py`.
- **Mac/Linux:** a `cron` entry, e.g. weekly Monday 9am:
  ```
  0 9 * * 1  cd /path/to/cloud && ZIPS="30303 30305" /usr/bin/python3 run_zips.py
  ```

Because it's your home IP, it just works — no proxy needed.

> **The Chrome extension** in the repo root is the same idea with zero setup: it
> runs inside your own Chrome (your IP), takes a list of zips, and downloads a
> CSV per zip. If you don't need it fully hands-off, that's the easiest tool.

---

## Run it in the cloud (GitHub Actions) — needs a residential proxy

GitHub can run it on a schedule with your PC off, but GitHub's servers use
datacenter IPs that realtor.com blocks. To get data you must add a **residential
proxy** (this is just an IP route; our code still does every bit of the scraping).

### Start a run

1. **Easiest:** open **`cloud/zips.txt`** on GitHub → pencil (Edit) → put your
   zips, one per line → **Commit**. That auto-starts the **Scrape Realtor Zips**
   job. Optional: a line `pages: 2` limits pages per zip while testing.
2. **Or:** Actions tab → **Scrape Realtor Zips** → **Run workflow** → paste zips.
3. When it finishes: Actions → the run → download the **realtor-csvs** artifact.

### Add the residential proxy

1. Get a **US residential** proxy (pay-as-you-go; some offer trials): e.g.
   IPRoyal, Decodo (Smartproxy), Bright Data. Datacenter proxies are blocked too.
2. Copy the connection string: `http://USERNAME:PASSWORD@HOST:PORT`.
3. GitHub → **Settings → Secrets and variables → Actions → New repository secret**:
   - **Name:** `SCRAPER_PROXY`  **Value:** `http://USERNAME:PASSWORD@HOST:PORT`
4. Run it again — CSVs will now contain agents.

> 💡 **Keeping proxy cost down.** Residential proxies bill by data used, so the
> scraper **skips images by default** (agent names + phone numbers are text) —
> that cuts most of the bandwidth. A typical ZIP costs only cents. Set
> `LOAD_IMAGES=1` if you ever want photos fetched too.

### Run it automatically on a schedule

Open `.github/workflows/scrape-zips.yml`, find the `schedule:` block near the top,
and delete the `#` marks to enable it (example: Mondays ~9am US Eastern, using
`cloud/zips.txt`). Only enable this after `SCRAPER_PROXY` is set, or it writes
empty CSVs. (<https://crontab.guru> helps with the timing.)

> **Don't want to pay for a proxy?** Use the free home-IP path above instead —
> same code, same CSVs. The proxy only exists to give a datacenter host a
> home-style IP.

---

## Host the web app somewhere always-on (optional)

`app.py` can also run as a small always-on website (paste zips in a form). On a
datacenter host you'll still need `SCRAPER_PROXY`; on a home box you won't.

- **Render** — `cloud/render.yaml` blueprint included (set `SCRAPER_PROXY` as a
  dashboard secret).
- **Hugging Face Spaces / Railway / Fly.io** — same `Dockerfile`.

## Notes

- One job at a time; starting a new one replaces the previous list.
- Chromium is memory-hungry, so on a small box scrape a handful of zips at a time.
- Use responsibly and in line with realtor.com's terms of service.
</content>
