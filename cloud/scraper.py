"""realtor.com agent scraper - your own headless-browser logic.

All scraping is done by THIS code. A real (headless) Chromium loads the
find-an-agent results pages and each agent profile; the page's own JavaScript
renders the data, and we read it straight from the DOM. No third-party scraping
service is involved - the logic is entirely ours.

realtor.com (PerimeterX / HUMAN) blocks datacenter / cloud IPs, so the only thing
that really matters is WHERE you run this:

  * From a residential IP (your own PC, a home server, an always-on mini-PC) it
    works with no extra setup - the free, fully self-contained way.
  * From a cloud / datacenter host, realtor.com blocks the IP. Route the browser
    through a RESIDENTIAL PROXY - which is just an IP tunnel, it does no scraping
    of its own - by setting SCRAPER_PROXY. Our code still does 100% of the work.

Modes (auto-selected from the environment):
  * "proxy"  - SCRAPER_PROXY is set: the browser goes out through your proxy.
  * "direct" - nothing set: plain headless Chromium (works from a home IP).

Environment variables
---------------------
  SCRAPER_PROXY   http[s]://[user:pass@]host:port   (optional residential proxy)
"""

import json
import os
import re
import tempfile
import time
import random
from urllib.parse import urlparse

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


def active_mode():
    """Which way traffic goes out: through a residential proxy, or direct."""
    return "proxy" if os.environ.get("SCRAPER_PROXY") else "direct"


def _pause(lo=1.0, hi=2.5):
    time.sleep(random.uniform(lo, hi))


# ---------------------------------------------------------------------------
# Optional residential proxy: just an IP route for our browser. It performs no
# scraping - our own code below still loads pages and reads the data.
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


# Injected before any page script runs, to hide the common headless / automation
# tells that PerimeterX inspects. Not a silver bullet (IP reputation dominates),
# but it removes the easy giveaways so our own browser looks like a normal one.
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


def _make_uc_driver():
    """Technique attempt (no proxy): undetected-chromedriver patches the headless
    Chrome fingerprints PerimeterX inspects (navigator.webdriver, CDP tells, etc.)
    to look like an ordinary browser. Returns a driver, or None to fall back to
    plain Selenium. Note: this improves the *browser* fingerprint only - it can't
    change the machine's IP, which is the other half of realtor.com's defense."""
    if os.environ.get("USE_UC", "1") == "0":
        return None
    try:
        import undetected_chromedriver as uc
    except Exception:
        return None
    try:
        opts = uc.ChromeOptions()
        opts.add_argument("--no-sandbox")
        opts.add_argument("--disable-dev-shm-usage")
        opts.add_argument("--window-size=1400,1000")
        opts.add_argument("--lang=en-US")
        if os.environ.get("LOAD_IMAGES", "0") != "1":
            opts.add_argument("--blink-settings=imagesEnabled=false")
        _apply_proxy(opts)
        kwargs = {"options": opts, "headless": True}
        chrome_bin = os.environ.get("CHROME_BIN")
        if chrome_bin:
            kwargs["browser_executable_path"] = chrome_bin
        driver = uc.Chrome(**kwargs)
        driver.set_page_load_timeout(60)
        print("Driver: undetected-chromedriver.", flush=True)
        return driver
    except Exception as exc:
        print(f"undetected-chromedriver unavailable ({exc}); using plain Selenium.",
              flush=True)
        return None


def make_driver():
    uc_driver = _make_uc_driver()
    if uc_driver is not None:
        return uc_driver
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
    # Skip images/media by default: agent names + contact info are text, so not
    # downloading photos slashes proxy bandwidth (= cost) and speeds runs up.
    # Set LOAD_IMAGES=1 to fetch images too.
    if os.environ.get("LOAD_IMAGES", "0") != "1":
        opts.add_argument("--blink-settings=imagesEnabled=false")
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
    out, seen = [], set()
    for href in hrefs or []:
        m = re.search(r"/realestateagents/([^/?#]+)", href or "")
        if not m:
            continue
        seg = m.group(1)
        if re.fullmatch(r"\d{5}", seg):                    # bare zip = search page
            continue
        if re.match(r"(intent-|sort-|agenttype-|pg-)", seg):  # search / pagination
            continue
        # Agent profiles are a 24-hex id (old) or a name_city_state_<id> slug
        # (new; always has a long numeric id). Skip "nearby city" links such as
        # "gold-hill_or" (underscore, but no numeric id).
        if not (re.fullmatch(r"[0-9a-f]{24}", seg) or ("_" in seg and re.search(r"\d{3,}", seg))):
            continue
        url = "https://www.realtor.com/realestateagents/" + seg
        if url not in seen:
            seen.add(url)
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
        url = f"{BASE_URL}/{zip_code}/intent-both/sort-relevantagents/agenttype-all/pg-{page}"
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
# Unified entry point: hides the driver lifecycle from callers.
# ---------------------------------------------------------------------------
class Scraper:
    def __init__(self, log=print):
        self.log = log
        self.mode = active_mode()
        where = "residential proxy" if self.mode == "proxy" else "direct (this machine's IP)"
        log(f"Backend: headless browser via {where}. Launching Chrome...")
        self.driver = make_driver()

    def scrape_zip(self, zip_code, max_pages=0, stop=lambda: False):
        return scrape_zip_browser(self.driver, zip_code, self.log, max_pages, stop)

    def close(self):
        if self.driver is not None:
            try:
                self.driver.quit()
            except Exception:
                pass
            self.driver = None


# Backwards-compatible shim: older callers imported scrape_zip(driver, ...).
def scrape_zip(driver, zip_code, log, max_pages=0, stop=lambda: False):
    return scrape_zip_browser(driver, zip_code, log, max_pages=max_pages, stop=stop)
