"""Batch runner for GitHub Actions (or any CI / server).

Reads a list of zip codes from the ZIPS env var, scrapes realtor.com agents for
each one with a headless Chromium, and writes one CSV per zip into OUTPUT_DIR.
"""

import csv
import os
import re

from scraper import make_driver, scrape_zip, FIELDS


def main():
    zips = re.findall(r"\d{5}", os.environ.get("ZIPS", ""))
    max_pages = int(os.environ.get("MAX_PAGES") or 0)
    outdir = os.environ.get("OUTPUT_DIR", "outputs")
    os.makedirs(outdir, exist_ok=True)

    if not zips:
        print("No zip codes provided in ZIPS.")
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
