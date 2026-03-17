/**
 * Chronogolf / Lightspeed Golf tee time checker
 *
 * How to find your club ID:
 *   1. Go to your course's online booking page
 *   2. If it's powered by Chronogolf/Lightspeed Golf, the URL will contain
 *      something like: chronogolf.com/club/robinson-ranch  or  golf.lightspeedhq.com/...
 *   3. The slug after /club/ is your chronogolfClubId
 *      e.g. "robinson-ranch" or a numeric ID like "1234"
 *
 * Examples of courses using Chronogolf/Lightspeed:
 *   - Robinson Ranch Golf Course (Santa Clarita, CA)
 *   - Vista Valencia Golf Course (Valencia, CA)
 *   - Angeles National Golf Club (Sunland, CA)
 */

import axios from "axios";
import { CourseConfig, TeeTime } from "../types";

// Chronogolf uses two API domains depending on when the club signed up
const CHRONO_BASE = "https://www.chronogolf.com/club";
const LS_BASE = "https://golf.lightspeedhq.com/api/v2/clubs";

interface ChronoSlot {
  id?: string | number;
  start_time?: string;      // "07:00:00" or "2026-03-17T07:00:00"
  startTime?: string;
  nb_available_spots?: number;
  available_spots?: number;
  holes?: number;
  price?: number;
  green_fee?: number;
  booking_url?: string;
  bookingUrl?: string;
  [key: string]: unknown;
}

interface ChronoResponse {
  data?: ChronoSlot[];
  teetimes?: ChronoSlot[];
  teeTimes?: ChronoSlot[];
  [key: string]: unknown;
}

function normalizeTime(raw: string): string {
  // Handle "HH:MM:SS" and ISO-8601
  if (/^\d{2}:\d{2}/.test(raw)) return raw.slice(0, 5);
  const d = new Date(raw);
  if (!isNaN(d.getTime())) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  return raw;
}

function parseSlots(raw: ChronoSlot[]): TeeTime[] {
  return raw
    .filter((s) => {
      const spots = s.nb_available_spots ?? s.available_spots ?? 0;
      return spots > 0;
    })
    .map((s) => {
      const timeRaw = s.start_time ?? s.startTime ?? "";
      return {
        time: normalizeTime(timeRaw),
        players: s.nb_available_spots ?? s.available_spots ?? 1,
        holes: s.holes ?? 18,
        price: s.price ?? s.green_fee,
        bookingUrl: s.booking_url ?? s.bookingUrl,
      };
    });
}

async function tryChronogolf(clubId: string, date: string): Promise<TeeTime[]> {
  const url = `${CHRONO_BASE}/${clubId}/teetimes`;
  const resp = await axios.get<ChronoResponse>(url, {
    params: {
      date,
      nb_holes: 18,
      nb_players: 1,
      nb_juniors: 0,
      nb_seniors: 0,
    },
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; TeeTimeBot/1.0)",
    },
    timeout: 15_000,
  });

  const slots: ChronoSlot[] =
    resp.data?.data ?? resp.data?.teetimes ?? resp.data?.teeTimes ?? [];
  return parseSlots(Array.isArray(slots) ? slots : []);
}

async function tryLightspeed(clubId: string, date: string): Promise<TeeTime[]> {
  const url = `${LS_BASE}/${clubId}/teetimes`;
  const resp = await axios.get<ChronoResponse>(url, {
    params: {
      date,
      nb_holes: 18,
      nb_players: 1,
    },
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; TeeTimeBot/1.0)",
    },
    timeout: 15_000,
  });

  const slots: ChronoSlot[] =
    resp.data?.data ?? resp.data?.teetimes ?? resp.data?.teeTimes ?? [];
  return parseSlots(Array.isArray(slots) ? slots : []);
}

export async function checkChronogolf(
  course: CourseConfig,
  date: string          // YYYY-MM-DD
): Promise<TeeTime[]> {
  if (!course.chronogolfClubId) {
    throw new Error(`${course.name}: chronogolfClubId is required`);
  }

  // Try the classic Chronogolf endpoint first, fall back to Lightspeed Golf
  try {
    const results = await tryChronogolf(course.chronogolfClubId, date);
    if (results.length > 0) return results;
  } catch {
    // fall through
  }

  try {
    return await tryLightspeed(course.chronogolfClubId, date);
  } catch {
    return [];
  }
}
