/**
 * EZLinks Golf (iSeekGolf) API checker.
 *
 * Strategy:
 *   1. Fetch the Angular app's index.html to discover the actual API endpoint
 *      (EZLinks embeds config in the page or compiles it into the main JS bundle).
 *   2. Make a direct axios request to the REST API — Node.js has a different
 *      TLS fingerprint than Chrome and is not blocked by Cloudflare BIC.
 *   3. Fall back through several known EZLinks API path patterns.
 */

import axios from "axios";
import { CourseConfig, TeeTime } from "../types";

const BROWSER_HEADERS = {
  "accept": "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "x-requested-with": "XMLHttpRequest",
};

function baseUrl(bookingUrl: string): string {
  const u = new URL(bookingUrl);
  return `${u.protocol}//${u.host}`;
}

// ---------------------------------------------------------------------------
// API endpoint discovery — read the Angular bundle to find the real path
// ---------------------------------------------------------------------------

// Cache so we only crawl each facility once per process run
const discoveredApiBase = new Map<string, string>();

async function discoverApiBase(facilityBase: string): Promise<string | null> {
  if (discoveredApiBase.has(facilityBase)) return discoveredApiBase.get(facilityBase)!;

  const headers = { ...BROWSER_HEADERS, referer: facilityBase + "/" };

  try {
    // 1. Fetch index.html
    const htmlResp = await axios.get(`${facilityBase}/index.html`, {
      headers: { ...headers, accept: "text/html,*/*" },
      timeout: 10_000,
    });
    const html = String(htmlResp.data);
    console.log(`[ezlinks] index.html status: ${htmlResp.status}, length: ${html.length}`);
    console.log(`[ezlinks] index.html snippet: ${html.slice(0, 500)}`);

    // 2. Look for inline window config (common Angular pattern)
    const envPatterns = [
      /window\.__env\s*=\s*({[\s\S]*?});/,
      /window\.env\s*=\s*({[\s\S]*?});/,
      /apiUrl\s*:\s*["']([^"']+)["']/,
      /baseUrl\s*:\s*["']([^"']+)["']/,
      /apiBase\s*:\s*["']([^"']+)["']/,
    ];
    for (const re of envPatterns) {
      const m = html.match(re);
      if (m) {
        console.log(`[ezlinks] Found inline config: ${m[0].slice(0, 200)}`);
        // If it's a JSON object, try to parse
        try {
          const obj = JSON.parse(m[1]);
          const apiUrl = obj.apiUrl ?? obj.baseUrl ?? obj.apiBase;
          if (apiUrl) { discoveredApiBase.set(facilityBase, apiUrl); return apiUrl; }
        } catch {
          // m[1] might be the URL directly (from the third pattern)
          if (m[1]?.startsWith("http")) { discoveredApiBase.set(facilityBase, m[1]); return m[1]; }
        }
      }
    }

    // 3. Find the main Angular JS bundle and search it for the API URL
    const scriptMatches = [...html.matchAll(/src="([^"]*(?:main|vendor|chunk)[^"]*\.js)"/g)];
    console.log(`[ezlinks] Found ${scriptMatches.length} script(s): ${scriptMatches.map(m => m[1]).join(", ")}`);

    for (const match of scriptMatches.slice(0, 3)) {
      let scriptSrc = match[1];
      if (!scriptSrc.startsWith("http")) scriptSrc = `${facilityBase}/${scriptSrc.replace(/^\//, "")}`;
      try {
        const jsResp = await axios.get(scriptSrc, { headers, timeout: 20_000 });
        const js = String(jsResp.data);
        console.log(`[ezlinks] bundle ${scriptSrc} length: ${js.length}`);

        // Search for API URL strings in the minified JS
        const apiPatterns = [
          /["'](https?:\/\/[^"']*(?:api|services?|booking)[^"']*)/g,
          /"(\/api\/v\d[^"]+)"/g,
          /apiUrl["'\s:]+["']([^"']+)["']/g,
        ];
        for (const re of apiPatterns) {
          let m: RegExpExecArray | null;
          while ((m = re.exec(js)) !== null) {
            const candidate = m[1];
            if (candidate.length < 100 && (candidate.includes("api") || candidate.includes("service"))) {
              console.log(`[ezlinks] Found API URL in bundle: ${candidate}`);
              const apiBase = candidate.startsWith("http") ? candidate : `${facilityBase}${candidate}`;
              discoveredApiBase.set(facilityBase, apiBase);
              return apiBase;
            }
          }
        }
      } catch (e) {
        console.warn(`[ezlinks] Failed to fetch bundle ${scriptSrc}: ${e}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[ezlinks] HTML discovery failed: ${msg}`);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Heuristic tee-time extraction
// ---------------------------------------------------------------------------

const TIME_KEYS = [
  "time", "startTime", "start_time", "teeTime", "tee_time",
  "StartTime", "teetime", "start", "TeeTime", "teeOffTime",
  "displayTime", "scheduledTime", "scheduled_time", "teeTimeSlot",
  "slot_time", "tee_off_time", "formattedTime",
];
const AVAIL_KEYS = [
  "available_spots", "availableSlots", "spots", "available", "openSlots",
  "maxPlayers", "remainingSlots", "NumberOfPlayersAvailable", "availablePlayers",
  "spotsAvailable", "playersAvailable", "nb_available_spots", "slotsAvailable",
  "availSpots", "openings", "maxAvailableSpots",
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
  // Log the top-level structure for debugging
  if (typeof data === "object" && data !== null) {
    console.log(`[ezlinks] Response top-level keys: ${Object.keys(data as Record<string, unknown>).join(", ")}`);
  }

  for (const arr of findArrays(data)) {
    if (arr.length === 0) continue;
    // Log first item's keys for debugging
    console.log(`[ezlinks] Array candidate (${arr.length} items), first-item keys: ${Object.keys(arr[0]).join(", ")}`);

    const hits = arr.filter(o => !!pick(o, TIME_KEYS));
    if (hits.length < 1) continue;  // relaxed: even 1 item is worth trying

    const times: TeeTime[] = [];
    for (const item of arr) {
      const rawTime = pick<string>(item, TIME_KEYS);
      if (!rawTime) continue;
      const avail = pick<number>(item, AVAIL_KEYS) ?? 4;
      let price: number | undefined;
      const rp = pick<unknown>(item, PRICE_KEYS);
      if (typeof rp === "number") price = rp;
      else if (typeof rp === "string") { const n = parseFloat(rp.replace(/[$,]/g, "")); if (!isNaN(n)) price = n; }
      else if (typeof rp === "object" && rp !== null) {
        const inner = (rp as Record<string, unknown>).amount ?? (rp as Record<string, unknown>).price;
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
// Public API
// ---------------------------------------------------------------------------

export async function checkEZLinks(course: CourseConfig, date: string): Promise<TeeTime[]> {
  if (!course.bookingUrl) throw new Error(`${course.name}: bookingUrl required`);

  const base = baseUrl(course.bookingUrl);
  const headers = { ...BROWSER_HEADERS, referer: base + "/" };
  const [year, month, day] = date.split("-");

  // Run HTML/JS discovery once to find the actual API base
  const discovered = await discoverApiBase(base);
  if (discovered) console.log(`[ezlinks] ${course.name}: discovered API base: ${discovered}`);

  // Build candidate URLs — include discovered base + known fallback patterns
  const candidates: string[] = [];
  if (discovered) {
    // If discovered base ends in /api/v1 etc., append tee-time paths
    const db = discovered.replace(/\/$/, "");
    candidates.push(
      `${db}/teesheets?date=${date}&players=1`,
      `${db}/teetimes?date=${date}&players=1`,
      `${db}/teesheets?date=${month}/${day}/${year}&players=1`,
    );
  }
  // Always try the standard known patterns
  candidates.push(
    `${base}/api/v1/teesheets?date=${date}&players=1`,
    `${base}/api/v1/teetimes?date=${date}&players=1`,
    `${base}/api/v1/courses/teesheets?date=${date}&players=1`,
    `${base}/api/v2/teesheets?date=${date}&players=1`,
    `${base}/api/v1/teesheets?date=${month}/${day}/${year}&players=1`,
    `${base}/api/v1/teesheets?startDate=${date}&numberOfPlayers=1`,
    `${base}/api/teesheets?date=${date}&players=1`,
    `${base}/booking/api/v1/teesheets?date=${date}&players=1`,
  );

  const errors: string[] = [];
  for (const url of candidates) {
    try {
      console.log(`[ezlinks] ${course.name}: GET ${url}`);
      const resp = await axios.get(url, { headers, timeout: 10_000 });
      const times = extractTimes(resp.data);
      if (times && times.length > 0) {
        console.log(`[ezlinks] ${course.name}: ✓ ${times.length} slot(s) from ${url}`);
        return times.filter(t => t.players > 0);
      }
      errors.push(`${url.split("?")[0]}: 200 but no times (keys: ${typeof resp.data === "object" ? Object.keys(resp.data ?? {}).join(",") : typeof resp.data})`);
    } catch (err) {
      const e = err instanceof Error ? err.message : String(err);
      errors.push(`${url.split("?")[0]}: ${e}`);
    }
  }

  throw new Error(
    `EZLinks API unreachable for ${course.name}.\n` +
    errors.map(e => `  ${e}`).join("\n")
  );
}
