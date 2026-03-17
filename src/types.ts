export type Platform = "foreup" | "teesnap" | "ezlinks";

export interface CourseConfig {
  name: string;
  platform: Platform;

  // ForeUp: find in the booking URL, e.g. schedule_id=21&booking_class=1308
  foreupScheduleId?: string;
  foreupBookingClass?: string;
  foreupFacilityId?: string; // used in some ForeUp URLs

  // TeeSnap: find the courseId in the TeeSnap widget URL
  tesnapCourseId?: string;

  // EZLinks: the facility ID shown in the booking URL
  ezlinksFacilityId?: string;
  ezlinksBookingUrl?: string; // full base URL for the EZLinks booking portal

  // Desired tee time window (24-hour format)
  earliestTime?: string; // e.g. "07:00"
  latestTime?: string;   // e.g. "11:00"

  // Minimum number of available players slots required
  minPlayers?: number;

  // Specific days of week to monitor (0=Sun, 1=Mon, ..., 6=Sat)
  // If omitted, every day is monitored
  daysOfWeek?: number[];
}

export interface TeeTime {
  time: string;        // ISO-8601 or HH:MM
  players: number;     // available spots
  holes: number;
  price?: number;
  bookingUrl?: string;
}

export interface CourseResult {
  course: CourseConfig;
  date: string;        // YYYY-MM-DD
  teeTimes: TeeTime[];
}
