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

## Getting the app

The app ships as a **zip** (a folder-based build). This avoids the Windows
Defender false-positive that single-file PyInstaller exes commonly trigger.

**Option A — GitHub builds it for you (no setup needed):**
Every push to this repo runs the *Build Windows EXE* workflow (see the
**Actions** tab), and commits `RealtorAgentScraper.zip` to the repo. Download
that zip, **extract it**, and run `RealtorAgentScraper.exe` from inside the
extracted folder (keep the `_internal` folder next to it).

**Option B — build it yourself on Windows:**
1. Install [Python 3.10+](https://www.python.org/downloads/) (check "Add to PATH").
2. Double-click `build_exe.bat`.
3. Your app appears at `dist\RealtorAgentScraper\` — run the `.exe` in there.

## Requirements to run

- **Google Chrome** must be installed (Selenium drives your real Chrome —
  the matching driver is downloaded automatically the first time).
- Internet connection.

## Usage (assisted mode)

realtor.com is protected by an aggressive bot-defense system (PerimeterX /
HUMAN) that blocks fully-automated visits. This tool works *with* you: you clear
the one-time human check, then it does all the tedious scraping.

1. Run `RealtorAgentScraper.exe`.
2. Type a 5-digit zip code and click **Start scraping**.
3. Your **real Chrome** opens on realtor.com — **leave it open**.
4. In that Chrome window:
   - If a block page or **"press & hold"** check appears, complete it (a human
     can; a bot can't — that's the whole point).
   - Search your **ZIP** and choose **Both**, so the list of agents appears.
5. The moment the agent list is on screen, the tool **detects it and takes
   over** — walking every results page and every agent profile automatically.
6. When it says *Done*, open `realtor_agents_<zip>.csv` in Excel.

The tool uses a dedicated, saved Chrome profile, so once you've cleared the
check, later runs usually skip straight through without asking again.

## Notes

- The browser is intentionally visible (not headless) — realtor.com blocks
  headless and automated browsers.
- A zip code with hundreds of agents can take a while; the CSV is written after
  every agent so you never lose progress.
- Use responsibly and in accordance with realtor.com's terms of service.
