/**
 * Universal web scraper — works with ANY golf booking page.
 *
 * Strategy:
 *   1. Detect date patterns in the URL and substitute the target date.
 *   2. Launch a headless browser and navigate to the booking page.
 *   3. Intercept every JSON network response and use heuristics to
 *      recognise tee-time data (arrays of objects with time fields).
 *   4. If no API data is captured, fall back to scanning the rendered
 *      DOM for time/price/availability text patterns.
 *
 * This means it works for EZLinks, Play18, Quick18, CourseMarshal,
 * Club Prophet, GolfNow, or any other booking SPA — no per-platform
 * code required.
 */

import puppeteer, { Browser, Page, HTTPResponse } from "puppeteer";
import { CourseConfig, TeeTime } from "../types";

// ---------------------------------------------------------------------------
// Browser lifecycle (reused across checks)
// ---------------------------------------------------------------------------

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser && browser.connected) return browser;

  // Clear any stale PUPPETEER_EXECUTABLE_PATH so Puppeteer uses its own
  // downloaded Chrome from ~/.cache/puppeteer rather than a system path.
  delete process.env.PUPPETEER_EXECUTABLE_PATH;

  browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
      // Suppress the Automation flag that sites use to detect headless Chrome
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--window-size=1280,800",
    ],
  });
  return browser;
}

// ---------------------------------------------------------------------------
// Date substitution — detect the date format in the URL and swap it
// ---------------------------------------------------------------------------

function substituteDate(url: string, targetDate: string): string {
  const [year, month, day] = targetDate.split("-");

  // YYYYMMDD  (e.g. teedate=20260321)
  const yyyymmdd = new RegExp(
    `((?:teedate|date|dt|playdate|play_date|tee_date)[=\\/])\\d{8}`,
    "i"
  );
  if (yyyymmdd.test(url)) {
    return url.replace(yyyymmdd, `$1${year}${month}${day}`);
  }

  // YYYY-MM-DD  (e.g. date=2026-03-21)
  const isoDash = new RegExp(
    `((?:teedate|date|dt|playdate|play_date|tee_date)[=\\/])\\d{4}-\\d{2}-\\d{2}`,
    "i"
  );
  if (isoDash.test(url)) {
    return url.replace(isoDash, `$1${targetDate}`);
  }

  // MM-DD-YYYY or MM/DD/YYYY (URL-encoded slashes = %2F)
  const mdyDash = new RegExp(
    `((?:teedate|date|dt|playdate|play_date|tee_date)[=\\/])\\d{2}[-\\/]\\d{2}[-\\/]\\d{4}`,
    "i"
  );
  if (mdyDash.test(url)) {
    return url.replace(mdyDash, `$1${month}-${day}-${year}`);
  }

  const mdyEncoded = new RegExp(
    `((?:teedate|date|dt|playdate|play_date|tee_date)=)\\d{2}%2F\\d{2}%2F\\d{4}`,
    "i"
  );
  if (mdyEncoded.test(url)) {
    return url.replace(mdyEncoded, `$1${month}%2F${day}%2F${year}`);
  }

  // No date param found — append one as a query param (best-effort).
  // If the URL has a hash fragment (#...) the query param must go BEFORE the
  // hash, otherwise it ends up inside the fragment and the server never sees it.
  const hashIdx = url.indexOf("#");
  if (hashIdx >= 0) {
    const base = url.slice(0, hashIdx);
    const hash = url.slice(hashIdx);
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}date=${targetDate}${hash}`;
  }
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}date=${targetDate}`;
}

// ---------------------------------------------------------------------------
// Heuristic JSON extraction — recognise tee-time objects in any API response
// ---------------------------------------------------------------------------

const TIME_KEYS = [
  "time", "startTime", "start_time", "teeTime", "tee_time",
  "StartTime", "teetime", "start", "slot_time", "teeoff_time",
  "TeeTime", "teeOffTime", "tee_off_time", "displayTime", "formattedTime",
];

const AVAIL_KEYS = [
  "available_spots", "availableSlots", "AvailableSlots", "spots",
  "available", "openSlots", "maxPlayers", "players", "nb_available_spots",
  "remainingSlots", "remaining_slots", "slotsAvailable", "avail",
  "NumberOfPlayersAvailable", "availablePlayers",
];

const PRICE_KEYS = [
  "price", "green_fee", "greenFee", "rate", "baseRate", "BaseRate",
  "amount", "cost", "fee", "displayRate", "pricePerPlayer",
  "GreenFee", "Price", "displayPrice",
];

const HOLES_KEYS = [
  "holes", "numHoles", "num_holes", "numberOfHoles", "number_of_holes",
  "holeCount", "hole_count", "Holes", "NumHoles",
];

function normalizeTime(raw: string): string {
  // "7:00 AM" / "7:00am" → "07:00"
  const ampm = raw.match(/(\d{1,2}):(\d{2})\s*([APap][Mm]?)/);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const m = ampm[2];
    const period = ampm[3].toLowerCase();
    if (period.startsWith("p") && h !== 12) h += 12;
    if (period.startsWith("a") && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${m}`;
  }

  // ISO-8601 or "HH:MM:SS"
  const hhmm = raw.match(/(\d{1,2}):(\d{2})/);
  if (hhmm) {
    return `${hhmm[1].padStart(2, "0")}:${hhmm[2]}`;
  }

  return raw;
}

function pickField<T>(obj: Record<string, unknown>, keys: string[]): T | undefined {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k] as T;
  }
  return undefined;
}

function looksLikeTeeTime(obj: Record<string, unknown>): boolean {
  return !!pickField<string>(obj, TIME_KEYS);
}

/** Recursively find all arrays of objects within a JSON value. */
function findArrays(data: unknown, depth = 0): Array<Record<string, unknown>[]> {
  if (depth > 6) return [];
  const results: Array<Record<string, unknown>[]> = [];

  if (Array.isArray(data)) {
    const objs = data.filter(
      (v) => typeof v === "object" && v !== null && !Array.isArray(v)
    ) as Record<string, unknown>[];
    if (objs.length > 0) results.push(objs);
    for (const item of data) results.push(...findArrays(item, depth + 1));
  } else if (typeof data === "object" && data !== null) {
    for (const val of Object.values(data as Record<string, unknown>)) {
      results.push(...findArrays(val, depth + 1));
    }
  }

  return results;
}

function extractFromJson(data: unknown): TeeTime[] | null {
  const arrays = findArrays(data);

  for (const arr of arrays) {
    // At least 2 items should look like tee times for us to trust it
    const teeTimeCount = arr.filter(looksLikeTeeTime).length;
    if (teeTimeCount < 2) continue;

    const times: TeeTime[] = [];
    for (const item of arr) {
      const rawTime = pickField<string>(item, TIME_KEYS);
      if (!rawTime) continue;

      const avail = pickField<number>(item, AVAIL_KEYS) ?? 4;

      let price: number | undefined;
      const rawPrice = pickField<unknown>(item, PRICE_KEYS);
      if (typeof rawPrice === "number") price = rawPrice;
      else if (typeof rawPrice === "string") {
        const n = parseFloat(rawPrice.replace(/[$,]/g, ""));
        if (!isNaN(n)) price = n;
      } else if (typeof rawPrice === "object" && rawPrice !== null) {
        const inner = (rawPrice as Record<string, unknown>).price ??
                      (rawPrice as Record<string, unknown>).amount;
        if (typeof inner === "number") price = inner;
      }

      const rawHoles = pickField<unknown>(item, HOLES_KEYS);
      const holes = typeof rawHoles === "number" ? rawHoles
        : typeof rawHoles === "string" ? parseInt(rawHoles, 10) || 18
        : 18;

      times.push({
        time: normalizeTime(String(rawTime)),
        players: typeof avail === "number" ? avail : 4,
        holes,
        price,
      });
    }

    if (times.length > 0) return times;
  }

  return null;
}

// ---------------------------------------------------------------------------
// DOM fallback — extract from rendered page text
// ---------------------------------------------------------------------------

async function extractFromDOM(page: Page): Promise<TeeTime[]> {
  // page.evaluate runs in the browser context — we use a string function
  // to avoid TypeScript complaining about DOM types in a Node project.
  const raw = await page.evaluate(`(function() {
    var results = [];
    var seen = {};

    var timeRe = /\\b(\\d{1,2}:\\d{2}\\s*(?:AM|PM|am|pm|a\\.?m\\.?|p\\.?m\\.?)?)\\b/;
    var priceRe = /\\$\\s*(\\d+(?:\\.\\d{2})?)/;
    var availRe = /(\\d+)\\s*(?:spot|player|slot|available|open|avail)/i;
    var holesRe = /\\b(9|18)\\s*-?\\s*hole/i;

    var els = document.querySelectorAll("td, li, div, span, a, p, button");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var text = (el.innerText || "").trim();
      if (!text || text.length > 300) continue;

      var tmatch = text.match(timeRe);
      if (!tmatch) continue;

      var timeStr = tmatch[1].trim();
      if (seen[timeStr]) continue;
      seen[timeStr] = true;

      var parentText = el.parentElement ? (el.parentElement.innerText || "") : text;
      var pmatch = parentText.match(priceRe);
      var amatch = parentText.match(availRe);
      var hmatch = parentText.match(holesRe);

      results.push({
        time: timeStr,
        players: amatch ? parseInt(amatch[1], 10) : 4,
        holes: hmatch ? parseInt(hmatch[1], 10) : 18,
        price: pmatch ? parseFloat(pmatch[1]) : undefined
      });
    }

    return results;
  })()`) as Array<{ time: string; players: number; holes: number; price?: number }>;

  return raw ?? [];
}

// ---------------------------------------------------------------------------
// EZLinks Angular SPA interaction
// ---------------------------------------------------------------------------

/**
 * Drive the EZLinks Angular booking form:
 *   1. Wait for the date input to appear (Angular finish bootstrapping).
 *   2. Clear it and type the target date (Angular Material responds to keyboard
 *      events, not raw value-setting).
 *   3. Click the Search button.
 *   4. Wait for API responses.
 */
async function interactEZLinks(page: Page, date: string): Promise<void> {
  const [year, month, day] = date.split("-");
  const mdyDate = `${month}/${day}/${year}`; // MM/DD/YYYY for Angular datepicker

  // Wait up to 12 s for the Angular app to render the date input
  const inputSelectors = [
    "input[id*='date' i]",
    "input[name*='date' i]",
    "input[placeholder*='date' i]",
    "input[formcontrolname*='date' i]",
    "input[type='date']",
    "input[type='text']",
  ];

  let filled = false;
  for (const sel of inputSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 12_000 });
      // Triple-click to select all existing text, then type the new date.
      // This generates real keyboard events that Angular's change detection sees.
      await page.click(sel, { clickCount: 3 });
      await page.keyboard.down("Control");
      await page.keyboard.press("a");
      await page.keyboard.up("Control");
      await page.type(sel, mdyDate, { delay: 40 });
      await page.keyboard.press("Tab"); // blur to trigger Angular validation
      filled = true;
      console.log(`[web] EZLinks: filled date ${mdyDate} via ${sel}`);
      break;
    } catch {
      // selector not found — try next
    }
  }

  if (!filled) {
    console.warn("[web] EZLinks: could not find date input — proceeding without form fill");
  }

  // Click Search (try several selector patterns Angular might use)
  const btnSelectors = [
    "button[type='submit']",
    "input[type='submit']",
    "button.search-btn",
    "button.btn-search",
    "button.btn-primary",
    "button[class*='search' i]",
    "button[id*='search' i]",
  ];
  for (const sel of btnSelectors) {
    const btn = await page.$(sel);
    if (btn) {
      await btn.click();
      console.log(`[web] EZLinks: clicked search via ${sel}`);
      break;
    }
  }

  // Wait up to 10 s for API responses to arrive
  await new Promise((r) => setTimeout(r, 10_000));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function checkWebScraper(
  course: CourseConfig,
  date: string // YYYY-MM-DD
): Promise<TeeTime[]> {
  if (!course.bookingUrl) {
    throw new Error(`${course.name}: bookingUrl is required for web scraping`);
  }

  const targetUrl = substituteDate(course.bookingUrl, date);
  console.log(`[web] ${course.name}: loading ${targetUrl}`);

  const b = await getBrowser();
  const page = await b.newPage();

  // Mask automation signals that sites use to block headless browsers
  await page.evaluateOnNewDocument(`
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
  `);
  await page.setViewport({ width: 1280, height: 800 });
  await page.setExtraHTTPHeaders({
    "accept-language": "en-US,en;q=0.9",
  });

  // Reduce resource loading for speed
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const rt = req.resourceType();
    if (["image", "font", "media"].includes(rt)) {
      req.abort();
    } else if (targetUrl.includes("teeitup.com")) {
      // The TeeItUp SPA ignores URL params; inject the correct date AND
      // holes=18 directly into every API call it makes.
      const reqUrl = req.url();
      if (reqUrl.includes("/api/")) {
        let newUrl = reqUrl;
        // Fix date — replace whatever date the SPA sent with our target date
        const dateRe = /([?&]date=)\d{4}-\d{2}-\d{2}/;
        if (dateRe.test(newUrl)) {
          newUrl = newUrl.replace(dateRe, `$1${date}`);
        } else {
          newUrl += (newUrl.includes("?") ? "&" : "?") + `date=${date}`;
        }
        // Ensure 18-hole filter
        if (!newUrl.includes("holes=")) {
          newUrl += `&holes=18`;
        }
        req.continue({ url: newUrl });
      } else {
        req.continue();
      }
    } else {
      req.continue();
    }
  });

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );

  const intercepted: TeeTime[][] = [];

  // Listen for JSON responses that look like tee time data
  page.on("response", async (response: HTTPResponse) => {
    try {
      const ct = response.headers()["content-type"] ?? "";
      if (!ct.includes("json")) return;
      const json: unknown = await response.json();
      const times = extractFromJson(json);
      if (times && times.length > 0) {
        console.log(
          `[web] ${course.name}: intercepted ${times.length} slot(s) from ${response.url().slice(0, 80)}`
        );
        intercepted.push(times);
      }
    } catch {
      // not JSON, ignore
    }
  });

  try {
    // Retry navigation on transient connection errors (e.g. server reset)
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 30_000 });
        break;
      } catch (navErr) {
        const msg = navErr instanceof Error ? navErr.message : String(navErr);
        const isConnectionError = msg.includes("ERR_CONNECTION") ||
          msg.includes("Connection closed") || msg.includes("ECONNRESET");
        if (!isConnectionError || attempt === maxAttempts) throw navErr;
        console.warn(`[web] ${course.name}: connection error (attempt ${attempt}/${maxAttempts}), retrying…`);
        await new Promise((r) => setTimeout(r, 2_000 * attempt));
      }
    }

    // EZLinks SPA (#/search) is an Angular app that requires filling in the
    // date picker and clicking Search before tee-time API calls fire.
    if (targetUrl.includes("ezlinksgolf.com")) {
      await interactEZLinks(page, date);
    } else {
      // Give SPAs a moment to finish rendering
      await new Promise((r) => setTimeout(r, 2_000));
    }

    // Return the best intercepted result (prefer the largest set)
    if (intercepted.length > 0) {
      intercepted.sort((a, b) => b.length - a.length);
      return intercepted[0].filter((t) => t.players > 0);
    }

    // Fallback: scrape the rendered DOM
    console.log(`[web] ${course.name}: no API intercepted, falling back to DOM scraping`);
    const domTimes = await extractFromDOM(page);
    return domTimes.map((t) => ({
      ...t,
      time: normalizeTime(t.time),
    }));
  } finally {
    await page.close();
  }
}

/** Shut down the shared browser (call on process exit). */
export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}
