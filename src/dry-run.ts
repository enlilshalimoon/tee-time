/**
 * Dry-run test — checks all configured courses and prints results
 * to the console. No Telegram needed.
 *
 * Usage: npx ts-node src/dry-run.ts
 */

import "dotenv/config";
import { getAllCourses } from "./config-store";
import { checkAllCourses } from "./checker";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function friendlyDate(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00`);
  return `${DAY_NAMES[d.getDay()]}, ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
}

function friendlyTime(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(":");
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  const ampm = h >= 12 ? "PM" : "AM";
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, "0")} ${ampm}`;
}

async function main() {
  const courses = getAllCourses();
  if (courses.length === 0) {
    console.log("No courses in config.json");
    return;
  }

  console.log(`\n🏌️  Checking ${courses.length} course(s)...\n`);

  const results = await checkAllCourses(courses);

  if (results.length === 0) {
    console.log("No tee times found matching your filters.\n");
    return;
  }

  for (const result of results) {
    const date = friendlyDate(result.date);
    console.log(`\n⛳  ${result.course.name} — ${date}`);
    console.log("─".repeat(50));

    for (const tt of result.teeTimes) {
      const time = friendlyTime(tt.time);
      const spots = tt.players === 1 ? "1 spot" : `${tt.players} spots`;
      const price = tt.price !== undefined ? ` · $${tt.price}` : "";
      console.log(`   ${time}  (${spots}${price})`);
    }

    const link = result.course.bookingUrl;
    if (link) {
      console.log(`   🔗 ${link}`);
    }
  }

  console.log(`\n✅ Done — ${results.reduce((n, r) => n + r.teeTimes.length, 0)} total slot(s) found.\n`);
}

main().catch(console.error);
