/**
 * EZLinks Golf tee time checker
 *
 * How to find your facilityId:
 *   1. Go to your course's EZLinks / GolfNow booking page
 *   2. Open browser DevTools → Network tab
 *   3. Search for tee times
 *   4. Look for requests to either:
 *        - www.ezlinksgolf.com/api/  (older EZLinks)
 *        - api.golfnow.com/          (if converted to GolfNow)
 *      The facilityId will appear in the URL or query params
 *
 * NOTE: EZLinks was largely acquired by NBC / GolfNow. Some courses still run
 * the legacy EZLinks stack while others migrated to GolfNow's API. Both
 * endpoints are attempted below.
 */

import axios from "axios";
import { CourseConfig, TeeTime } from "../types";

const EZLINKS_BASE = "https://www.ezlinksgolf.com/api/search/search";
const GOLFNOW_BASE = "https://api.golfnow.com/v1/teetimes";

interface EZLinksSlot {
  StartTime: string;        // "2026-03-17T07:00:00"
  MaxPlayers: number;
  AvailableSlots: number;
  Holes: number;
  BaseRate?: number;
  BookingUrl?: string;
  [key: string]: unknown;
}

interface EZLinksResponse {
  TeeTimes?: EZLinksSlot[];
  Results?: EZLinksSlot[];
  [key: string]: unknown;
}

interface GolfNowSlot {
  time: string;
  availableSlots: number;
  holes: number;
  rateId?: number;
  bookingUrl?: string;
  [key: string]: unknown;
}

interface GolfNowResponse {
  teetimes?: GolfNowSlot[];
  [key: string]: unknown;
}

function normalizeTime(isoString: string): string {
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return isoString;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

async function tryEZLinksLegacy(
  course: CourseConfig,
  date: string
): Promise<TeeTime[]> {
  const response = await axios.get<EZLinksResponse>(EZLINKS_BASE, {
    params: {
      facilityId: course.ezlinksFacilityId,
      date,
      players: 1,
      holes: 18,
    },
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; TeeTimeBot/1.0)",
      Referer: course.ezlinksBookingUrl ?? "https://www.ezlinksgolf.com/",
    },
    timeout: 15_000,
  });

  const slots: EZLinksSlot[] = response.data?.TeeTimes ?? response.data?.Results ?? [];

  return slots
    .filter((s) => (s.AvailableSlots ?? 0) > 0)
    .map((s) => ({
      time: normalizeTime(s.StartTime),
      players: s.AvailableSlots,
      holes: s.Holes ?? 18,
      price: s.BaseRate,
      bookingUrl: s.BookingUrl,
    }));
}

async function tryGolfNow(
  course: CourseConfig,
  date: string
): Promise<TeeTime[]> {
  const response = await axios.get<GolfNowResponse>(GOLFNOW_BASE, {
    params: {
      facilityId: course.ezlinksFacilityId,
      date,
      players: 1,
      holes: 18,
    },
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; TeeTimeBot/1.0)",
    },
    timeout: 15_000,
  });

  const slots: GolfNowSlot[] = response.data?.teetimes ?? [];

  return slots
    .filter((s) => (s.availableSlots ?? 0) > 0)
    .map((s) => ({
      time: normalizeTime(s.time),
      players: s.availableSlots,
      holes: s.holes ?? 18,
      bookingUrl: s.bookingUrl,
    }));
}

export async function checkEZLinks(
  course: CourseConfig,
  date: string           // YYYY-MM-DD
): Promise<TeeTime[]> {
  if (!course.ezlinksFacilityId) {
    throw new Error(`${course.name}: ezlinksFacilityId is required`);
  }

  // Try legacy EZLinks first; fall back to GolfNow endpoint
  try {
    const results = await tryEZLinksLegacy(course, date);
    if (results.length > 0) return results;
  } catch {
    // fall through to GolfNow
  }

  try {
    return await tryGolfNow(course, date);
  } catch {
    return [];
  }
}
