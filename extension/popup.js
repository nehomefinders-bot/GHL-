const goBtn = document.getElementById("go");
const statusBox = document.getElementById("status");
const setStatus = (m) => (statusBox.textContent = m);

(async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/www\.realtor\.com\//.test(tab.url || "")) {
    setStatus("Open www.realtor.com and search for agents first, then click the button.");
    goBtn.disabled = true;
  } else if (!/\/realestateagents\//.test(tab.url)) {
    setStatus("You're on realtor.com. Now go to Find an Agent, search your ZIP and\n" +
              "pick 'Both' so the agent list shows, then click the button.");
  } else {
    setStatus("Ready. Click the button to capture every agent on this search.");
  }
})();

goBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  const raw = document.getElementById("pages").value.trim();
  let maxPages = 0; // 0 = all pages
  if (raw !== "") {
    maxPages = parseInt(raw, 10);
    if (!Number.isInteger(maxPages) || maxPages < 1) {
      setStatus("Enter a whole number of pages (1 or more), or leave it blank for all pages.");
      return;
    }
  }

  goBtn.disabled = true;
  setStatus("Started" + (maxPages ? " (first " + maxPages + " page" + (maxPages > 1 ? "s" : "") + ")" : " (all pages)") +
            ".\nA black progress box shows on the page. You can close this popup -\n" +
            "it keeps running. The CSV downloads automatically when it's done.");
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [maxPages],
    func: scrapeAgents,
  }).catch((e) => setStatus("Could not start: " + e.message));
});

// ---------------------------------------------------------------------------
// Runs INSIDE the realtor.com page, in the user's real session. It reads the
// already-rendered agent list, and loads each further results page and each
// agent profile in a hidden SAME-ORIGIN iframe so realtor.com's own JavaScript
// fills in the data - exactly as if the user clicked through - with no bot block.
// ---------------------------------------------------------------------------
function scrapeAgents(maxPages) {
  const pageCap = maxPages && maxPages > 0 ? maxPages : 120; // 120 = practical "all"
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
  const PROFILE_RE = /\/realestateagents\/([0-9a-f]{24})\b/g;

  // ----- progress panel (survives the popup closing) -----
  let panel = document.getElementById("__ra_scraper_panel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "__ra_scraper_panel";
    panel.style.cssText =
      "position:fixed;top:12px;right:12px;z-index:2147483647;width:330px;" +
      "max-height:75vh;overflow:auto;background:#111;color:#0f0;font:12px/1.5 " +
      "Consolas,monospace;padding:12px;border-radius:8px;box-shadow:0 4px 18px " +
      "rgba(0,0,0,.5);white-space:pre-wrap;";
    document.body.appendChild(panel);
  }
  const lines = [];
  const log = (m) => {
    lines.push(m);
    panel.textContent = lines.slice(-250).join("\n");
    panel.scrollTop = panel.scrollHeight;
  };

  // ----- load a same-origin URL in a hidden iframe and wait for it to render -----
  function loadInFrame(url, isReady, timeoutMs) {
    return new Promise((resolve) => {
      const frame = document.createElement("iframe");
      frame.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1200px;height:900px;opacity:0;";
      let done = false;
      const finish = (doc) => {
        if (done) return;
        done = true;
        try { frame.remove(); } catch (e) {}
        resolve(doc);
      };
      frame.onload = async () => {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
          let doc = null;
          try { doc = frame.contentDocument; } catch (e) { break; } // cross-origin - give up
          if (doc && isReady(doc)) { finish(doc); return; }
          await sleep(400);
        }
        let doc = null;
        try { doc = frame.contentDocument; } catch (e) {}
        finish(doc);
      };
      frame.src = url;
      document.body.appendChild(frame);
      setTimeout(() => finish(frame.contentDocument), timeoutMs + 3000);
    });
  }

  const idsFromDoc = (doc) => {
    const html = doc.documentElement ? doc.documentElement.innerHTML : "";
    const out = [];
    let m;
    PROFILE_RE.lastIndex = 0;
    while ((m = PROFILE_RE.exec(html)) !== null) out.push(m[1]);
    return out;
  };

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

  function download(csv, name) {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  (async () => {
    try {
      // Base results path (strip any /pg-N), so we can page through the search.
      const basePath = location.pathname.replace(/\/pg-\d+\/?$/, "").replace(/\/+$/, "");
      if (!/\/realestateagents\/.+/.test(basePath)) {
        log("This doesn't look like an agent results page.");
        log("Go to Find an Agent, search your ZIP, pick 'Both' so the agent");
        log("list is showing, then click Scrape again.");
        return;
      }
      const label = (basePath.split("/realestateagents/")[1] || "agents").split("/")[0];
      log("Scraping agents for: " + label);
      log(maxPages && maxPages > 0 ? "Limit: first " + maxPages + " page(s)." : "Limit: all pages.");

      // 1) Collect agent IDs from the current rendered page + every further page.
      const ids = [];
      const seen = new Set();
      const addIds = (arr) => {
        let n = 0;
        for (const id of arr) if (!seen.has(id)) { seen.add(id); ids.push(id); n++; }
        return n;
      };
      addIds(idsFromDoc(document));
      log("Page 1: " + ids.length + " agents.");

      for (let page = 2; page <= pageCap; page++) {
        const url = location.origin + basePath + "/pg-" + page;
        const doc = await loadInFrame(url, (d) => idsFromDoc(d).length > 0, 15000);
        const added = doc ? addIds(idsFromDoc(doc)) : 0;
        log("Page " + page + ": +" + added + " (total " + ids.length + ")");
        if (added === 0) break;
        await sleep(600);
      }

      if (ids.length === 0) {
        log("No agents detected. Make sure the agent list is visible on this page,");
        log("then click Scrape again.");
        return;
      }

      // 2) Open each profile in a hidden frame and read its contact info.
      log("Reading contact info for " + ids.length + " agents...");
      const rows = [];
      for (let i = 0; i < ids.length; i++) {
        const url = location.origin + "/realestateagents/" + ids[i];
        const ready = (d) =>
          d.querySelector("h1") &&
          [...d.querySelectorAll("h1,h2,h3,h4")].some(
            (h) => clean(h.textContent).toLowerCase() === "contact information"
          );
        const doc = await loadInFrame(url, ready, 12000);
        if (doc && doc.querySelector("h1")) {
          const row = parseProfile(doc, url);
          rows.push(row);
          log("[" + (i + 1) + "/" + ids.length + "] " + (row.name || "(no name)"));
        } else {
          log("[" + (i + 1) + "/" + ids.length + "] could not read, skipped.");
        }
        await sleep(500);
      }

      if (rows.length === 0) {
        log("Could not read any profiles.");
        return;
      }
      download(toCSV(rows), "realtor_agents_" + label + ".csv");
      log("DONE. Saved " + rows.length + " agents -> realtor_agents_" + label + ".csv");
      log("(Check your Downloads folder.)");
    } catch (e) {
      log("Error: " + (e && e.message ? e.message : e));
    }
  })();
}
