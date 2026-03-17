/**
 * TeeSnap tee time checker
 *
 * How to find your courseId:
 *   1. Go to your course's TeeSnap booking page
 *      (usually embedded at https://<coursename>.teesnap.net or their website)
 *   2. Open browser DevTools → Network tab
 *   3. Trigger a date/player search
 *   4. Look for requests to api.teesnap.net — the courseId will be in the URL
 *      e.g. /v1/courses/12345/teetimes
 */

import axios from "axios";
import { CourseConfig, TeeTime } from "../types";

const BASE_URL = "https://api.teesnap.net";

interface TeeSnapSlot {
  startTime: string;          // ISO-8601 or "2026-03-17T07:00:00"
  maxPlayers: number;
  availableSlots: number;
  holes: number;
  rate?: { price: number };
  webUrl?: string;
  [key: string]: unknown;
}

interface TeeSnapResponse {
  teeTimes?: TeeSnapSlot[];
  [key: string]: unknown;
}

export async function checkTeeSnap(
  course: CourseConfig,
  date: string           // YYYY-MM-DD
): Promise<TeeTime[]> {
  if (!course.tesnapCourseId) {
    throw new Error(`${course.name}: tesnapCourseId is required`);
  }

  const url = `${BASE_URL}/v1/courses/${course.tesnapCourseId}/teetimes`;

  const response = await axios.get<TeeSnapResponse>(url, {
    params: {
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

  const slots: TeeSnapSlot[] = response.data?.teeTimes ?? [];

  return slots
    .filter((slot) => slot.availableSlots > 0)
    .map((slot) => {
      // Normalize time to HH:MM
      const d = new Date(slot.startTime);
      const time = isNaN(d.getTime())
        ? slot.startTime
        : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

      return {
        time,
        players: slot.availableSlots,
        holes: slot.holes ?? 18,
        price: slot.rate?.price,
        bookingUrl: slot.webUrl,
      };
    });
}
