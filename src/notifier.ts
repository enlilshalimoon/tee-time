import axios from "axios";
import { CourseResult, TeeTime } from "./types";

function buildMessage(results: CourseResult[]): string {
  const lines: string[] = ["⛳ *Tee Times Available!*\n"];

  for (const result of results) {
    lines.push(`*${escMd(result.course.name)}* — ${result.date}`);

    for (const tt of result.teeTimes) {
      let line = `  🕐 ${tt.time}  ·  ${tt.players} spot(s)  ·  ${tt.holes}h`;
      if (tt.price !== undefined) line += `  ·  $${tt.price.toFixed(2)}`;
      if (tt.bookingUrl) line += `\n  [Book now](${tt.bookingUrl})`;
      lines.push(line);
    }

    lines.push("");
  }

  return lines.join("\n");
}

// Escape special chars for Telegram MarkdownV2
function escMd(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

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
    disable_web_page_preview: true,
  });

  console.log(`[notifier] Telegram message sent to chat ${chatId}`);
}
