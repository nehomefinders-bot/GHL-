const goBtn = document.getElementById("go");
const statusBox = document.getElementById("status");
const turboBox = document.getElementById("turbo");
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
  const turbo = !!(turboBox && turboBox.checked);

  goBtn.disabled = true;
  setStatus(`Started ${zips.length} ZIP(s)` +
            (maxPages ? ` (first ${maxPages} page${maxPages > 1 ? "s" : ""} each)` : " (all pages each)") +
            (turbo ? " - Turbo ON" : "") +
            ".\nA black progress box shows on the page. You can close this popup -\n" +
            "it keeps running. A CSV downloads after each ZIP, plus one combined\n" +
            "CSV of all ZIPs at the end. Keep the tab open and your PC awake.");
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [zips, maxPages, turbo],
    func: scrapeZips,
  }).catch((e) => setStatus("Could not start: " + e.message));
});

// ---------------------------------------------------------------------------
// Runs INSIDE the realtor.com page, in the user's real session. For each ZIP it
// loads the results pages and each agent profile, downloads a CSV for that ZIP,
// then at the end downloads one combined CSV of every ZIP and a summary of any
// ZIPs that need re-running.
//
// Two ways to read a profile:
//   * Classic (always available): load the profile in a hidden SAME-ORIGIN
//     iframe so realtor.com's own JavaScript fills in the data, exactly like
//     clicking. Reliable, but each profile pulls the whole page (~30 requests).
//   * Turbo (opt-in): fetch just the profile's HTML source in ONE request and
//     read the name/phone/contact straight out of it - far fewer requests, so
//     it's faster and trips realtor's rate-limit far less. Turbo is used ONLY
//     when it returns a complete row (name + phone + contact info); for any
//     profile where it comes up short it AUTOMATICALLY falls back to Classic,
//     so the data is never worse than Classic - Turbo only ever speeds things
//     up, it can't lower quality.
// ---------------------------------------------------------------------------
function scrapeZips(zips, maxPages, turbo) {
  const pageCap = maxPages && maxPages > 0 ? maxPages : 120;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (t) => (t || "").replace(/\s+/g, " ").trim();

  // Turbo tally across the whole run (so we can tell the user if it's helping).
  // turboOff latches on if Turbo clearly can't read these pages, so we stop doing
  // an extra fetch before each Classic render (which would only add to the load).
  let turboTried = 0, turboWon = 0, turboHintShown = false, turboOff = false;

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

  // realtor's block / rate-limit pages, detected from page text OR raw HTML.
  function isBlockedText(t) {
    t = (t || "").toLowerCase();
    return t.includes("your request could not be processed") ||
           t.includes("access to this page has been denied") ||
           t.includes("this is taking longer than usual") ||   // realtor rate-limit page
           t.includes("unblockrequest@realtor.com");
  }
  function isBlocked(doc) {
    return isBlockedText(doc && doc.body ? doc.body.innerText : "");
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

  // ---- Classic reader: parse a fully-rendered profile document (iframe). ----
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

  // realtor.com is a Next.js app; when the phone/contact isn't in the visible
  // markup it's usually in the page's hydration JSON (__NEXT_DATA__) or an inline
  // JSON blob. Pull it out - but ONLY from the object that is THIS agent (matched
  // by the profile's own name or the id in the URL), and never descend into
  // "similar / other agents" lists, so a Turbo row can't inherit someone else's
  // number.
  const normName = (s) => clean(String(s || "")).toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  const fmtPhone = (d) => "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6);
  function extractFromEmbeddedJson(doc, url, h1Name) {
    const wantName = normName(h1Name);
    const seg = (url.match(/\/realestateagents\/([^/?#]+)/) || [])[1] || "";
    let wantId = "";
    if (/^[0-9a-f]{24}$/i.test(seg)) wantId = seg.toLowerCase();
    else { const d = seg.match(/\d{6,}/); if (d) wantId = d[0]; }

    const blobs = [];
    doc.querySelectorAll('script#__NEXT_DATA__, script[type="application/json"]').forEach((s) => {
      try { blobs.push(JSON.parse(s.textContent || "")); } catch (e) {}
    });
    doc.querySelectorAll("script:not([src])").forEach((s) => {
      const txt = s.textContent || "";
      if (txt.length > 500000 || !/phone|advertiser|contact/i.test(txt)) return;
      const m = txt.match(/\{[\s\S]*\}/);
      if (m) { try { blobs.push(JSON.parse(m[0])); } catch (e) {} }
    });
    if (blobs.length === 0) return { phones: [], links: [], contactBits: [] };

    const phones = new Set(), links = new Set(), contactBits = [];
    // Never wander into these - they hold OTHER people's records.
    const SKIP = /(similar|related|recommend|nearby|other|review|testimonial|team|coagent|co_agent|^agents$|member_list)/i;

    // Is this object THIS agent? (name or URL-id appears as a direct field.)
    const identifies = (node) => {
      for (const [, v] of Object.entries(node)) {
        if (typeof v === "string") {
          if (wantName && normName(v) === wantName) return true;
          if (wantId && (v.toLowerCase() === wantId || (wantId.length >= 6 && v.includes(wantId)))) return true;
        } else if (typeof v === "number") {
          if (wantId && String(v) === wantId) return true;
        }
      }
      return false;
    };
    // Pull phone / contact / website values out of the matched agent's own subtree.
    const collect = (node, depth) => {
      if (!node || typeof node !== "object" || depth > 3) return;
      if (Array.isArray(node)) { node.forEach((v) => collect(v, depth + 1)); return; }
      for (const [k, v] of Object.entries(node)) {
        const key = k.toLowerCase();
        if (typeof v === "string" || typeof v === "number") {
          const sv = String(v);
          if (/phone|number|\btel\b/.test(key)) {
            const d = sv.replace(/\D/g, "");
            if (d.length === 10) phones.add(fmtPhone(d));
            else if (d.length === 11 && d[0] === "1") phones.add(fmtPhone(d.slice(1)));
            (sv.match(/\(\d{3}\)\s?\d{3}-\d{4}/g) || []).forEach((p) => phones.add(p));
          } else if (typeof v === "string" && v.trim() && v.trim().length <= 120 &&
                     /(office|broker|company|agency|address|city|state|email|title|name)/.test(key)) {
            contactBits.push(v.trim());
          } else if (typeof v === "string" && /^https?:/.test(v) && !v.includes("realtor.com") &&
                     /(url|website|web|href)/.test(key)) {
            links.add(v);
          }
        } else if (!SKIP.test(key)) {
          collect(v, depth + 1);
        }
      }
    };
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (identifies(node)) collect(node, 0);
      for (const [k, v] of Object.entries(node)) {
        if (v && typeof v === "object" && !SKIP.test(k.toLowerCase())) walk(v);
      }
    };
    blobs.forEach(walk);
    return { phones: [...phones], links: [...links], contactBits: [...new Set(contactBits)].slice(0, 8) };
  }

  // ---- Turbo reader: parse the SAME fields straight from the HTML source. ----
  // Uses the same "name" + "Contact Information" section anchors as Classic, so
  // where realtor serves the data in the page source the output matches Classic.
  // Everything here is scoped to this agent's own name card + contact section (or
  // the page's own structured-data block), so we never pull another agent's data.
  function parseProfileStatic(doc, url) {
    const h1 = doc.querySelector("h1");
    const name = clean(h1 && h1.textContent);
    const phones = new Set();
    const links = new Set();
    const scopes = [];
    let nameSection = "", contactSection = "";

    if (h1) {
      const card = h1.closest("section, header, div") || h1;
      scopes.push(card);
      nameSection = clean(card.textContent);
    }
    const heading = [...doc.querySelectorAll("h1,h2,h3,h4")].find(
      (h) => clean(h.textContent).toLowerCase() === "contact information"
    );
    if (heading) {
      const section = heading.closest("section") || heading.parentElement;
      if (section) { scopes.push(section); contactSection = clean(section.textContent); }
    }
    // Phones + external links, scoped to this agent's card / contact section.
    // (No layout in a parsed-not-rendered doc, so we read textContent, not
    // innerText, and scope tightly rather than scanning the whole page.)
    scopes.forEach((sc) => {
      sc.querySelectorAll("a[href]").forEach((a) => {
        const href = a.getAttribute("href") || "";
        if (href.startsWith("tel:")) phones.add(href.replace("tel:", "").trim());
        else if (/^https?:/.test(href) && !href.includes("realtor.com")) links.add(href);
      });
      (clean(sc.textContent).match(/\(\d{3}\)\s?\d{3}-\d{4}/g) || []).forEach((p) => phones.add(p));
    });

    // If the visible markup didn't carry a phone, fall back to the page's own
    // structured data (JSON-LD) for THIS page's subject only - single entity, so
    // no chance of grabbing a different agent's number.
    if (phones.size === 0) {
      doc.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
        let data;
        try { data = JSON.parse(s.textContent); } catch (e) { return; }
        const arr = Array.isArray(data) ? data : (data && data["@graph"] ? data["@graph"] : [data]);
        for (const o of arr) {
          if (!o || typeof o !== "object") continue;
          const type = String(o["@type"] || "").toLowerCase();
          if (!/(person|agent|localbusiness|realestate)/.test(type)) continue;
          if (o.telephone) {
            const t = clean(String(o.telephone));
            if (t.replace(/\D/g, "").length >= 10) phones.add(t);
          }
          if (o.url && /^https?:/.test(o.url) && !String(o.url).includes("realtor.com")) links.add(o.url);
        }
      });
    }

    // Still thin? Read the page's hydration JSON (__NEXT_DATA__ / inline JSON),
    // scoped to THIS agent - this is where realtor keeps the phone when it isn't
    // in the visible markup. contact_information is built from the agent's own
    // office/address fields only if the visible section wasn't present.
    if (phones.size === 0 || !contactSection) {
      const emb = extractFromEmbeddedJson(doc, url, name);
      emb.phones.forEach((p) => phones.add(p));
      emb.links.forEach((l) => links.add(l));
      if (!contactSection && emb.contactBits.length) contactSection = clean(emb.contactBits.join(" | "));
    }

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

  // A Turbo row is trusted ONLY when it's as complete as a Classic row would be:
  // a name, at least one phone, and the contact-info text. Anything short of that
  // triggers the Classic fallback, so Turbo never yields a thinner row.
  const isGoodRow = (r) => !!(r && r.name && r.phones && r.contact_information);

  // One lightweight request for the profile's HTML, parsed in place. Same-origin
  // (we're on realtor.com), so the request carries the user's real session.
  async function turboFetchProfile(url) {
    let html;
    try {
      const resp = await fetch(url, { credentials: "same-origin", redirect: "follow" });
      html = await resp.text();
    } catch (e) {
      return { error: true };            // network hiccup -> caller falls back to Classic
    }
    if (isBlockedText(html)) return { blocked: true };
    let doc;
    try { doc = new DOMParser().parseFromString(html, "text/html"); }
    catch (e) { return { error: true }; }
    return { row: parseProfileStatic(doc, url) };
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

    // Scrape profiles fast AND complete. realtor.com rate-limits a session that
    // requests too quickly (its "taking longer than usual" page), and hammering
    // it with fast retries keeps it throttled. So we ride just under the limit
    // and never drop anyone:
    //  - a throttled agent is REQUEUED and retried later, never saved or skipped;
    //  - on a throttle we cut concurrency hard and pause (exponential backoff),
    //    then ramp back up slowly (AIMD, like TCP) so we don't re-trigger it;
    //  - if the session gets stuck, we pause longer and suggest clicking around
    //    realtor.com in the tab to clear it - still nothing lost.
    // rows[] is indexed by position, so the CSV keeps the original listing order.
    const total = profileUrls.length;
    const rows = new Array(total);
    const queue = profileUrls.map((url, i) => ({ url, i, tries: 0, dead: 0 }));
    const isReady = (d) =>
      d.querySelector("h1") &&
      [...d.querySelectorAll("h1,h2,h3,h4")].some(
        (h) => clean(h.textContent).toLowerCase() === "contact information"
      );
    // Resolve the frame as soon as the profile is ready OR a block appears, so a
    // throttled page is caught instantly instead of waiting the full timeout.
    const readyOrBlocked = (d) => isReady(d) || isBlocked(d);

    // Classic read of one profile (hidden iframe render).
    async function readClassic(job) {
      const doc = await loadInFrame(job.url, readyOrBlocked, 12000);
      if (doc && isBlocked(doc)) return { kind: "blocked" };
      if (doc && doc.querySelector("h1")) return { kind: "ok", row: parseProfile(doc, job.url), via: "classic" };
      return { kind: "empty" };
    }

    // Get one profile's row. In Turbo we try the 1-request fetch first and use it
    // only when it's complete; otherwise (and always in Classic mode) we render.
    async function acquireRow(job) {
      if (turbo && !turboOff) {
        turboTried++;
        const res = await turboFetchProfile(job.url);
        if (res.blocked) return { kind: "blocked" };
        if (res.row && isGoodRow(res.row)) { turboWon++; return { kind: "ok", row: res.row, via: "turbo" }; }
        // fetch worked but data was thin -> fall through to a Classic render.
      }
      return await readClassic(job);
    }

    // Turbo can afford a little more parallelism (each read is 1 light request).
    let target = turbo ? 3 : 2;         // live concurrency, AIMD between 1 and MAX_T
    const MAX_T = turbo ? 6 : 5, MIN_T = 1;
    const MAX_THROTTLE_TRIES = 15;      // generous; the session almost always recovers first
    let inFlight = 0, done = 0, sinceGood = 0, throttleStreak = 0;
    let cooldownUntil = 0, lastNote = 0;

    await new Promise((resolve) => {
      const launch = () => {
        if (done >= total) { resolve(); return; }
        const now = Date.now();
        if (now < cooldownUntil) { setTimeout(launch, cooldownUntil - now + 20); return; }
        while (inFlight < target && queue.length > 0 && Date.now() >= cooldownUntil) {
          inFlight++;
          run(queue.shift());
        }
      };
      const run = async (job) => {
        try {
          const res = await acquireRow(job);
          if (res.kind === "blocked") {                         // realtor is throttling
            job.tries++;
            throttleStreak++; sinceGood = 0;
            target = Math.max(MIN_T, Math.floor(target / 2));   // multiplicative decrease
            const backoff = Math.min(30000, 3000 * Math.pow(1.6, Math.min(throttleStreak, 6)));
            cooldownUntil = Math.max(cooldownUntil, Date.now() + backoff);
            if (job.tries <= MAX_THROTTLE_TRIES) queue.push(job);   // requeue - never dropped
            else { rows[job.i] = null; done++; }                    // extreme, very rare
            if (Date.now() > lastNote) {
              log(`  ${zip}: realtor throttling - pausing ${Math.round(backoff / 1000)}s & slowing down` +
                  (throttleStreak >= 8 ? " (tip: click around realtor.com in this tab to help clear it)" : "") +
                  ` - nothing lost, ${total - done} to go`);
              lastNote = Date.now() + 3000;
            }
          } else if (res.kind === "ok") {                       // got the real profile
            const row = res.row;
            row.search_zip = zip;
            rows[job.i] = row; done++;
            throttleStreak = 0; sinceGood++;
            if (sinceGood >= 5 && target < MAX_T) { target++; sinceGood = 0; }  // additive increase
            log(`  ${zip}: [${done}/${total}] ${row.name || "(no name)"}${res.via === "turbo" ? " (turbo)" : ""}`);
          } else {                                              // not blocked, no data (dead/slow)
            job.dead++;
            if (job.dead < 4) queue.push(job);
            else { rows[job.i] = null; done++; log(`  ${zip}: [${done}/${total}] unreadable, skipped`); }
          }
          // One-time heads-up if Turbo isn't finding embedded data on these pages
          // (it still works via the Classic fallback - just no speed gain here).
          if (turbo && !turboHintShown && turboTried >= 8 && turboWon === 0) {
            turboHintShown = true;
            turboOff = true;   // stop the extra fetch; go pure Classic (no added load)
            log("  Turbo: these profiles don't expose data in the page source - " +
                "switching to Classic for the rest (no extra requests; nothing lost).");
          }
        } catch (e) {
          job.dead++;
          if (job.dead < 4) queue.push(job); else { rows[job.i] = null; done++; }
        } finally {
          inFlight--;
          const wait = Math.max(0, cooldownUntil - Date.now());
          setTimeout(launch, wait > 0 ? wait + 20 : 45 + Math.random() * 75);
        }
      };
      launch();
    });
    return rows.filter(Boolean);          // keep listing order; only truly-dead links drop
  }

  (async () => {
    try {
      log(`Scraping ${zips.length} ZIP(s): ${zips.join(", ")}` + (turbo ? "  [Turbo ON]" : ""));
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
      if (turbo && turboTried > 0) {
        log(`Turbo: read ${turboWon}/${turboTried} profiles the fast way` +
            (turboWon < turboTried ? `; the other ${turboTried - turboWon} used the Classic fallback.` : "."));
      }
      if (zeroZips.length > 0) {
        log(`NOTE: ${zeroZips.length} ZIP(s) returned 0 agents (likely a block). Re-run just these:`);
        log("  " + zeroZips.join(", "));
      }
    } catch (e) {
      log("Error: " + (e && e.message ? e.message : e));
    }
  })();
}
