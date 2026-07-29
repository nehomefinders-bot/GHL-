"""Cloud web app: paste a list of zip codes, scrape realtor.com agents one by
one in the background, download a CSV per zip as each finishes.

The job runs server-side in a background thread, so it keeps going even if you
close your browser or shut down your PC. Progress and per-zip CSV links show on
the home page (which auto-refreshes).
"""

import csv
import os
import re
import threading
from datetime import datetime

from flask import Flask, request, redirect, url_for, send_from_directory, Response

from scraper import Scraper, FIELDS, active_mode

OUTPUT_DIR = os.environ.get("OUTPUT_DIR", os.path.join(os.path.dirname(__file__), "outputs"))
os.makedirs(OUTPUT_DIR, exist_ok=True)

app = Flask(__name__)

# ---- simple in-memory job state (one job at a time) ----
JOB = {
    "running": False,
    "stop": False,
    "zips": [],
    "current": None,
    "done": [],          # list of {zip, count, file}
    "log": [],
    "started": None,
    "finished": None,
}
LOCK = threading.Lock()


def log(msg):
    line = f"{datetime.now():%H:%M:%S}  {msg}"
    JOB["log"].append(line)
    JOB["log"][:] = JOB["log"][-400:]
    print(line, flush=True)


def write_csv(zip_code, rows):
    fname = f"realtor_agents_{zip_code}.csv"
    path = os.path.join(OUTPUT_DIR, fname)
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)
    return fname


def worker(zips, max_pages):
    scraper = None
    try:
        scraper = Scraper(log)
        for zip_code in zips:
            if JOB["stop"]:
                log("Stopped by user.")
                break
            JOB["current"] = zip_code
            log(f"=== Zip {zip_code} ===")
            try:
                rows = scraper.scrape_zip(zip_code, max_pages=max_pages,
                                          stop=lambda: JOB["stop"])
            except Exception as exc:  # blocked or error - record and continue
                log(f"  zip {zip_code}: FAILED ({exc}).")
                rows = []
            fname = write_csv(zip_code, rows)
            JOB["done"].append({"zip": zip_code, "count": len(rows), "file": fname})
            log(f"  zip {zip_code}: saved {len(rows)} agents -> {fname}")
    except Exception as exc:
        log(f"Fatal error: {exc}")
    finally:
        if scraper is not None:
            scraper.close()
        JOB["current"] = None
        JOB["running"] = False
        JOB["finished"] = datetime.now().strftime("%H:%M:%S")
        log("All done.")


@app.route("/")
def home():
    rows_html = ""
    for d in JOB["done"]:
        rows_html += (
            f"<tr><td>{d['zip']}</td><td>{d['count']}</td>"
            f"<td><a href='/download/{d['file']}'>download CSV</a></td></tr>"
        )
    status = "Idle"
    if JOB["running"]:
        cur = JOB["current"] or "..."
        status = f"Running - current zip: {cur} ({len(JOB['done'])}/{len(JOB['zips'])} done)"
    elif JOB["finished"]:
        status = f"Finished at {JOB['finished']} ({len(JOB['done'])} zips)"
    log_html = "<br>".join(JOB["log"][-60:][::-1])
    refresh = "<meta http-equiv='refresh' content='5'>" if JOB["running"] else ""

    return f"""<!doctype html><html><head><meta charset=utf-8>{refresh}
<title>Realtor Agent Scraper (cloud) - by JAWAD AHMAD</title>
<style>
body{{font-family:Segoe UI,Arial,sans-serif;max-width:820px;margin:24px auto;padding:0 16px;color:#222}}
h1{{font-size:20px}} textarea{{width:100%;height:120px;font:13px monospace;padding:8px}}
input[type=number]{{width:90px;padding:6px}} button{{background:#c82021;color:#fff;border:0;border-radius:6px;padding:9px 16px;font-weight:600;cursor:pointer}}
table{{border-collapse:collapse;width:100%;margin-top:10px}} td,th{{border:1px solid #ddd;padding:6px 10px;text-align:left;font-size:14px}}
.status{{background:#f4f4f4;padding:10px;border-radius:6px;margin:12px 0}}
.log{{background:#111;color:#0f0;font:12px/1.5 monospace;padding:10px;border-radius:6px;max-height:260px;overflow:auto}}
.note{{font-size:12px;color:#666}}
</style></head><body>
<h1>Realtor.com Agent Scraper &mdash; Cloud &mdash; by JAWAD AHMAD</h1>
<form method=post action='/start'>
  <p><b>Zip codes</b> (one per line):</p>
  <textarea name=zips placeholder='30002&#10;78628&#10;76522'>{"" if JOB["running"] else ""}</textarea>
  <p>Max pages per zip (blank = all): <input type=number name=max_pages min=1 placeholder=all></p>
  <button {"disabled" if JOB["running"] else ""}>Start scraping</button>
  {"<a href='/stop'>Stop</a>" if JOB["running"] else ""}
</form>
<div class=status><b>Status:</b> {status}</div>
<h3>Completed zips</h3>
<table><tr><th>Zip</th><th>Agents</th><th>CSV</th></tr>{rows_html or "<tr><td colspan=3>none yet</td></tr>"}</table>
<h3>Live log</h3><div class=log>{log_html}</div>
<p class=note>The job runs on the server &mdash; you can close this page or your PC and it keeps going.
Backend mode: <b>{active_mode()}</b>.
If every zip returns 0 agents, realtor.com is blocking this server's IP. To get through, set
<b>one</b> of these environment variables: a scraping-API key <code>SCRAPER_API_KEY</code>
(easiest), or a residential proxy <code>SCRAPER_PROXY</code>. See cloud/README.md for the exact setup.</p>
</body></html>"""


@app.route("/start", methods=["POST"])
def start():
    if JOB["running"]:
        return redirect(url_for("home"))
    raw = request.form.get("zips", "")
    zips = [z for z in re.findall(r"\d{5}", raw)]
    if not zips:
        return redirect(url_for("home"))
    mp = request.form.get("max_pages", "").strip()
    max_pages = int(mp) if mp.isdigit() else 0

    JOB.update({"running": True, "stop": False, "zips": zips, "current": None,
                "done": [], "log": [], "started": datetime.now().strftime("%H:%M:%S"),
                "finished": None})
    log(f"Queued {len(zips)} zip(s): {', '.join(zips)}")
    threading.Thread(target=worker, args=(zips, max_pages), daemon=True).start()
    return redirect(url_for("home"))


@app.route("/stop")
def stop():
    JOB["stop"] = True
    return redirect(url_for("home"))


@app.route("/download/<path:name>")
def download(name):
    return send_from_directory(OUTPUT_DIR, name, as_attachment=True)


@app.route("/health")
def health():
    return Response("ok", mimetype="text/plain")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "7860"))
    app.run(host="0.0.0.0", port=port)
