"""Batch runner for a server / scheduler (GitHub Actions, a home machine, cron).

Reads a list of zip codes from the ZIPS env var (or cloud/zips.txt), scrapes
realtor.com agents for each one with our own headless browser, and writes one
CSV per zip into OUTPUT_DIR.

Traffic goes out direct, or through a residential proxy if SCRAPER_PROXY is set
- see scraper.py. The scraping logic is entirely ours either way.
"""

import csv
import os
import re

from scraper import Scraper, FIELDS, active_mode


def read_zips_file():
    """Fallback input: read zip codes (and optional 'pages: N') from zips.txt."""
    path = os.path.join(os.path.dirname(__file__), "zips.txt")
    zips, max_pages = [], 0
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for line in f:
                s = line.strip()
                if not s or s.startswith("#"):
                    continue
                mp = re.match(r"pages?\s*[:=]\s*(\d+)", s, re.I)
                if mp:
                    max_pages = int(mp.group(1))
                    continue
                zips += re.findall(r"\d{5}", s)
    return zips, max_pages


def main():
    zips = re.findall(r"\d{5}", os.environ.get("ZIPS", ""))
    max_pages = int(os.environ.get("MAX_PAGES") or 0)
    if not zips:  # no manual inputs -> use the committed zips.txt
        zips, file_pages = read_zips_file()
        if not max_pages:
            max_pages = file_pages
    outdir = os.environ.get("OUTPUT_DIR", "outputs")
    os.makedirs(outdir, exist_ok=True)

    if not zips:
        print("No zip codes found (ZIPS env empty and cloud/zips.txt has none).")
        return

    mode = active_mode()
    print(f"Scraping {len(zips)} zip(s): {', '.join(zips)}", flush=True)
    print(f"Backend: headless browser ({mode})", flush=True)
    if mode == "direct":
        print("NOTE: running 'direct' (no proxy). This works from a residential "
              "IP - your own PC or a home server. From a cloud/datacenter IP "
              "(e.g. GitHub's servers) realtor.com blocks it and every zip "
              "returns 0 agents; either run this on a home connection or set a "
              "residential proxy in SCRAPER_PROXY. See cloud/README.md.", flush=True)

    log = lambda m: print(m, flush=True)
    total = 0
    scraper = Scraper(log)
    try:
        for z in zips:
            print(f"=== Zip {z} ===", flush=True)
            try:
                rows = scraper.scrape_zip(z, max_pages=max_pages)
            except Exception as exc:
                print(f"  zip {z}: FAILED ({exc})", flush=True)
                rows = []
            path = os.path.join(outdir, f"realtor_agents_{z}.csv")
            with open(path, "w", newline="", encoding="utf-8-sig") as f:
                w = csv.DictWriter(f, fieldnames=FIELDS)
                w.writeheader()
                w.writerows(rows)
            total += len(rows)
            print(f"  zip {z}: saved {len(rows)} agents -> {path}", flush=True)
    finally:
        scraper.close()
    print(f"All done. {total} agents across {len(zips)} zip(s).", flush=True)
    if total == 0 and mode == "proxy":
        print("0 agents with a proxy set: check that SCRAPER_PROXY is a working, "
              "US residential proxy (datacenter proxies are blocked too).",
              flush=True)


if __name__ == "__main__":
    main()
