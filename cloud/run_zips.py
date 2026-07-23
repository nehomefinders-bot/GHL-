"""Batch runner for GitHub Actions (or any CI / server).

Reads a list of zip codes from the ZIPS env var, scrapes realtor.com agents for
each one with a headless Chromium, and writes one CSV per zip into OUTPUT_DIR.
"""

import csv
import os
import re

from scraper import make_driver, scrape_zip, FIELDS


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
    print(f"Scraping {len(zips)} zip(s): {', '.join(zips)}", flush=True)

    driver = make_driver()
    try:
        for z in zips:
            print(f"=== Zip {z} ===", flush=True)
            try:
                rows = scrape_zip(driver, z, lambda m: print(m, flush=True),
                                  max_pages=max_pages)
            except Exception as exc:
                print(f"  zip {z}: FAILED ({exc})", flush=True)
                rows = []
            path = os.path.join(outdir, f"realtor_agents_{z}.csv")
            with open(path, "w", newline="", encoding="utf-8-sig") as f:
                w = csv.DictWriter(f, fieldnames=FIELDS)
                w.writeheader()
                w.writerows(rows)
            print(f"  zip {z}: saved {len(rows)} agents -> {path}", flush=True)
    finally:
        try:
            driver.quit()
        except Exception:
            pass
    print("All done.", flush=True)


if __name__ == "__main__":
    main()
