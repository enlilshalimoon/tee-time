export type Platform = "foreup" | "teesnap" | "chronogolf" | "web" | "ezlinks";

export interface CourseConfig {
  name: string;
  platform: Platform;

  // ForeUp: find in the booking URL
  // e.g. foreupsoftware.com/index.php/booking/21903/9285
  //   scheduleId = 21903, bookingClass = 9285
  foreupScheduleId?: string;
  foreupBookingClass?: string;

  // TeeSnap: the courseId in the TeeSnap widget URL
  tesnapCourseId?: string;

  // Chronogolf / Lightspeed Golf: the club slug or numeric ID
  // Find it in the booking URL, e.g. chronogolf.com/club/rustic-canyon/...
  chronogolfClubId?: string;

  // Desired tee time window (24-hour format)
  earliestTime?: string; // e.g. "07:00"
  latestTime?: string;   // e.g. "11:00"

  // Minimum available player slots
  minPlayers?: number;

  // Minimum holes (set to 18 to exclude par-3 and 9-hole options)
  minHoles?: number;

  // Days of week to monitor (0=Sun, 1=Mon, …, 6=Sat)
  // Omit to monitor every day
  daysOfWeek?: number[];

  // Direct link to the course's booking page (shown in alerts)
  bookingUrl?: string;
}

export interface TeeTime {
  time: string;        // HH:MM
  players: number;     // available spots
  holes: number;
  price?: number;
  bookingUrl?: string; // deep link to book this specific slot
}

export interface CourseResult {
  course: CourseConfig;
  date: string;        // YYYY-MM-DD
  teeTimes: TeeTime[];
  isNew?: boolean;     // true when the slot just appeared
}
