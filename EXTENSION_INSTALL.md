# Realtor.com Agent Scraper — Chrome Extension (recommended)

realtor.com uses aggressive bot protection (PerimeterX / HUMAN) that blocks any
browser driven by automation tools like Selenium — that's why the standalone
`.exe` kept hitting the "Your request could not be processed" page.

This **Chrome extension** solves that: it runs *inside your own normal Chrome*,
so realtor.com sees ordinary browsing and does not block it. No antivirus
warnings either, because there's no `.exe`.

## Install (one time, ~1 minute)

1. Download **`RealtorAgentScraper-Extension.zip`** from this repo.
2. **Right-click → Extract All** to a folder you'll keep (e.g. Documents).
   You should end up with a folder containing `manifest.json`, `popup.html`,
   and `popup.js`.
3. Open Chrome and go to: `chrome://extensions`
4. Turn on **Developer mode** (toggle, top-right).
5. Click **Load unpacked** and select the extracted folder.
6. The "Realtor.com Agent Scraper" icon appears in your toolbar. (Click the
   puzzle-piece icon and pin it so it's always visible.)

## Use (bulk — paste a list of ZIPs and walk away)

1. Open **https://www.realtor.com** in a tab and browse for a moment so it loads
   normally. If a "press & hold" or other check appears, complete it once
   (you're a human, so this just works). Stay on a realtor.com tab.
2. Click the **Realtor.com Agent Scraper** toolbar icon.
3. **Paste your ZIP codes, one per line** — you can paste dozens at once.
   Optionally set **Max pages per ZIP** (e.g. `5`) to test; leave it **blank to
   scrape every page** of every ZIP.
4. Click **Scrape all ZIPs**. A black progress box appears on the page. It walks
   every results page for each ZIP and opens each agent (in hidden background
   frames) to grab the name section and full **Contact information**. You can
   close the little popup — it keeps running.
5. **Keep the tab open and your PC awake** (you can minimise Chrome and use other
   apps). It **auto-downloads** to your Downloads folder:
   - `realtor_agents_<zip>.csv` after each ZIP finishes, and
   - one combined `realtor_agents_ALL_<n>zips.csv` at the end (every ZIP in one
     file, with a `search_zip` column). Open in Excel.
6. If any ZIP shows **0 agents** (an occasional block), the progress box lists
   exactly which ZIPs — just re-run those few.

> It works by reading the pages the way your browser renders them and loading
> further pages in hidden background frames within your own session — so
> realtor.com serves it just like normal clicking, and never blocks it. Because
> it runs in your real Chrome (your own IP, no automation fingerprint), it beats
> the bot protection that stops the cloud/exe versions.

## Notes

- Everything happens in your real session, so there's no bot block and no
  chromedriver.
- A ZIP with hundreds of agents can take several minutes; it fetches politely
  with small pauses.
- If realtor.com ever shows a block mid-run, just browse the site normally for a
  moment in that tab and click Scrape again.
- Use responsibly and in line with realtor.com's terms of service.
