"""realtor.com agent scraper backends (cloud / automated).

realtor.com is protected by PerimeterX / HUMAN, which blocks datacenter / cloud
IPs aggressively. To get data from a cloud host (GitHub Actions, Render, a VPS)
you must make the traffic look like it comes from a real home connection. This
module supports three modes, chosen automatically from environment variables:

  * "api"    - SCRAPER_API_KEY is set: fetch fully-rendered HTML through a
               scraping API (ScraperAPI / ScrapingBee / a custom template). The
               API supplies the residential IP, solves the bot check, and runs
               the page's JavaScript. No local browser is needed.
  * "proxy"  - SCRAPER_PROXY is set: drive a real (headless) Chromium through a
               (residential) proxy, so the site's JavaScript runs locally.
  * "direct" - nothing is set: plain headless Chromium with no proxy. Works from
               a residential IP (e.g. your own PC) but is blocked from cloud IPs.

Environment variables
----------------------
  SCRAPER_API_KEY       API key -> selects "api" mode.
  SCRAPER_API_PROVIDER  scraperapi (default) | scrapingbee | custom
  SCRAPER_API_TEMPLATE  for provider=custom: a URL template containing {key} and
                        {url} (the target url is percent-encoded), e.g.
                        https://api.example.com/?key={key}&url={url}&render=true
  SCRAPER_API_COUNTRY   geo for the API's exit IP (default "us")
  SCRAPER_API_RENDER    "1"/"0" - run JavaScript on the API side (default "1")
  SCRAPER_PROXY         http[s]://[user:pass@]host:port  -> selects "proxy" mode
"""

import json
import os
import re
import tempfile
import time
import random
from urllib.parse import urlparse, quote

# Optional deps: only needed for "api" mode. Import lazily-tolerantly so the
# browser modes still work in a minimal environment.
try:
    import requests
except ImportError:  # pragma: no cover
    requests = None
try:
    from bs4 import BeautifulSoup
except ImportError:  # pragma: no cover
    BeautifulSoup = None

# Selenium is only needed for the browser modes (proxy / direct). Import it
# tolerantly so "api" mode runs with just requests + beautifulsoup4 installed.
try:
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options
    from selenium.webdriver.chrome.service import Service
    from selenium.common.exceptions import TimeoutException, WebDriverException
except ImportError:  # pragma: no cover
    webdriver = Options = Service = None

    class TimeoutException(Exception):
        pass

    class WebDriverException(Exception):
        pass

BASE_URL = "https://www.realtor.com/realestateagents"
PROFILE_RE = re.compile(r"/realestateagents/([0-9a-f]{24})\b")
PHONE_RE = re.compile(r"\(\d{3}\)\s?\d{3}-\d{4}")
FIELDS = ["name", "name_section", "contact_information",
          "phones", "website_links", "profile_url"]
BLOCK_MARKERS = ("your request could not be processed",
                 "access to this page has been denied",
                 "press & hold", "press and hold", "verify you are human")
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")


def active_mode():
    """Which backend the current environment selects."""
    if os.environ.get("SCRAPER_API_KEY"):
        return "api"
    if os.environ.get("SCRAPER_PROXY"):
        return "proxy"
    return "direct"


def _pause(lo=1.0, hi=2.5):
    time.sleep(random.uniform(lo, hi))


def _clean(text):
    return re.sub(r"\s+", " ", text or "").strip()


def _is_blocked_html(html):
    low = (html or "").lower()
    return any(m in low for m in BLOCK_MARKERS)


# ---------------------------------------------------------------------------
# Parsing (shared): works on a raw HTML string, so the same logic serves both
# the API mode and any future html-only path.
# ---------------------------------------------------------------------------
def _ids_from_html(html):
    out, seen = [], set()
    for m in PROFILE_RE.finditer(html or ""):
        if m.group(1) not in seen:
            seen.add(m.group(1))
            out.append(m.group(1))
    return out


def _closest(tag, names):
    """Nearest self-or-ancestor element whose tag name is in `names`."""
    while tag is not None:
        if getattr(tag, "name", None) in names:
            return tag
        tag = tag.parent
    return None


def _parse_profile_html(html, url):
    """Extract one agent row from a profile page's HTML (mirrors the browser
    extraction: name header block + Contact information section)."""
    if not html or BeautifulSoup is None:
        return None
    soup = BeautifulSoup(html, "html.parser")
    h1 = soup.find("h1")
    name = _clean(h1.get_text(" ") if h1 else "")
    if not name:
        return None

    name_section = ""
    if h1:
        block = _closest(h1, {"section", "header", "div"}) or h1
        name_section = _clean(block.get_text(" "))

    contact_section = ""
    phones, links = [], []
    heading = None
    for h in soup.find_all(["h1", "h2", "h3", "h4"]):
        if _clean(h.get_text(" ")).lower() == "contact information":
            heading = h
            break
    if heading is not None:
        section = _closest(heading, {"section"}) or heading.parent
        if section is not None:
            contact_section = _clean(section.get_text(" "))
            for a in section.find_all("a", href=True):
                href = a["href"].strip()
                if href.startswith("tel:"):
                    p = href[4:].strip()
                    if p and p not in phones:
                        phones.append(p)
                elif re.match(r"^https?:", href) and "realtor.com" not in href:
                    if href not in links:
                        links.append(href)

    body_text = soup.get_text(" ")
    for p in PHONE_RE.findall(body_text):
        if p not in phones:
            phones.append(p)

    return {
        "name": name,
        "name_section": name_section,
        "contact_information": contact_section,
        "phones": "; ".join(phones),
        "website_links": "; ".join(links),
        "profile_url": url,
    }


# ---------------------------------------------------------------------------
# API mode: fetch rendered HTML through a scraping API.
# ---------------------------------------------------------------------------
def _api_request_url(target_url):
    provider = (os.environ.get("SCRAPER_API_PROVIDER") or "scraperapi").lower()
    key = os.environ.get("SCRAPER_API_KEY", "")
    country = os.environ.get("SCRAPER_API_COUNTRY", "us").strip()
    render = os.environ.get("SCRAPER_API_RENDER", "1").strip() != "0"
    enc = quote(target_url, safe="")

    if provider == "scrapingbee":
        parts = [f"https://app.scrapingbee.com/api/v1/?api_key={key}",
                 f"url={enc}", f"render_js={'true' if render else 'false'}"]
        if country:
            parts.append(f"country_code={country}")
        return "&".join(parts)

    if provider == "custom":
        tmpl = os.environ.get("SCRAPER_API_TEMPLATE", "")
        if not tmpl:
            raise RuntimeError(
                "SCRAPER_API_PROVIDER=custom needs SCRAPER_API_TEMPLATE with "
                "{key} and {url} placeholders.")
        return tmpl.format(key=key, url=enc)

    # default: scraperapi
    parts = [f"https://api.scraperapi.com/?api_key={key}", f"url={enc}",
             f"render={'true' if render else 'false'}"]
    if country:
        parts.append(f"country_code={country}")
    return "&".join(parts)


def _api_get(session, target_url, log, attempts=3):
    """Fetch target_url's rendered HTML via the configured API, with retries."""
    if requests is None:
        raise RuntimeError("api mode needs the 'requests' package installed.")
    api_url = _api_request_url(target_url)
    last = ""
    for i in range(1, attempts + 1):
        try:
            resp = session.get(api_url, timeout=(15, 130))
        except requests.RequestException as exc:
            last = f"network error: {exc}"
        else:
            if resp.status_code == 200 and resp.text and not _is_blocked_html(resp.text):
                return resp.text
            if resp.status_code in (401, 403):
                log(f"    API returned {resp.status_code} - check your API key / credits.")
                return None
            if resp.status_code == 200 and _is_blocked_html(resp.text):
                last = "target still blocked (try render on / a different country)"
            else:
                last = f"HTTP {resp.status_code}"
        if i < attempts:
            back = 5 * i
            log(f"    API fetch retry {i}/{attempts} ({last}); waiting {back}s")
            time.sleep(back)
    log(f"    API fetch failed after {attempts} tries ({last}).")
    return None


def scrape_zip_api(session, zip_code, log, max_pages=0, stop=lambda: False):
    cap = max_pages if max_pages and max_pages > 0 else 200
    ids, seen = [], set()
    for page in range(1, cap + 1):
        if stop():
            break
        url = f"{BASE_URL}/{zip_code}/intent-buy-sell/pg-{page}"
        html = _api_get(session, url, log)
        if html is None:
            if page == 1:
                raise RuntimeError("blocked")
            break
        added = 0
        for aid in _ids_from_html(html):
            if aid not in seen:
                seen.add(aid)
                ids.append(aid)
                added += 1
        log(f"  zip {zip_code}: page {page} -> +{added} (total {len(ids)})")
        if added == 0:
            break
        _pause()

    rows = []
    for i, aid in enumerate(ids, 1):
        if stop():
            break
        url = f"{BASE_URL}/{aid}"
        html = _api_get(session, url, log)
        row = _parse_profile_html(html, url) if html else None
        if row:
            rows.append(row)
            log(f"  zip {zip_code}: [{i}/{len(ids)}] {row['name']}")
        else:
            log(f"  zip {zip_code}: [{i}/{len(ids)}] could not read, skipped.")
        _pause(0.3, 1.0)
    return rows


# ---------------------------------------------------------------------------
# Browser mode (proxy / direct): drive a real headless Chromium.
# ---------------------------------------------------------------------------
def _build_proxy_auth_extension(scheme, host, port, user, password):
    """A tiny unpacked extension that points Chrome at an authenticated proxy
    and answers the proxy auth challenge - the reliable way to use user:pass
    proxies in headless Chrome."""
    manifest = {
        "version": "1.0.0",
        "manifest_version": 2,
        "name": "Proxy Auth",
        "permissions": ["proxy", "tabs", "unlimitedStorage", "storage",
                        "<all_urls>", "webRequest", "webRequestBlocking"],
        "background": {"scripts": ["background.js"]},
        "minimum_chrome_version": "22.0.0",
    }
    background = """
var config = {
  mode: "fixed_servers",
  rules: { singleProxy: { scheme: "%s", host: "%s", port: parseInt(%s) },
           bypassList: ["localhost"] }
};
chrome.proxy.settings.set({value: config, scope: "regular"}, function() {});
chrome.webRequest.onAuthRequired.addListener(
  function(details) { return { authCredentials: { username: "%s", password: "%s" } }; },
  { urls: ["<all_urls>"] },
  ['blocking']
);
""" % (scheme, host, port, user, password)
    d = tempfile.mkdtemp(prefix="proxyauth_")
    with open(os.path.join(d, "manifest.json"), "w") as f:
        json.dump(manifest, f)
    with open(os.path.join(d, "background.js"), "w") as f:
        f.write(background)
    return d


def _apply_proxy(opts):
    proxy = os.environ.get("SCRAPER_PROXY")
    if not proxy:
        return
    p = urlparse(proxy if "://" in proxy else "http://" + proxy)
    scheme = (p.scheme or "http").replace("https", "http")  # proxy transport
    host, port = p.hostname, p.port or 80
    if p.username and p.password:
        ext = _build_proxy_auth_extension(scheme, host, port, p.username, p.password)
        opts.add_argument(f"--load-extension={ext}")
    else:
        opts.add_argument(f"--proxy-server={scheme}://{host}:{port}")


# Injected before any page script runs, to hide common headless / automation
# fingerprints that PerimeterX looks at. Not a silver bullet (IP reputation
# still dominates), but it removes the easy tells.
_STEALTH_JS = """
try {
  Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
  Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
  Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
  window.chrome = window.chrome || {runtime: {}};
  const _q = navigator.permissions && navigator.permissions.query;
  if (_q) {
    navigator.permissions.query = (p) => (p && p.name === 'notifications')
      ? Promise.resolve({state: Notification.permission}) : _q(p);
  }
  const proto = window.WebGLRenderingContext && WebGLRenderingContext.prototype;
  if (proto) {
    const _gp = proto.getParameter;
    proto.getParameter = function (p) {
      if (p === 37445) return 'Intel Inc.';
      if (p === 37446) return 'Intel Iris OpenGL Engine';
      return _gp.call(this, p);
    };
  }
} catch (e) {}
"""


def make_driver():
    if webdriver is None:
        raise RuntimeError("browser mode needs the 'selenium' package installed.")
    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--disable-gpu")
    opts.add_argument("--window-size=1400,1000")
    opts.add_argument("--lang=en-US")
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_argument(f"--user-agent={USER_AGENT}")
    try:
        opts.add_experimental_option("excludeSwitches", ["enable-automation"])
        opts.add_experimental_option("useAutomationExtension", False)
    except Exception:
        pass

    _apply_proxy(opts)

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
            "Page.addScriptToEvaluateOnNewDocument", {"source": _STEALTH_JS})
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


def _get_listing(driver, url, tries=1, backoff=8):
    """Load a listing page, retrying past a block (useful with a rotating
    residential proxy, where each retry may draw a fresh IP)."""
    for attempt in range(1, tries + 1):
        try:
            driver.get(url)
        except TimeoutException:
            pass
        if not _is_blocked(driver):
            return True
        if attempt < tries:
            time.sleep(backoff * attempt)
    return not _is_blocked(driver)


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


def scrape_zip_browser(driver, zip_code, log, max_pages=0, stop=lambda: False):
    """Scrape every agent for one zip via the browser. Returns row dicts."""
    cap = max_pages if max_pages and max_pages > 0 else 200
    all_links = []
    for page in range(1, cap + 1):
        if stop():
            break
        url = f"{BASE_URL}/{zip_code}/intent-buy-sell/pg-{page}"
        # Give page 1 a few tries (a rotating proxy may get a fresh IP each time).
        ok = _get_listing(driver, url, tries=3 if page == 1 else 1)
        if not ok:
            log(f"  zip {zip_code}: blocked by realtor.com on page {page}.")
            if page == 1:
                raise RuntimeError("blocked")
            break
        # let the client-side list render (proxies are slow -> wait up to ~30s)
        for _ in range(60):
            if _profile_links(driver):
                break
            time.sleep(0.5)
        links = [l for l in _profile_links(driver) if l not in all_links]
        all_links.extend(links)
        log(f"  zip {zip_code}: page {page} -> +{len(links)} (total {len(all_links)})")
        if not links:
            if page == 1:
                # Diagnose what realtor.com actually served (block? challenge? empty?)
                try:
                    diag = driver.execute_script(
                        "return {u: location.href, t: document.title, "
                        "b: (document.body ? document.body.innerText.slice(0,220) : '')};"
                    )
                    log(f"  zip {zip_code}: DIAG url={diag.get('u')}")
                    log(f"  zip {zip_code}: DIAG title={diag.get('t')}")
                    log(f"  zip {zip_code}: DIAG text={(diag.get('b') or '').replace(chr(10),' ')}")
                except WebDriverException:
                    pass
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


# ---------------------------------------------------------------------------
# Unified entry point: picks the backend from the environment and hides the
# driver / session lifecycle from callers.
# ---------------------------------------------------------------------------
class Scraper:
    def __init__(self, log=print):
        self.log = log
        self.mode = active_mode()
        self.driver = None
        self.session = None
        if self.mode == "api":
            if requests is None:
                raise RuntimeError("api mode needs the 'requests' package installed.")
            if BeautifulSoup is None:
                raise RuntimeError("api mode needs 'beautifulsoup4' installed.")
            provider = os.environ.get("SCRAPER_API_PROVIDER", "scraperapi")
            self.session = requests.Session()
            self.session.headers.update({"User-Agent": USER_AGENT})
            log(f"Mode: scraping API ({provider}).")
        else:
            where = "residential proxy" if self.mode == "proxy" else "direct (no proxy)"
            log(f"Mode: headless browser via {where}. Launching Chrome...")
            self.driver = make_driver()

    def scrape_zip(self, zip_code, max_pages=0, stop=lambda: False):
        if self.mode == "api":
            return scrape_zip_api(self.session, zip_code, self.log, max_pages, stop)
        return scrape_zip_browser(self.driver, zip_code, self.log, max_pages, stop)

    def close(self):
        if self.driver is not None:
            try:
                self.driver.quit()
            except Exception:
                pass
            self.driver = None
        if self.session is not None:
            try:
                self.session.close()
            except Exception:
                pass
            self.session = None


# Backwards-compatible shim: older callers imported scrape_zip(driver, ...).
def scrape_zip(driver, zip_code, log, max_pages=0, stop=lambda: False):
    return scrape_zip_browser(driver, zip_code, log, max_pages=max_pages, stop=stop)
