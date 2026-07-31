#!/usr/bin/env node
/**
 * Realtor agent scraper - CLOUD edition (no browser, no proxy).
 *
 * Uses realtor.com's own GraphQL API (POST /frontdoor/graphql) directly:
 *   - SearchAgents: lists agents for a ZIP (24 per call, paginated).
 *   - AgentBrandingProfile: returns each agent's phones/office/website/etc.
 * We confirmed this endpoint answers from a plain datacenter IP with no cookies
 * or session, so it runs anywhere (GitHub Actions, a $5 VM, a Raspberry Pi) with
 * the PC off - no residential proxy required.
 *
 * Same data rules as the browser extension:
 *   - phones column = the AGENT'S OWN listed number(s) only (blank if none);
 *   - the office/brokerage line goes to contact_information, labeled "Office ph:";
 *   - polite adaptive pacing + a 7-day on-disk cache + in-run dedup, so re-runs
 *     are cheap and we stay well under any rate limit.
 *
 * Usage:
 *   ZIPS="30002,78628,76522" node scraper.js
 *   node scraper.js 30002 78628           (zips as args)
 *   (or put one ZIP per line in cloud-api/zips.txt)
 * Output: ./output/realtor_agents_<zip>.csv  +  realtor_agents_ALL.csv
 */
const fs = require("fs");
const path = require("path");

const GQL = "https://www.realtor.com/frontdoor/graphql";
const HEADERS = {
  "content-type": "application/json",
  "rdc-client-name": "agent-branding-profile",
  "rdc-client-version": "0.0.841",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
};
const OUT_DIR = process.env.OUTPUT_DIR || path.join(__dirname, "output");
const CACHE_FILE = process.env.CACHE_FILE || path.join(__dirname, ".agent_cache.json");
const CACHE_TTL = 7 * 24 * 3600 * 1000;
const BATCH = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (t) => (t == null ? "" : String(t)).replace(/\s+/g, " ").trim();
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

// ---- polite adaptive pacing (backs off on 429/403, eases back on success) ----
let paceEvery = Number(process.env.PACE_MS) || 700;
const PACE_MIN = 350, PACE_MAX = 30000;
let lastReq = 0;
async function pace() {
  const wait = Math.max(0, lastReq + paceEvery - Date.now());
  if (wait) await sleep(wait);
  lastReq = Date.now();
}
const slower = () => { paceEvery = Math.min(PACE_MAX, Math.round(paceEvery * 1.7)); };
const faster = () => { paceEvery = Math.max(PACE_MIN, Math.round(paceEvery * 0.92)); };

function isBlockedText(t) {
  t = (t || "").toLowerCase();
  return t.includes("access to this page has been denied") ||
         t.includes("your request could not be processed") ||
         t.includes("unblockrequest@realtor.com");
}

async function gql(operationName, query, variables) {
  for (let attempt = 0; attempt < 8; attempt++) {
    await pace();
    let status = 0, txt = "";
    try {
      const resp = await fetch(GQL, { method: "POST", headers: HEADERS,
        body: JSON.stringify({ operationName, query, variables }) });
      status = resp.status;
      txt = await resp.text();
    } catch (e) { slower(); await sleep(1500); continue; }
    if (status === 429 || status === 403 || isBlockedText(txt)) {
      slower();
      log(`  rate-limited (HTTP ${status}) - easing to ${Math.round(paceEvery / 1000)}s/request`);
      await sleep(paceEvery);
      continue;
    }
    faster();
    try { return JSON.parse(txt); } catch (e) { return null; }
  }
  return null;
}

// ---- queries (validated against realtor's own responses) ----
const SEARCH_QUERY =
  "query SearchAgents($searchAgentInput: SearchAgentInput) { search_agents(search_agent_input: $searchAgentInput) { agents { id fulfillment_id fullname broker { name } office { name } } matching_rows } }";
const PROFILE_FIELDS =
  "branding { id fulfillment_id fullname phones { type value } website broker { name website } office { name phones { type value } address { address_formatted_line_1 address_formatted_line_2 city state_code postal_code } } license_number license_state }";
const ONE_PROFILE_QUERY =
  "query AgentBrandingProfile($agentBrandingInput: AgentBrandingInput) { agent_branding(agent_branding_input: $agentBrandingInput) { " + PROFILE_FIELDS + " } }";
const buildBatchQuery = (ids) =>
  "query AgentBrandingBatch { " +
  ids.map((id, i) => `a${i}: agent_branding(agent_branding_input: { profile_id: ${JSON.stringify(id)} }) { ${PROFILE_FIELDS} }`).join(" ") +
  " }";

async function listAgents(zip) {
  const out = [], seen = new Set(), limit = 20;
  for (let page = 0; page < 400; page++) {
    const r = await gql("SearchAgents", SEARCH_QUERY, { searchAgentInput: {
      name: "", postal_code: zip, languages: [], agent_type: null, marketing_area_city: "",
      sort: "RELEVANT_AGENTS", offset: page * limit, agent_filter_criteria: "NRDS_AND_FULFILLMENT_ID_EXISTS",
      sort_algorithm: "DEFAULT_MODEL", limit } });
    const sa = r && r.data && r.data.search_agents;
    if (!sa || !Array.isArray(sa.agents)) break;
    let added = 0;
    for (const a of sa.agents) if (a && a.id && !seen.has(a.id)) { seen.add(a.id); out.push(a); added++; }
    const total = sa.matching_rows || out.length;
    if (added === 0 || sa.agents.length < limit || out.length >= total) break;
  }
  return out;
}

async function fetchProfiles(ids) {
  const r = await gql("AgentBrandingBatch", buildBatchQuery(ids), {});
  const out = {}; let got = 0;
  if (r && r.data) ids.forEach((id, i) => { const n = r.data["a" + i]; if (n && n.branding) { out[id] = n.branding; got++; } });
  if (got > 0) return out;
  for (const id of ids) {                          // batch unsupported -> singles
    const s = await gql("AgentBrandingProfile", ONE_PROFILE_QUERY,
      { agentBrandingInput: { profile_id: id, fulfillment_id: null, nrds_id: null } });
    const b = s && s.data && s.data.agent_branding && s.data.agent_branding.branding;
    if (b) out[id] = b;
  }
  return out;
}

function rowFromBranding(b, zip, url) {
  const phones = [], links = [], contactBits = [];
  (b.phones || []).forEach((p) => p && p.value && phones.push(clean(p.value)));   // agent's own only
  const own = new Set(phones.map((p) => p.replace(/\D/g, "")));
  if (b.broker && b.broker.name) contactBits.push(clean(b.broker.name));
  if (b.office && b.office.name) contactBits.push(clean(b.office.name));
  if (b.office && b.office.address) { const a = b.office.address;
    [a.address_formatted_line_1, a.address_formatted_line_2, a.city, a.state_code, a.postal_code].forEach((x) => x && contactBits.push(clean(x))); }
  if (b.license_state && b.license_number) contactBits.push("License " + b.license_state + " " + b.license_number);
  if (b.office && Array.isArray(b.office.phones)) b.office.phones.forEach((p) => {   // office line -> contact, labeled
    if (p && p.value && !own.has(clean(p.value).replace(/\D/g, ""))) contactBits.push("Office ph: " + clean(p.value));
  });
  if (b.website && /^https?:/.test(b.website)) links.push(b.website);
  if (b.broker && b.broker.website && /^https?:/.test(b.broker.website)) links.push(b.broker.website);
  return {
    search_zip: zip,
    name: clean(b.fullname),
    name_section: clean(b.fullname),
    contact_information: clean([...new Set(contactBits)].join(" | ")),
    phones: [...new Set(phones)].join("; "),
    website_links: [...new Set(links)].join("; "),
    profile_url: url,
  };
}

// ---- 7-day disk cache ----
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) || {}; } catch (e) { cache = {}; }
const cacheGet = (url) => { const e = cache[url]; return e && e.r && (Date.now() - e.t) < CACHE_TTL ? e.r : null; };
const cachePut = (url, r) => { cache[url] = { t: Date.now(), r }; };
function saveCache() {
  try {
    const keys = Object.keys(cache);
    if (keys.length > 20000) { keys.sort((a, b) => cache[a].t - cache[b].t).slice(0, keys.length - 20000).forEach((k) => delete cache[k]); }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch (e) {}
}

function toCSV(rows) {
  const cols = ["search_zip", "name", "name_section", "contact_information", "phones", "website_links", "profile_url"];
  const esc = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  const out = [cols.join(",")];
  for (const r of rows) out.push(cols.map((c) => esc(r[c])).join(","));
  return "﻿" + out.join("\r\n");
}

async function scrapeZip(zip, mem) {
  log(`ZIP ${zip}: listing agents...`);
  const agents = await listAgents(zip);
  if (agents.length === 0) { log(`ZIP ${zip}: 0 agents (check the ZIP, or a transient block).`); return []; }
  log(`ZIP ${zip}: ${agents.length} agents found. Fetching contact details...`);
  const rows = new Array(agents.length);
  const pending = [];
  agents.forEach((a, i) => {
    const url = "https://www.realtor.com/realestateagents/" + a.id;
    const hit = mem.get(url) || cacheGet(url);
    if (hit && hit.name) { rows[i] = { ...hit, search_zip: zip }; mem.set(url, rows[i]); }
    else pending.push({ a, i, url });
  });
  let done = agents.length - pending.length;
  for (let k = 0; k < pending.length; k += BATCH) {
    const chunk = pending.slice(k, k + BATCH);
    const profiles = await fetchProfiles(chunk.map((c) => c.a.id));
    for (const c of chunk) {
      const b = profiles[c.a.id];
      let row = b ? rowFromBranding(b, zip, c.url) : null;
      if (row && !row.name) row.name = clean(c.a.fullname);
      if (!row || !row.name) {
        const name = clean(c.a.fullname);
        row = { search_zip: zip, name, name_section: name,
          contact_information: clean([c.a.broker && c.a.broker.name, c.a.office && c.a.office.name].filter(Boolean).join(" | ")),
          phones: "", website_links: "", profile_url: c.url };
      }
      if (b) { cachePut(c.url, row); mem.set(c.url, row); }
      rows[c.i] = row;
    }
    done += chunk.length;
    log(`ZIP ${zip}: ${done}/${agents.length}`);
    saveCache();
  }
  return rows.filter(Boolean);
}

async function main() {
  const zips = (process.env.ZIPS || process.argv.slice(2).join(",") ||
    (fs.existsSync(path.join(__dirname, "zips.txt")) ? fs.readFileSync(path.join(__dirname, "zips.txt"), "utf8") : ""))
    .match(/\d{5}/g) || [];
  if (zips.length === 0) { console.error("No ZIP codes. Set ZIPS=\"30002,78628\" or fill zips.txt."); process.exit(1); }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  log(`Starting ${zips.length} ZIP(s): ${zips.join(", ")}`);
  const mem = new Map();
  const all = [];
  const zero = [];
  for (const zip of zips) {
    const rows = await scrapeZip(zip, mem);
    fs.writeFileSync(path.join(OUT_DIR, `realtor_agents_${zip}.csv`), toCSV(rows));
    all.push(...rows);
    if (rows.length === 0) zero.push(zip);
    log(`ZIP ${zip}: saved ${rows.length} agents -> realtor_agents_${zip}.csv`);
  }
  if (all.length) fs.writeFileSync(path.join(OUT_DIR, "realtor_agents_ALL.csv"), toCSV(all));
  saveCache();
  log(`DONE. ${all.length} agents across ${zips.length} ZIP(s) -> ${OUT_DIR}`);
  if (zero.length) log(`NOTE: 0 agents for: ${zero.join(", ")} (re-run those).`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { rowFromBranding, toCSV, buildBatchQuery, SEARCH_QUERY, ONE_PROFILE_QUERY };
