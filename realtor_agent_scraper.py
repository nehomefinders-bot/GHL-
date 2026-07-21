"""Realtor.com Agent Scraper.

Desktop app: enter a zip code, and it opens Chrome, searches
https://www.realtor.com/realestateagents with the "Both" (buy & sell) intent,
walks every result page, opens each agent's profile, and captures:

  - the agent name header section (name, brokerage, experience, rating)
  - the full "Contact information" section (phone, office address, website links)

Results are saved to a CSV file next to the app (realtor_agents_<zip>.csv).

The browser window stays visible on purpose: realtor.com uses bot protection,
and a real, visible Chrome session is far less likely to be blocked. If a
"press & hold" or captcha check ever appears, solve it in the browser window
and the scraper will continue on its own.
"""

import csv
import queue
import random
import re
import threading
import time
import tkinter as tk
from datetime import datetime
from pathlib import Path
from tkinter import messagebox, scrolledtext

from selenium import webdriver
from selenium.common.exceptions import TimeoutException, WebDriverException
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

BASE_URL = "https://www.realtor.com/realestateagents"
# Agent profile links look like /realestateagents/5a14f0e33e033b001386c8f8
PROFILE_HREF_RE = re.compile(r"/realestateagents/[0-9a-f]{24}\b")
MAX_PAGES = 200


def human_pause(lo=1.5, hi=3.5):
    time.sleep(random.uniform(lo, hi))


class RealtorScraper:
    def __init__(self, zip_code, log, stop_event):
        self.zip_code = zip_code
        self.log = log
        self.stop_event = stop_event
        self.driver = None

    # ------------------------------------------------------------- browser

    def start_browser(self):
        self.log("Launching Chrome...")
        opts = Options()
        opts.add_argument("--start-maximized")
        opts.add_argument("--disable-blink-features=AutomationControlled")
        opts.add_experimental_option("excludeSwitches", ["enable-automation"])
        opts.add_experimental_option("useAutomationExtension", False)
        self.driver = webdriver.Chrome(options=opts)
        self.driver.execute_cdp_cmd(
            "Page.addScriptToEvaluateOnNewDocument",
            {"source": "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"},
        )
        self.driver.set_page_load_timeout(60)

    def wait_for(self, condition, timeout=25):
        return WebDriverWait(self.driver, timeout).until(condition)

    def wait_out_bot_check(self):
        """If a bot-protection interstitial shows up, wait for the user to clear it."""
        warned = False
        while not self.stop_event.is_set():
            src = self.driver.page_source.lower()
            blocked = any(
                marker in src
                for marker in ("press & hold", "press and hold", "are you a human", "access to this page has been denied")
            )
            if not blocked:
                return
            if not warned:
                self.log("Bot check detected - please complete it in the Chrome window...")
                warned = True
            time.sleep(2)

    # -------------------------------------------------------------- search

    def run_search(self):
        """Open the find-an-agent page, pick 'Both', and search the zip code."""
        self.driver.get(BASE_URL)
        self.wait_out_bot_check()
        human_pause()

        try:
            both = self.wait_for(
                EC.element_to_be_clickable(
                    (By.XPATH, "//*[self::button or self::a or self::div or self::span]"
                               "[normalize-space(text())='Both']")
                ),
                timeout=15,
            )
            self.driver.execute_script("arguments[0].click();", both)
            self.log("Selected 'Both' (buy & sell).")
            human_pause(0.5, 1.5)

            box = self.wait_for(
                EC.presence_of_element_located(
                    (By.CSS_SELECTOR, "input[placeholder*='Zip' i], input[placeholder*='City' i]")
                ),
                timeout=15,
            )
            box.click()
            for ch in self.zip_code:
                box.send_keys(ch)
                time.sleep(random.uniform(0.05, 0.2))
            human_pause(0.8, 1.5)
            box.send_keys(Keys.ENTER)
            self.log(f"Searched for zip {self.zip_code}.")
        except TimeoutException:
            # Search widget changed or didn't load - fall back to the results URL.
            self.log("Search form not found, opening results page directly...")
            self.driver.get(f"{BASE_URL}/{self.zip_code}")

        self.wait_out_bot_check()
        try:
            self.wait_for(
                EC.presence_of_element_located(
                    (By.XPATH, "//a[contains(@href, '/realestateagents/')]")
                ),
                timeout=30,
            )
        except TimeoutException:
            raise RuntimeError("Results page never loaded any agents - check the zip code.")
        human_pause()

    # --------------------------------------------------------- result list

    def profile_links_on_page(self):
        hrefs = self.driver.execute_script(
            "return Array.from(document.querySelectorAll('a[href]')).map(a => a.href);"
        )
        links = []
        for href in hrefs:
            m = PROFILE_HREF_RE.search(href)
            if m:
                url = "https://www.realtor.com" + m.group(0)
                if url not in links:
                    links.append(url)
        return links

    def go_to_next_page(self):
        """Click/open the next results page. Returns False when on the last page."""
        try:
            nxt = self.driver.find_element(
                By.XPATH,
                "//a[@aria-label='Go to next page' or @rel='next' or normalize-space(text())='Next']",
            )
            href = nxt.get_attribute("href")
            if href:
                self.driver.get(href)
                return True
            self.driver.execute_script("arguments[0].click();", nxt)
            return True
        except WebDriverException:
            pass

        # Fallback: bump the /pg-N segment in the URL.
        url = self.driver.current_url
        m = re.search(r"/pg-(\d+)", url)
        next_url = (
            re.sub(r"/pg-\d+", f"/pg-{int(m.group(1)) + 1}", url)
            if m
            else url.rstrip("/") + "/pg-2"
        )
        before = set(self.profile_links_on_page())
        self.driver.get(next_url)
        self.wait_out_bot_check()
        human_pause()
        after = set(self.profile_links_on_page())
        return bool(after) and after != before

    def collect_all_profile_links(self):
        all_links = []
        for page in range(1, MAX_PAGES + 1):
            if self.stop_event.is_set():
                break
            self.wait_out_bot_check()
            links = self.profile_links_on_page()
            new = [l for l in links if l not in all_links]
            all_links.extend(new)
            self.log(f"Results page {page}: {len(new)} new agents (total {len(all_links)}).")
            if not new:
                break
            human_pause()
            if not self.go_to_next_page():
                break
        return all_links

    # ------------------------------------------------------ agent profiles

    def scrape_profile(self, url):
        self.driver.get(url)
        self.wait_out_bot_check()
        try:
            self.wait_for(EC.presence_of_element_located((By.TAG_NAME, "h1")), timeout=20)
        except TimeoutException:
            return None
        human_pause(1.0, 2.5)

        data = self.driver.execute_script(
            """
            const clean = t => (t || '').replace(/\\s+/g, ' ').trim();
            const result = {name: '', name_section: '', contact_section: '',
                            phones: [], links: []};

            const h1 = document.querySelector('h1');
            if (h1) {
                result.name = clean(h1.textContent);
                const block = h1.closest('section, header, div');
                result.name_section = clean((block || h1).innerText);
            }

            const heading = Array.from(document.querySelectorAll('h1,h2,h3,h4'))
                .find(h => clean(h.textContent).toLowerCase() === 'contact information');
            if (heading) {
                const section = heading.closest('section') || heading.parentElement;
                result.contact_section = (section.innerText || '').trim();
                for (const a of section.querySelectorAll('a[href]')) {
                    if (a.href.startsWith('tel:')) {
                        result.phones.push(a.href.replace('tel:', ''));
                    } else if (!a.href.includes('realtor.com')) {
                        result.links.push(a.href);
                    }
                }
            }
            return result;
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

    # ----------------------------------------------------------------- run

    def run(self, on_row):
        self.start_browser()
        try:
            self.run_search()
            links = self.collect_all_profile_links()
            self.log(f"Found {len(links)} agent profiles. Scraping each one...")
            for i, url in enumerate(links, 1):
                if self.stop_event.is_set():
                    self.log("Stopped by user.")
                    break
                try:
                    row = self.scrape_profile(url)
                except WebDriverException as exc:
                    self.log(f"[{i}/{len(links)}] error: {exc.msg}")
                    continue
                if row:
                    on_row(row)
                    self.log(f"[{i}/{len(links)}] {row['name']}")
                else:
                    self.log(f"[{i}/{len(links)}] could not read profile, skipped.")
        finally:
            try:
                self.driver.quit()
            except WebDriverException:
                pass


# ------------------------------------------------------------------------ UI

FIELDS = ["name", "name_section", "contact_information", "phones", "website_links", "profile_url"]


class App:
    def __init__(self, root):
        self.root = root
        root.title("Realtor.com Agent Scraper")
        root.geometry("720x520")
        root.minsize(560, 400)

        top = tk.Frame(root, padx=12, pady=12)
        top.pack(fill="x")
        tk.Label(top, text="Zip code:", font=("Segoe UI", 11)).pack(side="left")
        self.zip_var = tk.StringVar()
        entry = tk.Entry(top, textvariable=self.zip_var, font=("Segoe UI", 11), width=12)
        entry.pack(side="left", padx=8)
        entry.bind("<Return>", lambda e: self.start())
        self.start_btn = tk.Button(top, text="Start scraping", command=self.start,
                                   font=("Segoe UI", 10, "bold"), bg="#c82021", fg="white",
                                   activebackground="#a51a1b", activeforeground="white", padx=14)
        self.start_btn.pack(side="left", padx=4)
        self.stop_btn = tk.Button(top, text="Stop", command=self.stop, state="disabled", padx=14)
        self.stop_btn.pack(side="left", padx=4)

        self.status_var = tk.StringVar(value="Enter a zip code and click Start.")
        tk.Label(root, textvariable=self.status_var, anchor="w", padx=12).pack(fill="x")

        self.log_box = scrolledtext.ScrolledText(root, state="disabled", font=("Consolas", 9))
        self.log_box.pack(fill="both", expand=True, padx=12, pady=(6, 12))

        self.log_queue = queue.Queue()
        self.stop_event = threading.Event()
        self.worker = None
        self.rows = []
        self.out_path = None
        root.after(200, self.drain_log)

    def log(self, msg):
        self.log_queue.put(msg)

    def drain_log(self):
        while not self.log_queue.empty():
            msg = self.log_queue.get_nowait()
            self.log_box.configure(state="normal")
            self.log_box.insert("end", f"{datetime.now():%H:%M:%S}  {msg}\n")
            self.log_box.see("end")
            self.log_box.configure(state="disabled")
        self.root.after(200, self.drain_log)

    def start(self):
        zip_code = self.zip_var.get().strip()
        if not re.fullmatch(r"\d{5}", zip_code):
            messagebox.showerror("Invalid zip", "Please enter a 5-digit zip code.")
            return
        self.rows = []
        self.stop_event.clear()
        self.out_path = Path.cwd() / f"realtor_agents_{zip_code}.csv"
        self.start_btn.configure(state="disabled")
        self.stop_btn.configure(state="normal")
        self.status_var.set(f"Scraping agents for {zip_code}... results -> {self.out_path}")
        self.worker = threading.Thread(target=self.work, args=(zip_code,), daemon=True)
        self.worker.start()

    def stop(self):
        self.stop_event.set()
        self.log("Stopping after the current agent...")

    def work(self, zip_code):
        scraper = RealtorScraper(zip_code, self.log, self.stop_event)
        try:
            scraper.run(self.on_row)
            self.log(f"Done. {len(self.rows)} agents saved to {self.out_path}")
        except Exception as exc:  # surface any failure in the UI log
            self.log(f"ERROR: {exc}")
        finally:
            self.root.after(0, self.finish)

    def on_row(self, row):
        self.rows.append(row)
        # Rewrite the CSV each time so a crash never loses collected data.
        with open(self.out_path, "w", newline="", encoding="utf-8-sig") as f:
            writer = csv.DictWriter(f, fieldnames=FIELDS)
            writer.writeheader()
            writer.writerows(self.rows)

    def finish(self):
        self.start_btn.configure(state="normal")
        self.stop_btn.configure(state="disabled")
        self.status_var.set(
            f"Finished - {len(self.rows)} agents saved to {self.out_path}"
            if self.rows else "Finished - no agents captured."
        )


def main():
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
