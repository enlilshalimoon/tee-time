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

  // Fallback: any URL we don't specifically recognise → "web" platform
  // The universal scraper will load it in a headless browser and
  // intercept API calls / scrape the DOM.
  if (!partial || !partial.platform) {
    partial = { platform: "web", bookingUrl: url.toString() };
  }

  const suggestedName = await tryFetchCourseName(partial, url);
  return { partial, platform: partial.platform!, suggestedName };
}

// ---------------------------------------------------------------------------
// Fetch a human-readable course name from the platform API
// ---------------------------------------------------------------------------

async function tryFetchCourseName(
  partial: Partial<CourseConfig>,
  url?: URL
): Promise<string> {
  try {
    if (partial.platform === "foreup" && partial.foreupScheduleId) {
      const pageUrl = `https://foreupsoftware.com/index.php/booking/${partial.foreupScheduleId}/${partial.foreupBookingClass ?? ""}`;
      const name = await fetchTitleFromPage(pageUrl);
      if (name) return name;
    }

    if (partial.platform === "teesnap" && partial.tesnapCourseId) {
      const resp = await axios.get<{ name?: string; courseName?: string }>(
        `https://api.teesnap.net/v1/courses/${partial.tesnapCourseId}`,
        { timeout: 8_000, headers: { Accept: "application/json" } }
      );
      const name = resp.data?.name || resp.data?.courseName;
      if (name) return name;
    }

    if (partial.platform === "chronogolf" && partial.chronogolfClubId) {
      const slug = partial.chronogolfClubId;
      const nice = slug.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      if (nice) return nice;
    }

    if (partial.platform === "web" && partial.bookingUrl) {
      // Try to get the course name from the page <title>
      const name = await fetchTitleFromPage(partial.bookingUrl);
      if (name) return name;

      // Fall back to deriving a name from the subdomain
      // e.g. "losrobles.ezlinksgolf.com" → "Los Robles"
      // e.g. "moorpark.play18.com" → "Moorpark"
      if (url) {
        const sub = url.hostname.split(".")[0];
        if (sub && sub !== "www" && sub !== "api") {
          const nice = sub
            .replace(/[-_]/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase());
          if (nice.length > 2) return nice;
        }
      }
    }
  } catch {
    // ignore — bot will ask the user
  }

  return ""; // empty = bot should prompt the user for a name
}

/** Fetch a URL's <title> tag and clean it up for use as a course name. */
async function fetchTitleFromPage(pageUrl: string): Promise<string> {
  try {
    const resp = await axios.get<string>(pageUrl, {
      timeout: 10_000,
      headers: { "User-Agent": "Mozilla/5.0" },
      // Only read the first 50KB — we just need the <head>
      maxContentLength: 50_000,
    });
    const titleMatch = resp.data.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
      let name = titleMatch[1].trim();
      // Strip common suffixes
      name = name
        .replace(/\s*[-–|:]\s*(ForeUp|Book Tee Times?|Online Booking|GolfNow|EZLinks|Play18|Reserve|Search).*/i, "")
        .trim();
      if (name && name.length > 2 && name.length < 80) return name;
    }
  } catch {
    // ignore
  }
  return "";
}
