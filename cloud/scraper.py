"""Headless realtor.com agent scraper (one zip at a time).

Runs a real (headless) Chromium so the site's JavaScript executes and the agent
list renders. realtor.com is protected by PerimeterX/HUMAN, which blocks
datacenter IPs aggressively - set the SCRAPER_PROXY env var to a (residential)
proxy to get through from a cloud host.
"""

import os
import re
import time
import random

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.common.exceptions import TimeoutException, WebDriverException

BASE_URL = "https://www.realtor.com/realestateagents"
PROFILE_RE = re.compile(r"/realestateagents/([0-9a-f]{24})\b")
FIELDS = ["name", "name_section", "contact_information",
          "phones", "website_links", "profile_url"]
BLOCK_MARKERS = ("your request could not be processed",
                 "access to this page has been denied",
                 "press & hold", "press and hold", "verify you are human")
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")


def _pause(lo=1.0, hi=2.5):
    time.sleep(random.uniform(lo, hi))


def make_driver():
    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--disable-gpu")
    opts.add_argument("--window-size=1400,1000")
    opts.add_argument("--lang=en-US")
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_argument(f"--user-agent={USER_AGENT}")

    proxy = os.environ.get("SCRAPER_PROXY")
    if proxy:
        opts.add_argument(f"--proxy-server={proxy}")

    chrome_bin = os.environ.get("CHROME_BIN")
    if chrome_bin:
        opts.binary_location = chrome_bin

    driver_path = os.environ.get("CHROMEDRIVER")
    if driver_path:
        driver = webdriver.Chrome(service=Service(driver_path), options=opts)
    else:
        driver = webdriver.Chrome(options=opts)  # Selenium Manager resolves the driver

    driver.set_page_load_timeout(60)
    try:
        driver.execute_cdp_cmd(
            "Page.addScriptToEvaluateOnNewDocument",
            {"source": "Object.defineProperty(navigator,'webdriver',{get:()=>undefined})"},
        )
    except WebDriverException:
        pass
    return driver


def _is_blocked(driver):
    src = (driver.page_source or "").lower()
    return any(m in src for m in BLOCK_MARKERS)


def _profile_links(driver):
    hrefs = driver.execute_script(
        "return Array.from(document.querySelectorAll('a[href]')).map(a=>a.href);"
    )
    out = []
    for href in hrefs or []:
        m = PROFILE_RE.search(href or "")
        if m:
            url = "https://www.realtor.com/realestateagents/" + m.group(1)
            if url not in out:
                out.append(url)
    return out


def _scrape_profile(driver, url):
    driver.get(url)
    if _is_blocked(driver):
        return None
    for _ in range(20):
        if driver.execute_script("return !!document.querySelector('h1')"):
            break
        time.sleep(0.5)
    _pause()
    data = driver.execute_script(
        """
        const clean = t => (t||'').replace(/\\s+/g,' ').trim();
        const r = {name:'',name_section:'',contact_section:'',phones:[],links:[]};
        const h1 = document.querySelector('h1');
        if (h1){ r.name = clean(h1.textContent);
                 const b = h1.closest('section,header,div'); r.name_section = clean((b||h1).innerText); }
        const heading = Array.from(document.querySelectorAll('h1,h2,h3,h4'))
            .find(h=>clean(h.textContent).toLowerCase()==='contact information');
        if (heading){ const s = heading.closest('section')||heading.parentElement;
            r.contact_section = (s.innerText||'').trim();
            for (const a of s.querySelectorAll('a[href]')){
                if (a.href.startsWith('tel:')) r.phones.push(a.href.replace('tel:',''));
                else if (!a.href.includes('realtor.com')) r.links.push(a.href); } }
        return r;
        """
    )
    if not data or not data.get("name"):
        return None
    return {
        "name": data["name"],
        "name_section": data["name_section"],
        "contact_information": data["contact_section"],
        "phones": "; ".join(dict.fromkeys(data["phones"])),
        "website_links": "; ".join(dict.fromkeys(data["links"])),
        "profile_url": url,
    }


def scrape_zip(driver, zip_code, log, max_pages=0, stop=lambda: False):
    """Scrape every agent for one zip. Returns a list of row dicts."""
    cap = max_pages if max_pages and max_pages > 0 else 200
    all_links = []
    for page in range(1, cap + 1):
        if stop():
            break
        url = f"{BASE_URL}/{zip_code}/intent-buy-sell/pg-{page}"
        try:
            driver.get(url)
        except TimeoutException:
            pass
        if _is_blocked(driver):
            log(f"  zip {zip_code}: blocked by realtor.com on page {page}.")
            if page == 1:
                raise RuntimeError("blocked")
            break
        # let the client-side list render
        for _ in range(20):
            if _profile_links(driver):
                break
            time.sleep(0.5)
        links = [l for l in _profile_links(driver) if l not in all_links]
        all_links.extend(links)
        log(f"  zip {zip_code}: page {page} -> +{len(links)} (total {len(all_links)})")
        if not links:
            break
        _pause()

    rows = []
    for i, url in enumerate(all_links, 1):
        if stop():
            break
        try:
            row = _scrape_profile(driver, url)
        except WebDriverException:
            row = None
        if row:
            rows.append(row)
            log(f"  zip {zip_code}: [{i}/{len(all_links)}] {row['name']}")
        _pause(0.5, 1.5)
    return rows
