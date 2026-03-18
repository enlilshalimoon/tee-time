/**
 * EZLinks Golf (iSeekGolf) tee time checker.
 *
 * The Angular SPA posts to /api/search/search on the facility subdomain.
 * Node.js axios is not blocked by Cloudflare here (different TLS fingerprint
 * than headless Chrome), so we call the endpoint directly.
 */

import axios from "axios";
import { CourseConfig, TeeTime } from "../types";

const BROWSER_HEADERS = {
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9",
  "content-type": "application/json",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "x-requested-with": "XMLHttpRequest",
};

// ---------------------------------------------------------------------------
// Heuristic tee-time extraction (handles unknown response shape)
// ---------------------------------------------------------------------------

const TIME_KEYS = [
  "time", "startTime", "start_time", "teeTime", "tee_time",
  "StartTime", "teetime", "start", "TeeTime", "teeOffTime",
  "displayTime", "scheduledTime", "scheduled_time", "formattedTime",
  "slot_time",
];
const AVAIL_KEYS = [
  "available_spots", "availableSlots", "spots", "available", "openSlots",
  "maxPlayers", "remainingSlots", "NumberOfPlayersAvailable", "availablePlayers",
  "spotsAvailable", "playersAvailable", "nb_available_spots", "slotsAvailable",
  "openings", "maxAvailableSpots",
];
const PRICE_KEYS = [
  "price", "green_fee", "greenFee", "rate", "baseRate", "amount", "fee",
  "GreenFee", "Price", "displayPrice", "displayRate", "totalRate",
  "rateAmount", "pricePerPlayer", "customerPrice",
];

function pick<T>(obj: Record<string, unknown>, keys: string[]): T | undefined {
  for (const k of keys) if (obj[k] != null) return obj[k] as T;
}

function findArrays(data: unknown, depth = 0): Array<Record<string, unknown>[]> {
  if (depth > 8) return [];
  const out: Array<Record<string, unknown>[]> = [];
  if (Array.isArray(data)) {
    const objs = data.filter(
      (v) => typeof v === "object" && v !== null && !Array.isArray(v)
    ) as Record<string, unknown>[];
    if (objs.length > 0) out.push(objs);
    for (const item of data) out.push(...findArrays(item, depth + 1));
  } else if (typeof data === "object" && data !== null) {
    for (const v of Object.values(data as Record<string, unknown>))
      out.push(...findArrays(v, depth + 1));
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
  if (typeof data === "object" && data !== null) {
    console.log(
      `[ezlinks] response top-level keys: ${Object.keys(data as Record<string, unknown>).join(", ")}`
    );
  }

  for (const arr of findArrays(data)) {
    if (arr.length === 0) continue;
    console.log(
      `[ezlinks] array candidate (${arr.length} items), first-item keys: ${Object.keys(arr[0]).join(", ")}`
    );

    const hits = arr.filter((o) => !!pick(o, TIME_KEYS));
    if (hits.length < 1) continue;

    const times: TeeTime[] = [];
    for (const item of arr) {
      const rawTime = pick<string>(item, TIME_KEYS);
      if (!rawTime) continue;
      const avail = pick<number>(item, AVAIL_KEYS) ?? 4;
      let price: number | undefined;
      const rp = pick<unknown>(item, PRICE_KEYS);
      if (typeof rp === "number") price = rp;
      else if (typeof rp === "string") {
        const n = parseFloat(rp.replace(/[$,]/g, ""));
        if (!isNaN(n)) price = n;
      } else if (typeof rp === "object" && rp !== null) {
        const inner =
          (rp as Record<string, unknown>).amount ??
          (rp as Record<string, unknown>).price;
        if (typeof inner === "number") price = inner;
      }
      times.push({
        time: normalizeTime(String(rawTime)),
        players: typeof avail === "number" ? avail : 4,
        holes: 18,
        price,
      });
    }
    if (times.length > 0) return times;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Request body builders — try most-likely format first, fall back if empty
// ---------------------------------------------------------------------------

function baseUrl(bookingUrl: string): string {
  const u = new URL(bookingUrl);
  return `${u.protocol}//${u.host}`;
}

function buildBodies(date: string): Record<string, unknown>[] {
  const [year, month, day] = date.split("-");
  const mmddyyyy = `${month}/${day}/${year}`; // EZLinks date picker format
  return [
    // Format 1: ISO date with holes/players
    { date, holes: 18, players: 1 },
    // Format 2: MM/DD/YYYY (Angular datepicker format)
    { date: mmddyyyy, holes: 18, players: 1 },
    // Format 3: nested search object
    { search: { date, holes: 18, players: 1 } },
    // Format 4: camelCase field names
    { searchDate: date, numberOfHoles: 18, numberOfPlayers: 1 },
    // Format 5: with timeFrom/timeTo (some EZLinks installs)
    { date, holes: 18, players: 1, timeFrom: "0500", timeTo: "1800" },
  ];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function checkEZLinks(
  course: CourseConfig,
  date: string // YYYY-MM-DD
): Promise<TeeTime[]> {
  if (!course.bookingUrl) throw new Error(`${course.name}: bookingUrl required`);

  const base = baseUrl(course.bookingUrl);
  const endpoint = `${base}/api/search/search`;
  const headers = { ...BROWSER_HEADERS, referer: base + "/" };

  for (const body of buildBodies(date)) {
    try {
      console.log(`[ezlinks] ${course.name}: POST ${endpoint} body=${JSON.stringify(body)}`);
      const resp = await axios.post(endpoint, body, { headers, timeout: 15_000 });
      const times = extractTimes(resp.data);
      if (times && times.length > 0) {
        console.log(`[ezlinks] ${course.name}: ✓ ${times.length} slot(s) on ${date}`);
        return times.filter((t) => t.players > 0);
      }
      // Got 200 but no parseable times — log shape and try next body format
      console.log(
        `[ezlinks] ${course.name}: 200 but no times extracted. ` +
        `Response type: ${typeof resp.data}, ` +
        `keys: ${typeof resp.data === "object" ? Object.keys(resp.data ?? {}).slice(0, 10).join(",") : "n/a"}`
      );
    } catch (err) {
      const e = err instanceof Error ? err.message : String(err);
      // 4xx from first body format → try next; connection errors → bail
      const isConnError = e.includes("ECONNRESET") || e.includes("ECONNREFUSED") ||
        e.includes("timeout") || e.includes("socket hang");
      if (isConnError) throw new Error(`EZLinks connection error for ${course.name}: ${e}`);
      console.warn(`[ezlinks] ${course.name}: POST failed (${e}) — trying next body format`);
    }
  }

  // Tried all body formats, none worked — return empty rather than throwing
  // so the bot doesn't report a noisy error chain
  console.warn(`[ezlinks] ${course.name}: all body formats tried, no times returned for ${date}`);
  return [];
}
