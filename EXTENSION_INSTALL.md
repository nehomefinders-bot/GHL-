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

## Use

1. Go to **https://www.realtor.com** → **Find an Agent**. If a "press & hold" or
   other check appears, complete it once (you're a human, so this just works).
2. **Search your ZIP and choose "Both"** so the list of agents is showing on the
   page.
3. Click the **Realtor.com Agent Scraper** toolbar icon, then **Scrape agents on
   this search**.
4. A black progress box appears on the page. It reads the agent list, walks
   every results page, and opens each agent (in the background) to grab the name
   section and full **Contact information**. You can close the little popup — it
   keeps running.
5. When it finishes it **auto-downloads** `realtor_agents_<location>.csv` to your
   Downloads folder. Open it in Excel.

> It works by reading the pages the way your browser renders them and loading
> further pages in hidden background frames within your own session — so
> realtor.com serves it just like normal clicking, and never blocks it.

## Notes

- Everything happens in your real session, so there's no bot block and no
  chromedriver.
- A ZIP with hundreds of agents can take several minutes; it fetches politely
  with small pauses.
- If realtor.com ever shows a block mid-run, just browse the site normally for a
  moment in that tab and click Scrape again.
- Use responsibly and in line with realtor.com's terms of service.
