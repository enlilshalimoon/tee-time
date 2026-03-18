/**
 * TeeItUp / Kenna tee time checker
 *
 * TeeItUp booking pages (book.teeitup.com) are Angular SPAs backed by the
 * Kenna Phoenix API at phx-api-be-east-1b.kenna.io.  Headless Chrome gets
 * rejected at the TLS level (Cloudflare JA3 fingerprint detection), so we
 * call the JSON API directly with axios.
 *
 * Everything needed is encoded in the bookingUrl:
 *   https://{alias}.book.teeitup.com/teetimes?course={facilityId}&...
 *   alias      → x-be-alias request header
 *   facilityId → facility_id query param
 */

import axios, { AxiosError } from "axios";
import { CourseConfig, TeeTime } from "../types";

const KENNA_BASE = "https://phx-api-be-east-1b.kenna.io";

// Ordered list of candidate paths to try if the first one fails.
const CANDIDATE_PATHS = [
  "/v1/tee-times",
  "/tee-times",
  "/tee_times",
  "/v1/tee_times",
  "/api/tee-times",
  "/api/v1/tee-times",
];

// Cache the first path that works so we don't probe on every call.
let workingPath: string | null = null;

interface KennaSlot {
  time?: string;
  start_time?: string;
  startTime?: string;
  available_spots?: number;
  availableSpots?: number;
  holes?: number;
  green_fee?: number;
  greenFee?: number;
  rate?: number;
  price?: number;
  booking_url?: string;
  [key: string]: unknown;
}

function parseTime(raw: string): string {
  // "7:30 AM" / "7:30am" → "07:30"
  const ampm = raw.match(/(\d{1,2}):(\d{2})\s*([APap][Mm]?)/);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const m = ampm[2];
    if (ampm[3].toLowerCase().startsWith("p") && h !== 12) h += 12;
    if (ampm[3].toLowerCase().startsWith("a") && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${m}`;
  }
  // "HH:MM" or ISO
  const hhmm = raw.match(/(\d{1,2}):(\d{2})/);
  if (hhmm) return `${hhmm[1].padStart(2, "0")}:${hhmm[2]}`;
  return raw;
}

function parseSlots(data: unknown): TeeTime[] {
  const arr: KennaSlot[] = Array.isArray(data)
    ? (data as KennaSlot[])
    : Array.isArray((data as { data?: unknown })?.data)
      ? ((data as { data: KennaSlot[] }).data)
      : [];

  return arr
    .filter((s) => {
      const spots = s.available_spots ?? s.availableSpots ?? 0;
      return spots > 0;
    })
    .map((s) => {
      const rawTime = s.time ?? s.start_time ?? s.startTime ?? "";
      const price = s.green_fee ?? s.greenFee ?? s.rate ?? s.price;
      return {
        time: parseTime(rawTime),
        players: s.available_spots ?? s.availableSpots ?? 4,
        holes: s.holes ?? 18,
        price: typeof price === "number" ? price : undefined,
        bookingUrl: typeof s.booking_url === "string" ? s.booking_url : undefined,
      };
    });
}

async function probePath(
  path: string,
  facilityId: string,
  alias: string,
  date: string,
  bookingUrl: string
): Promise<unknown> {
  const resp = await axios.get(`${KENNA_BASE}${path}`, {
    params: {
      facility_id: facilityId,
      date,
      holes: 18,
      players: 1,
    },
    headers: {
      "x-be-alias": alias,
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Referer: bookingUrl,
      Origin: `https://${alias}.book.teeitup.com`,
    },
    timeout: 15_000,
  });
  return resp.data;
}

export async function checkTeeItUp(
  course: CourseConfig,
  date: string // YYYY-MM-DD
): Promise<TeeTime[]> {
  if (!course.bookingUrl) {
    throw new Error(`${course.name}: bookingUrl is required for TeeItUp`);
  }

  // Extract facility ID and alias from the booking URL
  const url = new URL(course.bookingUrl);
  const facilityId = url.searchParams.get("course");
  if (!facilityId) {
    throw new Error(`${course.name}: could not find ?course= in bookingUrl`);
  }
  // e.g. "los-verdes-golf-course-public" from "los-verdes-golf-course-public.book.teeitup.com"
  const alias = url.hostname.split(".")[0];

  // If we already found a working path, use it directly.
  if (workingPath) {
    console.log(`[teeitup] ${course.name}: ${KENNA_BASE}${workingPath} facility_id=${facilityId} date=${date}`);
    const data = await probePath(workingPath, facilityId, alias, date, course.bookingUrl);
    const slots = parseSlots(data);
    console.log(`[teeitup] ${course.name}: ${slots.length} slot(s) on ${date}`);
    return slots;
  }

  // Probe candidate paths until one responds with non-404.
  console.log(`[teeitup] ${course.name}: probing API paths for facility_id=${facilityId} alias=${alias}`);
  const errors: string[] = [];
  for (const path of CANDIDATE_PATHS) {
    try {
      console.log(`[teeitup] trying ${KENNA_BASE}${path}`);
      const data = await probePath(path, facilityId, alias, date, course.bookingUrl);
      workingPath = path;
      console.log(`[teeitup] found working path: ${path}`);
      const slots = parseSlots(data);
      console.log(`[teeitup] ${course.name}: ${slots.length} slot(s) on ${date}`);
      return slots;
    } catch (err) {
      const status = (err as AxiosError)?.response?.status;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`  ${path} → ${status ?? msg}`);
      // Only skip to next path on 404; other errors (403, 5xx, network) should surface
      if (status !== 404) {
        throw new Error(
          `Kenna API ${path} returned ${status ?? "error"}: ${msg}\nTried paths:\n${errors.join("\n")}`
        );
      }
    }
  }

  throw new Error(
    `Kenna API: all candidate paths returned 404.\nTried:\n${errors.join("\n")}\n` +
    `Please capture the XHR request from browser DevTools on ${course.bookingUrl} and share the API URL.`
  );
}
