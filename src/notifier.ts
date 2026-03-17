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
  const lines: string[] = [];

  for (const result of results) {
    const dateLine = friendlyDate(result.date);

    for (const tt of result.teeTimes) {
      const timeStr = friendlyTime(tt.time);
      const spotsStr = tt.players === 1 ? "1 spot" : `${tt.players} spots`;
      const priceStr = tt.price !== undefined ? ` · $${tt.price.toFixed(0)}` : "";

      let line =
        `⛳ *${result.course.name}* just opened for *${dateLine}* at *${timeStr}*` +
        ` (${spotsStr}${priceStr})`;

      // Prefer the deep booking link on the slot, fall back to course booking page
      const bookLink = tt.bookingUrl ?? result.course.bookingUrl;
      if (bookLink) {
        line += `\n[Book now →](${bookLink})`;
      }

      lines.push(line);
    }
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
