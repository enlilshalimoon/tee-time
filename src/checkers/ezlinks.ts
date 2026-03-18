/**
 * EZLinks Golf (iSeekGolf) API checker.
 *
 * The ezlinksgolf.com booking pages are Angular SPAs that block headless
 * Chrome via TLS fingerprinting.  Node.js/axios has a different TLS
 * fingerprint and is not flagged, so we call the REST API directly instead
 * of using a browser.
 *
 * The iSeekGolf API lives on the same subdomain as the booking page:
 *   https://{facility}.ezlinksgolf.com/api/v1/teesheets?date=YYYY-MM-DD&players=1
 *
 * If the first endpoint pattern fails we try a handful of alternates and
 * log enough detail to identify the real path.
 */

import axios from "axios";
import { CourseConfig, TeeTime } from "../types";

// Browser-like headers so the API doesn't reject plain Node.js requests
const HEADERS = {
  "accept": "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "referer": "",   // set per-request
  "x-requested-with": "XMLHttpRequest",
};

/** Pull the base URL (scheme + host) from a booking URL. */
function baseUrl(bookingUrl: string): string {
  const u = new URL(bookingUrl);
  return `${u.protocol}//${u.host}`;
}

/** Candidate API paths to try in order. */
function apiCandidates(base: string, date: string): string[] {
  return [
    `${base}/api/v1/teesheets?date=${date}&players=1`,
    `${base}/api/v1/teesheets?date=${date}&players=1&holes=18`,
    `${base}/api/v1/teetimes?date=${date}&players=1`,
    `${base}/api/v1/courses/teesheets?date=${date}&players=1`,
    `${base}/api/v2/teesheets?date=${date}&players=1`,
  ];
}

// ---------------------------------------------------------------------------
// Heuristic extraction (same logic as web-scraper but self-contained)
// ---------------------------------------------------------------------------

const TIME_KEYS = [
  "time", "startTime", "start_time", "teeTime", "tee_time",
  "StartTime", "teetime", "start", "TeeTime", "teeOffTime", "displayTime",
];
const AVAIL_KEYS = [
  "available_spots", "availableSlots", "spots", "available", "openSlots",
  "maxPlayers", "remainingSlots", "NumberOfPlayersAvailable", "availablePlayers",
];
const PRICE_KEYS = [
  "price", "green_fee", "greenFee", "rate", "baseRate", "amount", "fee",
  "GreenFee", "Price", "displayPrice", "displayRate",
];

function pick<T>(obj: Record<string, unknown>, keys: string[]): T | undefined {
  for (const k of keys) if (obj[k] != null) return obj[k] as T;
}

function findArrays(data: unknown, depth = 0): Array<Record<string, unknown>[]> {
  if (depth > 6) return [];
  const out: Array<Record<string, unknown>[]> = [];
  if (Array.isArray(data)) {
    const objs = data.filter(v => typeof v === "object" && v !== null && !Array.isArray(v)) as Record<string, unknown>[];
    if (objs.length > 0) out.push(objs);
    for (const item of data) out.push(...findArrays(item, depth + 1));
  } else if (typeof data === "object" && data !== null) {
    for (const v of Object.values(data as Record<string, unknown>)) out.push(...findArrays(v, depth + 1));
  }
  return out;
}

function normalizeTime(raw: string): string {
  const ampm = raw.match(/(\d{1,2}):(\d{2})\s*([APap][Mm]?)/);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const m = ampm[2];
    if (ampm[3].toLowerCase().startsWith("p") && h !== 12) h += 12;
    if (ampm[3].toLowerCase().startsWith("a") && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${m}`;
  }
  const hhmm = raw.match(/(\d{1,2}):(\d{2})/);
  if (hhmm) return `${hhmm[1].padStart(2, "0")}:${hhmm[2]}`;
  return raw;
}

function extractTimes(data: unknown): TeeTime[] | null {
  for (const arr of findArrays(data)) {
    const hits = arr.filter(o => !!pick(o, TIME_KEYS));
    if (hits.length < 2) continue;
    const times: TeeTime[] = [];
    for (const item of arr) {
      const rawTime = pick<string>(item, TIME_KEYS);
      if (!rawTime) continue;
      const avail = pick<number>(item, AVAIL_KEYS) ?? 4;
      let price: number | undefined;
      const rp = pick<unknown>(item, PRICE_KEYS);
      if (typeof rp === "number") price = rp;
      else if (typeof rp === "string") { const n = parseFloat(rp.replace(/[$,]/g, "")); if (!isNaN(n)) price = n; }
      times.push({ time: normalizeTime(String(rawTime)), players: typeof avail === "number" ? avail : 4, holes: 18, price });
    }
    if (times.length > 0) return times;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function checkEZLinks(course: CourseConfig, date: string): Promise<TeeTime[]> {
  if (!course.bookingUrl) throw new Error(`${course.name}: bookingUrl required`);

  const base = baseUrl(course.bookingUrl);
  const candidates = apiCandidates(base, date);
  const headers = { ...HEADERS, referer: base + "/" };

  for (const url of candidates) {
    try {
      console.log(`[ezlinks] ${course.name}: trying ${url}`);
      const resp = await axios.get(url, { headers, timeout: 10_000 });
      const times = extractTimes(resp.data);
      if (times && times.length > 0) {
        console.log(`[ezlinks] ${course.name}: got ${times.length} slot(s) from ${url}`);
        return times.filter(t => t.players > 0);
      }
      console.log(`[ezlinks] ${course.name}: 200 but no tee-time data at ${url} — response keys: ${Object.keys(resp.data ?? {}).join(", ")}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 404 means wrong path — try next; anything else is a real error
      if (!msg.includes("404") && !msg.includes("status code 404")) {
        console.warn(`[ezlinks] ${course.name}: ${url} → ${msg}`);
      }
    }
  }

  throw new Error(`EZLinks API not found for ${course.name} — tried ${candidates.length} endpoint patterns. Check server logs for response details.`);
}
