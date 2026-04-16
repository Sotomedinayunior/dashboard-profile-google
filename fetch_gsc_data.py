"""
fetch_gsc_data.py
Fetches data from Google Search Console API and writes data.json
for the Nelly RAC Growth Dashboard.
"""

import json
import os
from datetime import datetime, timedelta
from google.oauth2 import service_account
from googleapiclient.discovery import build

# ── Config ────────────────────────────────────────────────────────────────────
CREDENTIALS_FILE = "credentials.json"
GSC_PROPERTY     = os.environ.get("GSC_PROPERTY", "https://nellyrac.do/")
SCOPES           = ["https://www.googleapis.com/auth/webmasters.readonly"]

# Date ranges
TODAY      = datetime.utcnow().date()
DATE_END   = str(TODAY - timedelta(days=2))   # GSC lags ~2 days
DATE_START_6M = str(TODAY - timedelta(days=182))
DATE_START_28D = str(TODAY - timedelta(days=28))
DATE_START_7D  = str(TODAY - timedelta(days=7))

# ── Auth ──────────────────────────────────────────────────────────────────────
creds   = service_account.Credentials.from_service_account_file(
              CREDENTIALS_FILE, scopes=SCOPES)
service = build("searchconsole", "v1", credentials=creds)

def query(start_date, end_date, dimensions, row_limit=100, filters=None):
    body = {
        "startDate": start_date,
        "endDate":   end_date,
        "dimensions": dimensions,
        "rowLimit":  row_limit,
    }
    if filters:
        body["dimensionFilterGroups"] = filters
    resp = service.searchanalytics().query(
        siteUrl=GSC_PROPERTY, body=body).execute()
    return resp.get("rows", [])

# ── Fetch all datasets ────────────────────────────────────────────────────────

print("Fetching daily trend (6 months)...")
daily_rows = query(DATE_START_6M, DATE_END, ["date"], row_limit=182)
chart = [
    {
        "date":        r["keys"][0],
        "clicks":      r["clicks"],
        "impressions": r["impressions"],
        "ctr":         round(r["ctr"] * 100, 2),
        "position":    round(r["position"], 1),
    }
    for r in daily_rows
]

print("Fetching top queries (6 months)...")
query_rows = query(DATE_START_6M, DATE_END, ["query"], row_limit=1000)
queries = [
    {
        "query":       r["keys"][0],
        "clicks":      r["clicks"],
        "impressions": r["impressions"],
        "ctr":         round(r["ctr"] * 100, 2),
        "position":    round(r["position"], 2),
    }
    for r in query_rows
]

print("Fetching top pages (6 months)...")
page_rows = query(DATE_START_6M, DATE_END, ["page"], row_limit=250)
pages = [
    {
        "page":        r["keys"][0],
        "clicks":      r["clicks"],
        "impressions": r["impressions"],
        "ctr":         round(r["ctr"] * 100, 2),
        "position":    round(r["position"], 2),
    }
    for r in page_rows
]

print("Fetching countries (6 months)...")
country_rows = query(DATE_START_6M, DATE_END, ["country"], row_limit=200)
countries = [
    {
        "country":     r["keys"][0],
        "clicks":      r["clicks"],
        "impressions": r["impressions"],
        "ctr":         round(r["ctr"] * 100, 2),
        "position":    round(r["position"], 2),
    }
    for r in country_rows
]

print("Fetching devices (6 months)...")
device_rows = query(DATE_START_6M, DATE_END, ["device"], row_limit=10)
devices = [
    {
        "device":      r["keys"][0],
        "clicks":      r["clicks"],
        "impressions": r["impressions"],
        "ctr":         round(r["ctr"] * 100, 2),
        "position":    round(r["position"], 2),
    }
    for r in device_rows
]

print("Fetching last 28 days summary...")
summary_28d = query(DATE_START_28D, DATE_END, ["date"], row_limit=28)
total_clicks_28d      = sum(r["clicks"] for r in summary_28d)
total_impressions_28d = sum(r["impressions"] for r in summary_28d)
avg_ctr_28d  = round(total_clicks_28d / total_impressions_28d * 100, 2) if total_impressions_28d else 0
avg_pos_28d  = round(
    sum(r["position"] * r["impressions"] for r in summary_28d)
    / max(total_impressions_28d, 1), 1
)

print("Fetching last 7 days summary...")
summary_7d = query(DATE_START_7D, DATE_END, ["date"], row_limit=7)
total_clicks_7d      = sum(r["clicks"] for r in summary_7d)
total_impressions_7d = sum(r["impressions"] for r in summary_7d)
avg_ctr_7d  = round(total_clicks_7d / total_impressions_7d * 100, 2) if total_impressions_7d else 0
avg_pos_7d  = round(
    sum(r["position"] * r["impressions"] for r in summary_7d)
    / max(total_impressions_7d, 1), 1
)

# ── 6-month totals ────────────────────────────────────────────────────────────
total_clicks_6m      = sum(r["clicks"] for r in daily_rows)
total_impressions_6m = sum(r["impressions"] for r in daily_rows)
avg_ctr_6m  = round(total_clicks_6m / total_impressions_6m * 100, 2) if total_impressions_6m else 0
avg_pos_6m  = round(
    sum(r["position"] * r["impressions"] for r in daily_rows)
    / max(total_impressions_6m, 1), 1
)
avg_clicks_per_day = round(total_clicks_6m / max(len(daily_rows), 1), 1)

# ── Build output ──────────────────────────────────────────────────────────────
output = {
    "meta": {
        "updated_at":   str(TODAY),
        "date_start":   DATE_START_6M,
        "date_end":     DATE_END,
        "gsc_property": GSC_PROPERTY,
    },
    "summary_6m": {
        "total_clicks":      total_clicks_6m,
        "total_impressions": total_impressions_6m,
        "avg_ctr":           avg_ctr_6m,
        "avg_position":      avg_pos_6m,
        "avg_clicks_per_day": avg_clicks_per_day,
        "days":              len(daily_rows),
    },
    "summary_28d": {
        "total_clicks":      total_clicks_28d,
        "total_impressions": total_impressions_28d,
        "avg_ctr":           avg_ctr_28d,
        "avg_position":      avg_pos_28d,
    },
    "summary_7d": {
        "total_clicks":      total_clicks_7d,
        "total_impressions": total_impressions_7d,
        "avg_ctr":           avg_ctr_7d,
        "avg_position":      avg_pos_7d,
    },
    "chart":     chart,
    "queries":   queries,
    "pages":     pages,
    "countries": countries,
    "devices":   devices,
}

with open("data.json", "w", encoding="utf-8") as f:
    json.dump(output, f, ensure_ascii=False, indent=2)

print(f"✅ data.json written — {len(chart)} days, {len(queries)} queries, "
      f"{len(pages)} pages, {len(countries)} countries")
print(f"   6M: {total_clicks_6m:,} clicks | {total_impressions_6m:,} impressions "
      f"| CTR {avg_ctr_6m}% | Pos {avg_pos_6m}")
