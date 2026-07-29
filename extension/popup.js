const goBtn = document.getElementById("go");
const statusBox = document.getElementById("status");
const setStatus = (m) => (statusBox.textContent = m);

(async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/www\.realtor\.com\//.test(tab.url || "")) {
    setStatus("Open www.realtor.com in this tab and browse once (clear any bot\n" +
              "check), then paste your ZIPs and click the button.");
    goBtn.disabled = true;
  } else {
    setStatus("Ready. Paste ZIP codes (one per line) and click Scrape all ZIPs.");
  }
})();

goBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  const zips = (document.getElementById("zips").value.match(/\d{5}/g) || []);
  if (zips.length === 0) {
    setStatus("Enter at least one 5-digit ZIP code (one per line).");
    return;
  }
  const raw = document.getElementById("pages").value.trim();
  let maxPages = 0;
  if (raw !== "") {
    maxPages = parseInt(raw, 10);
    if (!Number.isInteger(maxPages) || maxPages < 1) {
      setStatus("Max pages must be a whole number (1+), or blank for all pages.");
      return;
    }
  }

  goBtn.disabled = true;
  setStatus(`Started ${zips.length} ZIP(s)` +
            (maxPages ? ` (first ${maxPages} page${maxPages > 1 ? "s" : ""} each)` : " (all pages each)") +
            ".\nA black progress box shows on the page. You can close this popup -\n" +
            "it keeps running. A CSV downloads after each ZIP, plus one combined\n" +
            "CSV of all ZIPs at the end. Keep the tab open and your PC awake.");
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [zips, maxPages],
    func: scrapeZips,
  }).catch((e) => setStatus("Could not start: " + e.message));
});

// ---------------------------------------------------------------------------
// Runs INSIDE the realtor.com page, in the user's real session. For each ZIP it
// loads the results pages and each agent profile in hidden SAME-ORIGIN iframes
// (so realtor.com's own JavaScript fills in the data, exactly like clicking),
// downloads a CSV for that ZIP, then at the end downloads one combined CSV of
// every ZIP and a summary of any ZIPs that need re-running.
// ---------------------------------------------------------------------------
function scrapeZips(zips, maxPages) {
  const pageCap = maxPages && maxPages > 0 ? maxPages : 120;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (t) => (t || "").replace(/\s+/g, " ").trim();

  let panel = document.getElementById("__ra_scraper_panel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "__ra_scraper_panel";
    panel.style.cssText =
      "position:fixed;top:12px;right:12px;z-index:2147483647;width:340px;" +
      "max-height:80vh;overflow:auto;background:#111;color:#0f0;font:12px/1.5 " +
      "Consolas,monospace;padding:12px;border-radius:8px;box-shadow:0 4px 18px " +
      "rgba(0,0,0,.5);white-space:pre-wrap;";
    document.body.appendChild(panel);
  }
  const lines = [];
  const log = (m) => {
    lines.push(m);
    panel.textContent = lines.slice(-300).join("\n");
    panel.scrollTop = panel.scrollHeight;
  };

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
          try { doc = frame.contentDocument; } catch (e) { break; }
          if (doc && isReady(doc)) { await sleep(200); finish(frame.contentDocument); return; }
          await sleep(150);
        }
        let doc = null;
        try { doc = frame.contentDocument; } catch (e) {}
        finish(doc);
      };
      frame.src = url;
      document.body.appendChild(frame);
      setTimeout(() => { try { finish(frame.contentDocument); } catch (e) { finish(null); } }, timeoutMs + 3000);
    });
  }

  // Collect agent-profile URLs from a results page's links. Robust to
  // realtor.com's URL changes: keeps /realestateagents/<seg> links that look
  // like an individual agent (24-hex id OR a name_city_state_id slug) and skips
  // the search / pagination URLs (bare zip, intent-, sort-, agenttype-, pg-).
  const agentLinksFromDoc = (doc) => {
    const out = [];
    const seen = new Set();
    const anchors = doc ? doc.querySelectorAll('a[href*="/realestateagents/"]') : [];
    anchors.forEach((a) => {
      const href = a.getAttribute("href") || "";
      let abs;
      try { abs = new URL(href, location.origin).href; } catch (e) { return; }
      const m = abs.match(/\/realestateagents\/([^/?#]+)/);
      if (!m) return;
      const seg = m[1];
      if (/^\d{5}$/.test(seg)) return;
      if (/^(intent-|sort-|agenttype-|pg-)/.test(seg)) return;
      // Agent profiles are a 24-hex id (old) or a name_city_state_<id> slug
      // (new; always has a long numeric id). Skip realtor's "nearby city" links
      // such as "gold-hill_or" (underscore, but no numeric id).
      if (!(/^[0-9a-f]{24}$/.test(seg) || (seg.includes("_") && /\d{3,}/.test(seg)))) return;
      const purl = location.origin + "/realestateagents/" + seg;
      if (!seen.has(purl)) { seen.add(purl); out.push(purl); }
    });
    return out;
  };

  function isBlocked(doc) {
    const t = (doc && doc.body ? doc.body.innerText : "").toLowerCase();
    return t.includes("your request could not be processed") ||
           t.includes("access to this page has been denied");
  }

  // Load one results page, retrying past a transient block before giving up.
  async function loadListingPage(url, zip, page) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const doc = await loadInFrame(url, (d) => agentLinksFromDoc(d).length > 0 || isBlocked(d), 15000);
      if (!(doc && isBlocked(doc))) return { doc, blocked: false };
      if (attempt < 3) {
        log(`  ${zip}: blocked on page ${page}, retry ${attempt}/2 in 5s...`);
        await sleep(5000);
      }
    }
    return { doc: null, blocked: true };
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
    const bodyText = doc.body ? doc.body.innerText : "";
    (bodyText.match(/\(\d{3}\)\s?\d{3}-\d{4}/g) || []).forEach((p) => phones.add(p));
    return {
      search_zip: "",
      name,
      name_section: nameSection,
      contact_information: contactSection,
      phones: [...phones].join("; "),
      website_links: [...links].join("; "),
      profile_url: url,
    };
  }

  function toCSV(rows) {
    const cols = ["search_zip", "name", "name_section", "contact_information",
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

  async function scrapeOneZip(zip) {
    const base = location.origin + "/realestateagents/" + zip + "/intent-both/sort-relevantagents/agenttype-all";
    const profileUrls = [];
    const seen = new Set();
    for (let page = 1; page <= pageCap; page++) {
      const url = base + "/pg-" + page;
      const { doc, blocked } = await loadListingPage(url, zip, page);
      if (blocked) {
        log(`  ${zip}: still blocked on page ${page}. Browse realtor.com in this tab, then re-run this ZIP.`);
        break;
      }
      const pageUrls = doc ? agentLinksFromDoc(doc) : [];
      let added = 0;
      for (const u of pageUrls) if (!seen.has(u)) { seen.add(u); profileUrls.push(u); added++; }
      log(`  ${zip}: page ${page} -> +${added} (total ${profileUrls.length})`);
      if (added === 0) break;
      await sleep(150);
    }

    // Scrape profiles in parallel (a small worker pool) instead of one-by-one.
    // Same parsing per profile, so identical data quality - just much faster.
    // rows[] is indexed by position, so the CSV keeps the original listing order.
    const total = profileUrls.length;
    const rows = new Array(total);
    const ready = (d) =>
      d.querySelector("h1") &&
      [...d.querySelectorAll("h1,h2,h3,h4")].some(
        (h) => clean(h.textContent).toLowerCase() === "contact information"
      );
    let cursor = 0;
    let finishedCount = 0;
    async function profileWorker() {
      while (true) {
        const i = cursor++;
        if (i >= total) return;
        const url = profileUrls[i];
        const doc = await loadInFrame(url, ready, 12000);
        if (doc && doc.querySelector("h1")) {
          const row = parseProfile(doc, url);
          row.search_zip = zip;
          rows[i] = row;
          log(`  ${zip}: [${++finishedCount}/${total}] ${clean(doc.querySelector("h1").textContent) || "(no name)"}`);
        } else {
          log(`  ${zip}: [${++finishedCount}/${total}] could not read, skipped.`);
        }
        await sleep(90 + Math.random() * 160);  // small jitter, avoids a burst
      }
    }
    const CONCURRENCY = 5;  // ~5 profiles at once; raise for more speed if your PC is strong
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, total || 1) }, profileWorker)
    );
    return rows.filter(Boolean);  // drop skipped slots, keep listing order
  }

  (async () => {
    try {
      log(`Scraping ${zips.length} ZIP(s): ${zips.join(", ")}`);
      log(maxPages && maxPages > 0 ? `Limit: first ${maxPages} page(s) each.` : "Limit: all pages each.");
      const allRows = [];
      const zeroZips = [];
      for (let z = 0; z < zips.length; z++) {
        const zip = zips[z];
        log(`=== ZIP ${zip} (${z + 1}/${zips.length}) ===`);
        const rows = await scrapeOneZip(zip);
        download(toCSV(rows), "realtor_agents_" + zip + ".csv");
        allRows.push(...rows);
        if (rows.length === 0) zeroZips.push(zip);
        log(`=== ZIP ${zip}: saved ${rows.length} agents -> realtor_agents_${zip}.csv ===`);
        await sleep(800);
      }

      // One combined file across every ZIP (has a search_zip column).
      if (allRows.length > 0) {
        download(toCSV(allRows), "realtor_agents_ALL_" + zips.length + "zips.csv");
        log(`Combined -> realtor_agents_ALL_${zips.length}zips.csv (${allRows.length} rows).`);
      }

      log(`ALL DONE. ${allRows.length} agents across ${zips.length} ZIP(s). Check your Downloads folder.`);
      if (zeroZips.length > 0) {
        log(`NOTE: ${zeroZips.length} ZIP(s) returned 0 agents (likely a block). Re-run just these:`);
        log("  " + zeroZips.join(", "));
      }
    } catch (e) {
      log("Error: " + (e && e.message ? e.message : e));
    }
  })();
}
