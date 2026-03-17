import "dotenv/config";
import cron from "node-cron";
import path from "path";
import fs from "fs";
import { CourseConfig } from "./types";
import { checkAllCourses } from "./checker";
import { sendNotification } from "./notifier";

// ---------------------------------------------------------------------------
// Load course config
// ---------------------------------------------------------------------------

function loadCourses(): CourseConfig[] {
  const configPath = path.resolve(process.cwd(), "config.json");
  if (!fs.existsSync(configPath)) {
    console.error("[bot] config.json not found. Copy config.example.json to config.json and fill in your courses.");
    process.exit(1);
  }
  const raw = fs.readFileSync(configPath, "utf-8");
  const data = JSON.parse(raw) as { courses: CourseConfig[] };
  if (!Array.isArray(data.courses) || data.courses.length === 0) {
    console.error("[bot] config.json must have a non-empty \"courses\" array.");
    process.exit(1);
  }
  return data.courses;
}

// ---------------------------------------------------------------------------
// Deduplication — don't re-alert for the same (course, date, time) combo
// ---------------------------------------------------------------------------

const alerted = new Set<string>();

function filterNewResults(results: ReturnType<typeof checkAllCourses> extends Promise<infer T> ? T : never) {
  return results
    .map((result) => ({
      ...result,
      teeTimes: result.teeTimes.filter((tt) => {
        const key = `${result.course.name}|${result.date}|${tt.time}`;
        if (alerted.has(key)) return false;
        alerted.add(key);
        return true;
      }),
    }))
    .filter((r) => r.teeTimes.length > 0);
}

// ---------------------------------------------------------------------------
// Main run loop
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const courses = loadCourses();
  console.log(`[bot] Checking ${courses.length} course(s) …`);

  const allResults = await checkAllCourses(courses);
  const newResults = filterNewResults(allResults);

  if (newResults.length > 0) {
    console.log(`[bot] ${newResults.length} new result(s) — sending email …`);
    await sendNotification(newResults);
  } else {
    console.log("[bot] No new tee times to report.");
  }
}

// ---------------------------------------------------------------------------
// Entry point — one-shot or scheduled
// ---------------------------------------------------------------------------

const checkOnce = process.argv.includes("--check-once");

if (checkOnce) {
  console.log("[bot] Running a single check …");
  run().catch(console.error);
} else {
  const cronExpr = process.env.CHECK_INTERVAL ?? "*/5 * * * *";
  console.log(`[bot] Scheduler started. Interval: "${cronExpr}"`);

  // Run immediately on startup, then on schedule
  run().catch(console.error);

  cron.schedule(cronExpr, () => {
    run().catch(console.error);
  });
}
