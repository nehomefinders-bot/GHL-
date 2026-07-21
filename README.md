# Realtor.com Agent Scraper

A small Windows desktop app that collects real estate agent contact info from
[realtor.com/realestateagents](https://www.realtor.com/realestateagents).

## What it does

1. Asks for a **zip code** in a simple window.
2. Opens Chrome, goes to the realtor.com "Find an Agent" page, selects **Both**
   (buy & sell), and searches your zip code.
3. Walks through **every results page** and opens each agent's profile.
4. Captures for every agent:
   - the **name header section** (name, brokerage, years of experience, rating, reviews)
   - the full **Contact information** section (phone, office address, website links)
5. Saves everything to `realtor_agents_<zip>.csv` next to the app — the file is
   updated after every agent, so you never lose progress. Open it in Excel.

## Getting the EXE

**Option A — GitHub builds it for you (no setup needed):**
Every push to this repo runs the *Build Windows EXE* workflow (see the
**Actions** tab). Open the latest run and download the **RealtorAgentScraper**
artifact — the `.exe` is inside the zip.

**Option B — build it yourself on Windows:**
1. Install [Python 3.10+](https://www.python.org/downloads/) (check "Add to PATH").
2. Double-click `build_exe.bat`.
3. Your exe appears at `dist\RealtorAgentScraper.exe`.

## Requirements to run

- **Google Chrome** must be installed (Selenium drives your real Chrome —
  the matching driver is downloaded automatically the first time).
- Internet connection.

## Usage

1. Run `RealtorAgentScraper.exe`.
2. Type a 5-digit zip code and click **Start scraping**.
3. A Chrome window opens and does the work — **leave it open**.
4. If realtor.com shows a "press & hold" / captcha check, complete it in the
   Chrome window; the scraper waits and then continues automatically.
5. When it says *Done*, open `realtor_agents_<zip>.csv` in Excel.

## Notes

- The browser is intentionally visible (not headless) — realtor.com blocks
  headless browsers.
- The scraper pauses randomly between pages to behave politely. A zip code
  with hundreds of agents can take a while.
- Use responsibly and in accordance with realtor.com's terms of service.
