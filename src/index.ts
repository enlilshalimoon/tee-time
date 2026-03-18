import "dotenv/config";
import cron from "node-cron";
import { getAllCourses, getNotificationChatId } from "./config-store";
import { checkAllCourses } from "./checker";
import { filterNewlyOpened } from "./change-detector";
import { sendNotification } from "./notifier";
import { startTelegramBot } from "./telegram-bot";

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

  // Only surface tee times that *newly appeared* since the last check
  const newResults = filterNewlyOpened(allResults);

  if (newResults.length > 0) {
    const count = newResults.reduce((n, r) => n + r.teeTimes.length, 0);
    console.log(`[scheduler] ${count} newly opened slot(s) — sending notification …`);
    await sendNotification(newResults, getNotificationChatId());
  } else {
    console.log("[scheduler] No newly opened tee times.");
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
  // Default: check every 5 minutes (configurable via CHECK_INTERVAL env var)
  const cronExpr = process.env.CHECK_INTERVAL ?? "*/5 * * * *";
  console.log(`[bot] Scheduler started — interval: "${cronExpr}"`);

  // Start Telegram bot (long-polling) in parallel
  startTelegramBot().catch(console.error);

  // Immediate check on startup, then on schedule
  run().catch(console.error);
  cron.schedule(cronExpr, () => {
    run().catch(console.error);
  });
}
