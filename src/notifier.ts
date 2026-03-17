import axios from "axios";
import { CourseResult } from "./types";

// ---------------------------------------------------------------------------
// Natural-language message builder
// ---------------------------------------------------------------------------

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-03-29" → "Sunday, March 29" */
function friendlyDate(dateStr: string): string {
  // Parse as local noon to avoid DST shift
  const d = new Date(`${dateStr}T12:00:00`);
  return `${DAY_NAMES[d.getDay()]}, ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
}

/** "09:00" → "9:00 AM" */
function friendlyTime(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(":");
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  const ampm = h >= 12 ? "PM" : "AM";
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, "0")} ${ampm}`;
}

function buildMessage(results: CourseResult[]): string {
  // Group tee times by course+date so alerts are compact
  const groups = new Map<string, { course: CourseResult["course"]; date: string; times: CourseResult["teeTimes"] }>();

  for (const result of results) {
    const key = `${result.course.name}|${result.date}`;
    const existing = groups.get(key);
    if (existing) {
      existing.times.push(...result.teeTimes);
    } else {
      groups.set(key, { course: result.course, date: result.date, times: [...result.teeTimes] });
    }
  }

  const lines: string[] = [];

  for (const { course, date, times } of groups.values()) {
    const dateLine = friendlyDate(date);
    const bookLink = course.bookingUrl ?? "";

    const timeList = times
      .map((tt) => {
        const t = friendlyTime(tt.time);
        const spots = tt.players === 1 ? "1 spot" : `${tt.players} spots`;
        const price = tt.price !== undefined ? ` · $${tt.price.toFixed(0)}` : "";
        return `  ${t} — ${spots}${price}`;
      })
      .join("\n");

    let block =
      `⛳ *${course.name}* just opened for *${dateLine}*\n` +
      timeList;

    if (bookLink) {
      block += `\n[Book here → ${bookLink}](${bookLink})`;
    }

    lines.push(block);
  }

  return lines.join("\n\n");
}

// ---------------------------------------------------------------------------
// Telegram sender
// ---------------------------------------------------------------------------

// Escape special chars for Telegram MarkdownV2
// (we use plain Markdown mode to keep it simpler)
function escMd(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}
void escMd; // unused for now — keeping Markdown (not V2) mode

export async function sendNotification(results: CourseResult[]): Promise<void> {
  if (results.length === 0) return;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set in .env");
  }

  const text = buildMessage(results);
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  await axios.post(url, {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: false,
  });

  console.log(`[notifier] Sent ${results.reduce((n, r) => n + r.teeTimes.length, 0)} alert(s) to Telegram chat ${chatId}`);
}
