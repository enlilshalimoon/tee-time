import "dotenv/config";
import cron from "node-cron";
import { getAllCourses } from "./config-store";
import { checkAllCourses } from "./checker";
import { sendNotification } from "./notifier";
import { startTelegramBot } from "./telegram-bot";

// ---------------------------------------------------------------------------
// Deduplication — don't re-alert for the same (course, date, time) combo
// ---------------------------------------------------------------------------

const alerted = new Set<string>();

function filterNewResults(
  results: Awaited<ReturnType<typeof checkAllCourses>>
) {
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
// Main check run
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const courses = getAllCourses();
  if (courses.length === 0) {
    console.log("[scheduler] No courses configured yet — skipping check.");
    return;
  }

  console.log(`[scheduler] Checking ${courses.length} course(s) …`);
  const allResults = await checkAllCourses(courses);
  const newResults = filterNewResults(allResults);

  if (newResults.length > 0) {
    console.log(`[scheduler] ${newResults.length} new result(s) — sending notification …`);
    await sendNotification(newResults);
  } else {
    console.log("[scheduler] No new tee times to report.");
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const checkOnce = process.argv.includes("--check-once");

if (checkOnce) {
  console.log("[bot] Running a single check …");
  run().catch(console.error);
} else {
  const cronExpr = process.env.CHECK_INTERVAL ?? "*/5 * * * *";
  console.log(`[bot] Scheduler started — interval: "${cronExpr}"`);

  // Start the Telegram bot (long-polling) in parallel with the scheduler
  startTelegramBot().catch(console.error);

  // Run a check immediately on startup, then on cron schedule
  run().catch(console.error);
  cron.schedule(cronExpr, () => {
    run().catch(console.error);
  });
}
