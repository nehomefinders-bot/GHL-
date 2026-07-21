# NPI Profile Organization Scraper — Chrome Extension (by JAWAD AHMAD)

Scrapes **Organization** NPI records from a
[npiprofile.com](https://npiprofile.com/) state *Updates* table. For each
organization it opens the NPI detail page and captures:

- the top header block — **organization name, NPI number, specialty, NPI status**
- the full **Authorized Official** section — **Name, Title, Phone**

Individual records are **skipped**. Organizations with no Authorized Official
section are also skipped.

## Install (one time, ~1 minute)

1. Download **`NPIProfileScraper-Extension.zip`** from this repo.
2. **Right-click → Extract All** to a folder you'll keep. You should get a
   folder containing `manifest.json`, `popup.html`, and `popup.js`.
3. Open Chrome → `chrome://extensions`
4. Turn on **Developer mode** (top-right).
5. Click **Load unpacked** and select the extracted folder.
6. Pin the "NPI Profile Organization Scraper by JAWAD AHMAD" icon via the
   puzzle-piece menu.

## Use

1. Go to **https://npiprofile.com/**, click **Updates** in the top menu, and
   select a **state**. Wait for the records table to appear (e.g.
   `npiprofile.com/recent/ak-alaska`).
2. Click the extension icon. Optionally type a **number of organizations** to
   scrape (e.g. `5` to test) — leave **blank to scrape all** organizations.
3. Click **Scrape organizations**. A progress box appears on the page. It reads
   the table, keeps only Organization rows, and opens each one's NPI page in the
   background to grab the header + Authorized Official info. You can close the
   popup — it keeps running.
4. When it finishes it **auto-downloads** `npi_organizations_<state>.csv` to your
   Downloads folder.

## CSV columns

`organization_name, npi, specialty, npi_status, header_block,
authorized_official_name, authorized_official_title, authorized_official_phone,
profile_url`

## Notes

- Runs inside your own npiprofile.com session, so nothing is blocked.
- The table lists all records on one page; the number box limits how many
  organizations are processed (handy for a quick test).
- Use responsibly and in line with npiprofile.com's terms of service.
