const zipInput = document.getElementById("zip");
const goBtn = document.getElementById("go");
const statusBox = document.getElementById("status");

function setStatus(msg) { statusBox.textContent = msg; }

goBtn.addEventListener("click", async () => {
  const zip = zipInput.value.trim();
  if (!/^\d{5}$/.test(zip)) {
    setStatus("Please enter a valid 5-digit ZIP code.");
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/www\.realtor\.com\//.test(tab.url || "")) {
    setStatus("Open www.realtor.com in this tab first (browse it once so any\n" +
              "bot check is cleared), then click Scrape again.");
    return;
  }

  goBtn.disabled = true;
  setStatus("Started. A progress box appears on the realtor.com page.\n" +
            "You can close this popup - it keeps running. The CSV downloads\n" +
            "automatically when finished.");

  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [zip],
    func: scrapeAgents,
  }).catch((e) => setStatus("Could not start: " + e.message));
});

// ---------------------------------------------------------------------------
// Everything below runs INSIDE the realtor.com page, in the user's real
// session. Same-origin fetches carry the user's cookies, so realtor.com serves
// them just like normal browsing - no bot block, no automation fingerprint.
// ---------------------------------------------------------------------------
function scrapeAgents(zip) {
  const PROFILE_RE = /\/realestateagents\/([0-9a-f]{24})\b/g;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);

  // Floating progress panel so the user sees status even if the popup closes.
  let panel = document.getElementById("__ra_scraper_panel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "__ra_scraper_panel";
    panel.style.cssText =
      "position:fixed;top:12px;right:12px;z-index:2147483647;width:320px;" +
      "max-height:70vh;overflow:auto;background:#111;color:#0f0;font:12px/1.5 " +
      "Consolas,monospace;padding:12px;border-radius:8px;box-shadow:0 4px " +
      "18px rgba(0,0,0,.5);white-space:pre-wrap;";
    document.body.appendChild(panel);
  }
  const lines = [];
  const log = (m) => {
    lines.push(m);
    panel.textContent = lines.slice(-200).join("\n");
    panel.scrollTop = panel.scrollHeight;
  };

  const clean = (t) => (t || "").replace(/\s+/g, " ").trim();

  async function fetchDoc(url) {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return null;
    const html = await res.text();
    if (/your request could not be processed|access to this page has been denied/i.test(html)) {
      throw new Error("BLOCKED");
    }
    return new DOMParser().parseFromString(html, "text/html");
  }

  function parseProfile(doc, url) {
    const h1 = doc.querySelector("h1");
    const name = clean(h1 && h1.textContent);
    let nameSection = "";
    if (h1) {
      const block = h1.closest("section, header, div") || h1;
      nameSection = clean(block.innerText || block.textContent);
    }

    let contactSection = "";
    const phones = new Set();
    const links = new Set();
    const heading = [...doc.querySelectorAll("h1,h2,h3,h4")].find(
      (h) => clean(h.textContent).toLowerCase() === "contact information"
    );
    if (heading) {
      const section = heading.closest("section") || heading.parentElement;
      if (section) {
        contactSection = clean(section.innerText || section.textContent);
        section.querySelectorAll("a[href]").forEach((a) => {
          const href = a.getAttribute("href") || "";
          if (href.startsWith("tel:")) phones.add(href.replace("tel:", "").trim());
          else if (/^https?:/.test(href) && !href.includes("realtor.com")) links.add(href);
        });
      }
    }
    // Fallback: pull any phone numbers from the whole page text.
    const bodyText = doc.body ? doc.body.innerText : "";
    (bodyText.match(/\(\d{3}\)\s?\d{3}-\d{4}/g) || []).forEach((p) => phones.add(p));

    return {
      name,
      name_section: nameSection,
      contact_information: contactSection,
      phones: [...phones].join("; "),
      website_links: [...links].join("; "),
      profile_url: url,
    };
  }

  function toCSV(rows) {
    const cols = ["name", "name_section", "contact_information",
                  "phones", "website_links", "profile_url"];
    const esc = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
    const out = [cols.join(",")];
    for (const r of rows) out.push(cols.map((c) => esc(r[c])).join(","));
    return "﻿" + out.join("\r\n");
  }

  function download(csv, zip) {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "realtor_agents_" + zip + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  (async () => {
    try {
      log("Realtor agent scraper started for ZIP " + zip + " (Both).");
      // Collect agent profile IDs across every results page.
      const ids = [];
      const seen = new Set();
      for (let page = 1; page <= 120; page++) {
        const url =
          "https://www.realtor.com/realestateagents/" + zip +
          "/intent-buy-sell/pg-" + page;
        let doc;
        try {
          doc = await fetchDoc(url);
        } catch (e) {
          if (e.message === "BLOCKED") {
            log("realtor.com blocked a request. Browse the site normally in " +
                "this tab for a moment, then run Scrape again.");
            return;
          }
          throw e;
        }
        if (!doc) break;
        const html = doc.documentElement.innerHTML;
        let m, found = 0;
        PROFILE_RE.lastIndex = 0;
        while ((m = PROFILE_RE.exec(html)) !== null) {
          if (!seen.has(m[1])) { seen.add(m[1]); ids.push(m[1]); found++; }
        }
        log("Results page " + page + ": +" + found + " agents (total " + ids.length + ")");
        if (found === 0) break;
        await sleep(rand(500, 1200));
      }

      if (ids.length === 0) {
        log("No agents found. Make sure the ZIP is correct and that you can " +
            "browse realtor.com in this tab, then try again.");
        return;
      }

      log("Found " + ids.length + " agents. Fetching contact info...");
      const rows = [];
      for (let i = 0; i < ids.length; i++) {
        const url = "https://www.realtor.com/realestateagents/" + ids[i];
        try {
          const doc = await fetchDoc(url);
          if (doc) {
            const row = parseProfile(doc, url);
            rows.push(row);
            log("[" + (i + 1) + "/" + ids.length + "] " + (row.name || "(no name)"));
          }
        } catch (e) {
          if (e.message === "BLOCKED") {
            log("Blocked mid-run. Saving what we have (" + rows.length + ").");
            break;
          }
          log("[" + (i + 1) + "/" + ids.length + "] error, skipped.");
        }
        await sleep(rand(400, 1000));
      }

      if (rows.length === 0) {
        log("Could not read any profiles.");
        return;
      }
      download(toCSV(rows), zip);
      log("DONE. Saved " + rows.length + " agents to realtor_agents_" + zip + ".csv");
      log("(Check your Downloads folder.)");
    } catch (e) {
      log("Error: " + e.message);
    }
  })();
}
