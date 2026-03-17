/**
 * ForeUp Software tee time checker
 *
 * How to find your schedule_id and booking_class:
 *   1. Go to your course's ForeUp booking page (often at
 *      https://<coursename>.book.teeitup.golf or a similar URL)
 *   2. Open browser DevTools → Network tab
 *   3. Trigger a date/player search
 *   4. Look for a request to foreupsoftware.com/index.php/api/booking/times
 *      The query string will contain schedule_id and booking_class
 */

import axios from "axios";
import { CourseConfig, TeeTime } from "../types";

const BASE_URL = "https://foreupsoftware.com/index.php/api/booking/times";

interface ForeUpSlot {
  time: string;          // "07:00"
  available_spots: number;
  holes: number;
  green_fee?: string;
  booking_url?: string;
  [key: string]: unknown;
}

export async function checkForeUp(
  course: CourseConfig,
  date: string            // YYYY-MM-DD
): Promise<TeeTime[]> {
  if (!course.foreupScheduleId) {
    throw new Error(`${course.name}: foreupScheduleId is required`);
  }

  // ForeUp expects date as MM-DD-YYYY
  const [year, month, day] = date.split("-");
  const foreupDate = `${month}-${day}-${year}`;

  const params: Record<string, string> = {
    time: "all",
    date: foreupDate,
    holes: "18",
    players: "1",
    specials_only: "0",
    api_key: "no_limits",
    schedule_id: course.foreupScheduleId,
    "schedule_ids[]": course.foreupScheduleId,
  };

  if (course.foreupBookingClass) {
    params.booking_class = course.foreupBookingClass;
  }

  const response = await axios.get<ForeUpSlot[]>(BASE_URL, {
    params,
    headers: {
      "X-Authorization": `Bearer no_limits`,
      "Referer": "https://foreupsoftware.com/",
    },
    timeout: 15_000,
  });

  const slots: ForeUpSlot[] = Array.isArray(response.data) ? response.data : [];

  return slots
    .filter((slot) => slot.available_spots > 0)
    .map((slot) => ({
      time: slot.time,
      players: slot.available_spots,
      holes: slot.holes ?? 18,
      price: slot.green_fee ? parseFloat(slot.green_fee) : undefined,
      bookingUrl: slot.booking_url,
    }));
}
