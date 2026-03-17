import { CourseConfig, CourseResult, TeeTime } from "./types";
import { checkForeUp } from "./checkers/foreup";
import { checkTeeSnap } from "./checkers/teesnap";
import { checkEZLinks } from "./checkers/ezlinks";

function getDatesToCheck(): string[] {
  const daysAhead = parseInt(process.env.DAYS_AHEAD ?? "7", 10);
  const dates: string[] = [];
  const today = new Date();
  for (let i = 0; i < daysAhead; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    dates.push(d.toISOString().split("T")[0]); // YYYY-MM-DD
  }
  return dates;
}

function isTimeInWindow(time: string, earliest?: string, latest?: string): boolean {
  if (!earliest && !latest) return true;
  // Normalize to HH:MM
  const t = time.slice(0, 5);
  if (earliest && t < earliest) return false;
  if (latest && t > latest) return false;
  return true;
}

function isDayWanted(dateStr: string, daysOfWeek?: number[]): boolean {
  if (!daysOfWeek || daysOfWeek.length === 0) return true;
  const d = new Date(dateStr + "T12:00:00"); // noon local to avoid DST shift
  return daysOfWeek.includes(d.getDay());
}

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
    case "ezlinks":
      teeTimes = await checkEZLinks(course, date);
      break;
    default:
      throw new Error(`Unknown platform: ${(course as CourseConfig).platform}`);
  }

  // Apply time window and player filters
  return teeTimes.filter((tt) => {
    if (!isTimeInWindow(tt.time, course.earliestTime, course.latestTime)) return false;
    if (course.minPlayers && tt.players < course.minPlayers) return false;
    return true;
  });
}

export async function checkAllCourses(courses: CourseConfig[]): Promise<CourseResult[]> {
  const dates = getDatesToCheck();
  const results: CourseResult[] = [];

  for (const course of courses) {
    for (const date of dates) {
      if (!isDayWanted(date, course.daysOfWeek)) continue;

      try {
        const teeTimes = await checkCourseForDate(course, date);
        if (teeTimes.length > 0) {
          results.push({ course, date, teeTimes });
          console.log(`[checker] ${course.name} on ${date}: ${teeTimes.length} slot(s) found`);
        } else {
          console.log(`[checker] ${course.name} on ${date}: no matching slots`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[checker] ${course.name} on ${date}: ERROR — ${msg}`);
      }
    }
  }

  return results;
}
