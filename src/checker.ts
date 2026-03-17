import { CourseConfig, CourseResult, TeeTime } from "./types";
import { checkForeUp } from "./checkers/foreup";
import { checkTeeSnap } from "./checkers/teesnap";
import { checkChronogolf } from "./checkers/chronogolf";
import { checkWebScraper } from "./checkers/web-scraper";

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** Returns the next N weekend dates (Sat + Sun) from today. */
export function getWeekendDates(weeksAhead = 4): string[] {
  const dates: string[] = [];
  const today = new Date();
  // Go out 4 weeks worth of days to collect weekends
  for (let i = 0; i <= weeksAhead * 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const day = d.getDay();
    if (day === 0 || day === 6) {
      dates.push(d.toISOString().split("T")[0]);
    }
  }
  return dates;
}

/** Returns dates within the lookahead window. */
function getDatesToCheck(): string[] {
  const daysAhead = parseInt(process.env.DAYS_AHEAD ?? "14", 10);
  const dates: string[] = [];
  const today = new Date();
  for (let i = 0; i < daysAhead; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    dates.push(d.toISOString().split("T")[0]);
  }
  return dates;
}

const ABSOLUTE_EARLIEST = "06:00"; // no golf course opens before 6am

function isTimeInWindow(time: string, earliest?: string, latest?: string): boolean {
  const t = time.slice(0, 5);
  if (t < ABSOLUTE_EARLIEST) return false;
  if (!earliest && !latest) return true;
  if (earliest && t < earliest) return false;
  if (latest && t > latest) return false;
  return true;
}

function isDayWanted(dateStr: string, daysOfWeek?: number[]): boolean {
  if (!daysOfWeek || daysOfWeek.length === 0) return true;
  const d = new Date(`${dateStr}T12:00:00`);
  return daysOfWeek.includes(d.getDay());
}

// ---------------------------------------------------------------------------
// Per-platform dispatch
// ---------------------------------------------------------------------------

async function checkCourseForDate(
  course: CourseConfig,
  date: string
): Promise<TeeTime[]> {
  let teeTimes: TeeTime[];

  switch (course.platform) {
    case "foreup":
      teeTimes = await checkForeUp(course, date);
      break;
    case "teesnap":
      teeTimes = await checkTeeSnap(course, date);
      break;
    case "chronogolf":
      teeTimes = await checkChronogolf(course, date);
      break;
    case "web":
      teeTimes = await checkWebScraper(course, date);
      break;
    default:
      throw new Error(`Unknown platform: ${(course as CourseConfig).platform}`);
  }

  return teeTimes.filter((tt) => {
    if (!isTimeInWindow(tt.time, course.earliestTime, course.latestTime)) return false;
    if (course.minPlayers && tt.players < course.minPlayers) return false;
    if (course.minHoles && tt.holes < course.minHoles) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function checkAllCourses(courses: CourseConfig[]): Promise<CourseResult[]> {
  const { results } = await checkAllCoursesDetailed(courses);
  return results;
}

export async function checkAllCoursesDetailed(
  courses: CourseConfig[]
): Promise<{ results: CourseResult[]; errors: string[] }> {
  const dates = getDatesToCheck();
  const results: CourseResult[] = [];
  const errors: string[] = [];

  for (const course of courses) {
    let checkedAnyDate = false;
    let courseErrorMsg = "";

    for (const date of dates) {
      if (!isDayWanted(date, course.daysOfWeek)) continue;
      checkedAnyDate = true;

      try {
        const teeTimes = await checkCourseForDate(course, date);
        if (teeTimes.length > 0) {
          results.push({ course, date, teeTimes });
          console.log(`[checker] ${course.name} on ${date}: ${teeTimes.length} slot(s) available`);
        } else {
          console.log(`[checker] ${course.name} on ${date}: no matching slots`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[checker] ${course.name} on ${date}: ERROR — ${msg}`);
        // Only record the first error per course to avoid spamming
        if (!courseErrorMsg) courseErrorMsg = msg;
      }
    }

    if (!checkedAnyDate) {
      errors.push(`${course.name}: no dates to check (days filter: ${course.daysOfWeek?.join(",")})`);
    } else if (courseErrorMsg) {
      errors.push(`${course.name}: ${courseErrorMsg}`);
    }
  }

  return { results, errors };
}
