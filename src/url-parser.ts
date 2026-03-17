/**
 * Parses a golf booking page URL and extracts platform + course IDs.
 * Supports ForeUp, TeeSnap, and Chronogolf/Lightspeed Golf URL formats.
 */

import axios from "axios";
import { CourseConfig, Platform } from "./types";

// ---------------------------------------------------------------------------
// Per-platform parsers
// ---------------------------------------------------------------------------

// ForeUp: https://foreupsoftware.com/index.php/booking/21903/9285#teetimes
//         https://someclub.book.teeitup.golf/index.php/booking/21903/9285
function parseForeUp(url: URL): Partial<CourseConfig> | null {
  const parts = url.pathname.split("/").filter(Boolean);
  const bookingIdx = parts.indexOf("booking");
  if (bookingIdx === -1) return null;
  const scheduleId = parts[bookingIdx + 1];
  const bookingClass = parts[bookingIdx + 2];
  if (!scheduleId || !/^\d+$/.test(scheduleId)) return null;
  return {
    platform: "foreup",
    foreupScheduleId: scheduleId,
    ...(bookingClass && /^\d+$/.test(bookingClass) ? { foreupBookingClass: bookingClass } : {}),
    bookingUrl: url.toString(),
  };
}

// TeeSnap: https://somecourse.teesnap.net/?courseId=12345
function parseTeeSnap(url: URL): Partial<CourseConfig> | null {
  const courseId =
    url.searchParams.get("courseId") ||
    url.searchParams.get("courseid") ||
    url.pathname.split("/").find((p) => /^\d{4,}$/.test(p));
  if (!courseId) return null;
  return { platform: "teesnap", tesnapCourseId: courseId, bookingUrl: url.toString() };
}

// Chronogolf: https://www.chronogolf.com/club/robinson-ranch/widget
//             https://golf.lightspeedhq.com/clubs/1234/tee-times
function parseChronogolf(url: URL): Partial<CourseConfig> | null {
  const host = url.hostname.toLowerCase();

  if (host.includes("chronogolf")) {
    // /club/{slug}/...
    const parts = url.pathname.split("/").filter(Boolean);
    const clubIdx = parts.indexOf("club");
    const clubId = clubIdx !== -1 ? parts[clubIdx + 1] : null;
    if (!clubId) return null;
    return { platform: "chronogolf", chronogolfClubId: clubId, bookingUrl: url.toString() };
  }

  if (host.includes("lightspeedhq") || host.includes("lightspeedgolf")) {
    const parts = url.pathname.split("/").filter(Boolean);
    const clubsIdx = parts.indexOf("clubs");
    const clubId = clubsIdx !== -1 ? parts[clubsIdx + 1] : null;
    if (!clubId) return null;
    return { platform: "chronogolf", chronogolfClubId: clubId, bookingUrl: url.toString() };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface ParsedCourse {
  partial: Partial<CourseConfig>;
  platform: Platform;
  suggestedName: string;
}

export async function parseBookingUrl(raw: string): Promise<ParsedCourse | null> {
  const withScheme = raw.startsWith("http") ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  let partial: Partial<CourseConfig> | null = null;

  if (host.includes("foreupsoftware") || host.includes("teeitup")) {
    partial = parseForeUp(url);
  } else if (host.includes("teesnap")) {
    partial = parseTeeSnap(url);
  } else if (host.includes("chronogolf") || host.includes("lightspeedhq") || host.includes("lightspeedgolf")) {
    partial = parseChronogolf(url);
  }

  if (!partial || !partial.platform) return null;

  const suggestedName = await tryFetchCourseName(partial);
  return { partial, platform: partial.platform, suggestedName };
}

// ---------------------------------------------------------------------------
// Fetch a human-readable course name from the platform API
// ---------------------------------------------------------------------------

interface ForeUpFacility {
  name?: string;
  facility_name?: string;
  course_name?: string;
}

async function tryFetchCourseName(partial: Partial<CourseConfig>): Promise<string> {
  try {
    if (partial.platform === "foreup" && partial.foreupScheduleId) {
      const resp = await axios.get<ForeUpFacility>(
        `https://foreupsoftware.com/index.php/api/booking/${partial.foreupScheduleId}/facility`,
        { timeout: 8_000 }
      );
      const name = resp.data?.name || resp.data?.facility_name || resp.data?.course_name;
      if (name) return name as string;
    }
  } catch {
    // ignore
  }

  if (partial.platform === "foreup")
    return `Course (ForeUp #${partial.foreupScheduleId})`;
  if (partial.platform === "teesnap")
    return `Course (TeeSnap #${partial.tesnapCourseId})`;
  if (partial.platform === "chronogolf")
    return `Course (Chronogolf: ${partial.chronogolfClubId})`;
  return "Golf Course";
}
