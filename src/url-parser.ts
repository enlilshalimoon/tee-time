/**
 * Parses a golf booking page URL and extracts platform + course IDs.
 * Supports ForeUp, TeeSnap, and EZLinks/GolfNow URL formats.
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
  // ['index.php', 'booking', '21903', '9285']
  const bookingIdx = parts.indexOf("booking");
  if (bookingIdx === -1) return null;
  const scheduleId = parts[bookingIdx + 1];
  const bookingClass = parts[bookingIdx + 2];
  if (!scheduleId || !/^\d+$/.test(scheduleId)) return null;
  return {
    platform: "foreup",
    foreupScheduleId: scheduleId,
    ...(bookingClass && /^\d+$/.test(bookingClass) ? { foreupBookingClass: bookingClass } : {}),
  };
}

// TeeSnap: https://somecourse.teesnap.net/?courseId=12345
function parseTeeSnap(url: URL): Partial<CourseConfig> | null {
  const courseId =
    url.searchParams.get("courseId") ||
    url.searchParams.get("courseid") ||
    url.pathname.split("/").find((p) => /^\d{4,}$/.test(p));
  if (!courseId) return null;
  return { platform: "teesnap", tesnapCourseId: courseId };
}

// EZLinks: https://www.ezlinksgolf.com/index.html#/search?fc=67890
function parseEZLinks(url: URL): Partial<CourseConfig> | null {
  // EZLinks puts params in the hash fragment
  const hashQuery = url.hash.includes("?") ? url.hash.split("?")[1] : "";
  const hashParams = new URLSearchParams(hashQuery);
  const facilityId =
    hashParams.get("fc") ||
    url.searchParams.get("facilityId") ||
    url.searchParams.get("fc");
  if (!facilityId) return null;
  return {
    platform: "ezlinks",
    ezlinksFacilityId: facilityId,
    ezlinksBookingUrl: url.toString(),
  };
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
  // Ensure scheme present so URL constructor works
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
  } else if (host.includes("ezlinks") || host.includes("golfnow")) {
    partial = parseEZLinks(url);
  }

  if (!partial || !partial.platform) return null;

  const suggestedName = await tryFetchCourseName(partial);

  return {
    partial,
    platform: partial.platform,
    suggestedName,
  };
}

// ---------------------------------------------------------------------------
// Try to get a human-readable course name from the platform API
// ---------------------------------------------------------------------------

interface ForeUpFacility {
  name?: string;
  facility_name?: string;
  course_name?: string;
}

async function tryFetchCourseName(partial: Partial<CourseConfig>): Promise<string> {
  try {
    if (partial.platform === "foreup" && partial.foreupScheduleId) {
      // ForeUp facility endpoint
      const resp = await axios.get<ForeUpFacility>(
        `https://foreupsoftware.com/index.php/api/booking/${partial.foreupScheduleId}/facility`,
        { timeout: 8_000 }
      );
      const name =
        resp.data?.name ||
        resp.data?.facility_name ||
        resp.data?.course_name;
      if (name) return name as string;
    }
  } catch {
    // ignore — fall through to generic name
  }

  // Fallback generic names
  if (partial.platform === "foreup")
    return `Course (ForeUp #${partial.foreupScheduleId})`;
  if (partial.platform === "teesnap")
    return `Course (TeeSnap #${partial.tesnapCourseId})`;
  if (partial.platform === "ezlinks")
    return `Course (EZLinks #${partial.ezlinksFacilityId})`;
  return "Golf Course";
}
