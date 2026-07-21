const goBtn = document.getElementById("go");
const statusBox = document.getElementById("status");
const setStatus = (m) => (statusBox.textContent = m);

(async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/npiprofile\.com\//.test(tab.url || "")) {
    setStatus("Open npiprofile.com, click Updates, pick a state so the records\n" +
              "table shows, then click the button.");
    goBtn.disabled = true;
  } else if (!/\/recent\//.test(tab.url)) {
    setStatus("You're on npiprofile.com. Click Updates and select a state so the\n" +
              "records table appears, then click the button.");
  } else {
    setStatus("Ready. Click the button to scrape all Organization records here.");
  }
})();

goBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  const raw = document.getElementById("count").value.trim();
  let maxOrgs = 0; // 0 = all
  if (raw !== "") {
    maxOrgs = parseInt(raw, 10);
    if (!Number.isInteger(maxOrgs) || maxOrgs < 1) {
      setStatus("Enter a whole number of organizations (1 or more), or leave blank for all.");
      return;
    }
  }

  goBtn.disabled = true;
  setStatus("Started" + (maxOrgs ? " (first " + maxOrgs + " organization" + (maxOrgs > 1 ? "s" : "") + ")"
                                 : " (all organizations)") +
            ".\nA progress box shows on the page. You can close this popup - it keeps\n" +
            "running. The CSV downloads automatically when it's done.");
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [maxOrgs],
    func: scrapeNpi,
  }).catch((e) => setStatus("Could not start: " + e.message));
});

// ---------------------------------------------------------------------------
// Runs INSIDE the npiprofile.com page. Reads the rendered state records table,
// keeps only Organization rows, and opens each organization's NPI detail page
// in a hidden same-origin iframe to read the header block + Authorized Official
// section. Everything happens in the user's own session.
// ---------------------------------------------------------------------------
function scrapeNpi(maxOrgs) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (t) => (t || "").replace(/\s+/g, " ").trim();

  // ----- progress panel -----
  let panel = document.getElementById("__npi_scraper_panel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "__npi_scraper_panel";
    panel.style.cssText =
      "position:fixed;top:12px;right:12px;z-index:2147483647;width:340px;" +
      "max-height:75vh;overflow:auto;background:#0b2a3f;color:#8fe3ff;font:12px/1.5 " +
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

  // ----- load a same-origin URL in a hidden iframe and wait for render -----
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
          if (doc && isReady(doc)) { await sleep(300); finish(frame.contentDocument); return; }
          await sleep(300);
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

  // Find the value next to a label like "Authorized Official Name".
  function valueFor(doc, label) {
    const all = doc.querySelectorAll("td,th,div,span,dt,dd,li,p,strong,b");
    for (const el of all) {
      if (clean(el.textContent) === label) {
        let node = el;
        for (let i = 0; i < 4 && node; i++) {
          const sib = node.nextElementSibling;
          if (sib) {
            const v = clean(sib.textContent);
            if (v && v !== label) return v;
          }
          node = node.parentElement;
        }
      }
    }
    return "";
  }

  function parseDetail(doc, npi, url) {
    const h1 = doc.querySelector("h1");
    const name = clean(h1 && h1.textContent);

    // Header ("red rectangle"): name, NPI, specialty, status.
    let headerText = "";
    if (h1) {
      const box = h1.closest("div, section, header") || h1;
      headerText = (box.innerText || box.textContent || "");
    }
    const hLines = headerText.split("\n").map(clean).filter(Boolean);
    let npiNum = npi || "";
    if (!npiNum) {
      const m = headerText.match(/NPI\s*(\d{10})/);
      if (m) npiNum = m[1];
    }
    const specialty = hLines.find(
      (l) => / - /.test(l) && !/^NPI\b/i.test(l) && l !== name
    ) || "";
    const status = hLines.find((l) => /^NPI Status/i.test(l)) || "";

    // Authorized Official section.
    const aoName = valueFor(doc, "Authorized Official Name");
    const aoTitle = valueFor(doc, "Authorized Official Title");
    const aoPhone = valueFor(doc, "Authorized Official Phone");

    return {
      organization_name: name,
      npi: npiNum,
      specialty: specialty,
      npi_status: status,
      header_block: [name, npiNum ? "NPI " + npiNum : "", specialty, status]
        .filter(Boolean).join(" | "),
      authorized_official_name: aoName,
      authorized_official_title: aoTitle,
      authorized_official_phone: aoPhone,
      profile_url: url,
      _hasOfficial: !!aoName,
    };
  }

  function toCSV(rows) {
    const cols = ["organization_name", "npi", "specialty", "npi_status", "header_block",
                  "authorized_official_name", "authorized_official_title",
                  "authorized_official_phone", "profile_url"];
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
      const label = (location.pathname.split("/recent/")[1] || "state").split("/")[0] || "state";
      log("NPI Organization scraper started for: " + label);
      log(maxOrgs && maxOrgs > 0 ? "Limit: first " + maxOrgs + " organization(s)." : "Limit: all organizations.");

      // 1) Collect Organization rows from the records table.
      // NPI detail links are anchors whose href contains the 10-digit NPI number.
      const npiAnchors = [...document.querySelectorAll("a[href]")].filter((a) => {
        const href = a.getAttribute("href") || "";
        return /\d{10}/.test(href) || /\b\d{10}\b/.test(a.textContent || "");
      });
      log("Scanning page: " + npiAnchors.length + " NPI links found.");

      const orgs = [];
      const processed = new Set();
      let orgHits = 0, indivHits = 0, unknown = 0;
      for (const a of npiAnchors) {
        const href = a.getAttribute("href") || "";
        const m = href.match(/(\d{10})/) || (a.textContent || "").match(/(\d{10})/);
        if (!m) continue;
        const npi = m[1];
        if (processed.has(npi)) continue;

        // Climb up until we reach the first ancestor that says which type it is.
        let isOrg = false, isIndiv = false;
        let node = a;
        for (let i = 0; i < 10 && node; i++) {
          const t = node.textContent || "";
          const hasOrg = /\bOrganization\b/i.test(t);
          const hasInd = /\bIndividual\b/i.test(t);
          if (hasOrg || hasInd) {
            // Prefer the more specific one if only one is present at this level.
            if (hasOrg && !hasInd) isOrg = true;
            else if (hasInd && !hasOrg) isIndiv = true;
            else { isOrg = hasOrg; } // both present (climbed too far) - default org
            break;
          }
          node = node.parentElement;
        }

        if (isOrg) { orgHits++; processed.add(npi); orgs.push({ npi, url: a.href }); }
        else if (isIndiv) { indivHits++; processed.add(npi); }
        else { unknown++; }
      }

      log("Classified - Organizations: " + orgHits + ", Individuals skipped: " +
          indivHits + (unknown ? ", unclassified: " + unknown : "") + ".");
      log("Found " + orgs.length + " organization records.");
      if (orgs.length === 0) {
        log("No organizations detected. Make sure the state records table is fully");
        log("loaded/visible on this page, then click Scrape again.");
        return;
      }

      const targets = maxOrgs && maxOrgs > 0 ? orgs.slice(0, maxOrgs) : orgs;
      log("Reading detail pages for " + targets.length + " organization(s)...");

      const rowsOut = [];
      let skipped = 0;
      for (let i = 0; i < targets.length; i++) {
        const { npi, url } = targets[i];
        const ready = (d) => !!d.querySelector("h1");
        const doc = await loadInFrame(url, ready, 12000);
        if (!doc || !doc.querySelector("h1")) {
          log("[" + (i + 1) + "/" + targets.length + "] could not load NPI " + npi + ", skipped.");
          continue;
        }
        const rec = parseDetail(doc, npi, url);
        if (!rec._hasOfficial) {
          skipped++;
          log("[" + (i + 1) + "/" + targets.length + "] " + (rec.organization_name || npi) +
              " - no Authorized Official, skipped.");
        } else {
          delete rec._hasOfficial;
          rowsOut.push(rec);
          log("[" + (i + 1) + "/" + targets.length + "] " + (rec.organization_name || npi) +
              "  |  AO: " + rec.authorized_official_name);
        }
        await sleep(500);
      }

      if (rowsOut.length === 0) {
        log("No organizations with an Authorized Official section were found.");
        return;
      }
      download(toCSV(rowsOut), "npi_organizations_" + label + ".csv");
      log("DONE. Saved " + rowsOut.length + " organizations" +
          (skipped ? " (" + skipped + " skipped, no Authorized Official)" : "") +
          " -> npi_organizations_" + label + ".csv");
      log("(Check your Downloads folder.)");
    } catch (e) {
      log("Error: " + (e && e.message ? e.message : e));
    }
  })();
}
