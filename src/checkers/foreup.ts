/**
 * ForeUp Software tee time checker
 *
 * Tries the direct API first. If that returns 401/403 (auth changed),
 * falls back to loading the booking page in Chrome and intercepting
 * the JSON responses — letting ForeUp's own JS handle auth.
 */

import axios from "axios";
import { CourseConfig, TeeTime } from "../types";
import { checkWebScraper } from "./web-scraper";

const BASE_URL = "https://foreupsoftware.com/index.php/api/booking/times";

interface ForeUpSlot {
  time: string;          // "07:00" or "7:00 AM" depending on installation
  available_spots: number;
  holes: number;
  green_fee?: string;
  booking_url?: string;
  [key: string]: unknown;
}

/** Normalize any time format to "HH:MM" (24-hour) for consistent comparisons. */
function parseTime(raw: string): string {
  const ampm = raw.match(/(\d{1,2}):(\d{2})\s*([APap][Mm])/);
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

export async function checkForeUp(
  course: CourseConfig,
  date: string            // YYYY-MM-DD
): Promise<TeeTime[]> {
  if (!course.foreupScheduleId) {
    throw new Error(`${course.name}: foreupScheduleId is required`);
  }

  // Try direct API first
  try {
    return await checkForeUpApi(course, date);
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 401 || status === 403) {
      console.log(`[foreup] ${course.name}: API returned ${status}, falling back to web scraper`);
      if (course.bookingUrl) {
        return checkWebScraper(course, date);
      }
    }
    throw err;
  }
}

async function checkForeUpApi(
  course: CourseConfig,
  date: string
): Promise<TeeTime[]> {
  // ForeUp expects date as MM-DD-YYYY
  const [year, month, day] = date.split("-");
  const foreupDate = `${month}-${day}-${year}`;

  const params: Record<string, string> = {
    time: "all",
    date: foreupDate,
    players: "1",
    specials_only: "0",
    api_key: "no_limits",
    schedule_id: course.foreupScheduleId!,
    "schedule_ids[]": course.foreupScheduleId!,
  };

  // Only filter by holes at the API level if the course requires 18-hole rounds.
  // Omitting the param returns all hole counts (9 and 18); minHoles filtering
  // in checker.ts handles any post-fetch restriction.
  if (course.minHoles) {
    params.holes = String(course.minHoles);
  }

  if (course.foreupBookingClass) {
    params.booking_class = course.foreupBookingClass;
  }

  const response = await axios.get<ForeUpSlot[]>(BASE_URL, {
    params,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "X-Authorization": `Bearer no_limits`,
      "Referer": `https://foreupsoftware.com/index.php/booking/${course.foreupScheduleId}/${course.foreupBookingClass ?? ""}`,
      "Origin": "https://foreupsoftware.com",
    },
    timeout: 15_000,
  });

  const slots: ForeUpSlot[] = Array.isArray(response.data) ? response.data : [];

  return slots
    .filter((slot) => slot.available_spots > 0)
    .map((slot) => ({
      time: parseTime(slot.time),
      players: slot.available_spots,
      holes: slot.holes ?? 18,
      price: slot.green_fee ? parseFloat(slot.green_fee) : undefined,
      bookingUrl: slot.booking_url,
    }));
}
