/**
 * Telegram bot — silent in groups unless spoken to via slash commands.
 *
 * Commands:
 *   /add        → add one or many courses (paste multiple URLs at once)
 *   /list       → show monitored courses
 *   /remove N   → stop monitoring a course
 *   /check      → run a manual check right now
 *   /test       → send a fake alert to preview notifications
 *   /help       → show commands
 *
 * The bot NEVER talks unprompted — only on slash commands or tee time alerts.
 */

import axios from "axios";
import { CourseConfig, CourseResult } from "./types";
import { parseBookingUrl, ParsedCourse } from "./url-parser";
import { addCourse, getAllCourses, removeCourseByIndex, updateCourseByIndex } from "./config-store";
import { checkAllCoursesDetailed } from "./checker";
import { sendNotification } from "./notifier";

// ---------------------------------------------------------------------------
// Telegram API helpers
// ---------------------------------------------------------------------------

let BOT_TOKEN = "";
let CHAT_ID = "";
let ALLOWED_CHATS: Set<string> = new Set();
const TG = () => `https://api.telegram.org/bot${BOT_TOKEN}`;

async function sendMessage(chatId: string, text: string): Promise<void> {
  await axios.post(`${TG()}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: false,
  });
}

async function getUpdates(offset: number): Promise<TelegramUpdate[]> {
  const resp = await axios.get<{ result: TelegramUpdate[] }>(
    `${TG()}/getUpdates`,
    { params: { offset, timeout: 30, allowed_updates: ["message"] }, timeout: 35_000 }
  );
  return resp.data.result ?? [];
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
  };
}

// ---------------------------------------------------------------------------
// Conversation state machine (only active after /add)
// ---------------------------------------------------------------------------

interface ParsedEntry {
  parsed: ParsedCourse;
  name: string; // resolved name (may be empty if needs asking)
}

type Step =
  | { name: "idle" }
  | { name: "awaiting_urls" }
  | { name: "awaiting_name"; entries: ParsedEntry[]; currentIdx: number }
  | { name: "awaiting_time"; entries: ParsedEntry[] }
  | { name: "awaiting_days"; entries: ParsedEntry[]; earliest?: string; latest?: string }
  | { name: "awaiting_edit_field"; courseIdx: number }
  | { name: "awaiting_edit_time"; courseIdx: number }
  | { name: "awaiting_edit_days"; courseIdx: number; earliest?: string; latest?: string };

const sessions = new Map<string, Step>();
function getSession(chatId: string): Step {
  return sessions.get(chatId) ?? { name: "idle" };
}
function setSession(chatId: string, step: Step): void {
  sessions.set(chatId, step);
}

// ---------------------------------------------------------------------------
// Input parsers
// ---------------------------------------------------------------------------

function parseTimeWindow(input: string): { earliest?: string; latest?: string } | null {
  const s = input.trim().toLowerCase();
  if (s === "any" || s === "all") return {};

  const match = s.match(
    /^(\d{1,2})(?::(\d{2}))?([ap]m)?\s*[-–to]+\s*(\d{1,2})(?::(\d{2}))?([ap]m)?$/
  );
  if (!match) return null;

  const toHour = (h: string, min: string | undefined, ampm: string | undefined): string => {
    let hour = parseInt(h, 10);
    const minutes = min ?? "00";
    if (ampm === "pm" && hour !== 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    return `${String(hour).padStart(2, "0")}:${minutes}`;
  };

  const earliest = toHour(match[1], match[2], match[3]);
  const latest = toHour(match[4], match[5], match[6] ?? match[3]);
  return { earliest, latest };
}

function parseDays(input: string): number[] | null {
  const s = input.trim().toLowerCase();
  if (s === "all" || s === "any" || s === "every day") return [];

  const nameMap: Record<string, number> = {
    sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tuesday: 2,
    wed: 3, wednesday: 3, thu: 4, thursday: 4, fri: 5, friday: 5,
    sat: 6, saturday: 6,
  };

  if (s === "weekends" || s === "weekend") return [0, 6];
  if (s === "weekdays" || s === "weekday") return [1, 2, 3, 4, 5];

  const parts = s.split(/[\s,]+/);
  const days: number[] = [];
  for (const part of parts) {
    if (/^\d$/.test(part)) days.push(parseInt(part, 10));
    else if (nameMap[part] !== undefined) days.push(nameMap[part]);
    else return null;
  }
  return days.length > 0 ? days : null;
}

function formatDays(days: number[]): string {
  if (days.length === 0) return "every day";
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return days.map((d) => names[d]).join(", ");
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleHelp(chatId: string): Promise<void> {
  await sendMessage(
    chatId,
    `*Tee Time Bot* ⛳\n\n` +
    `*Commands:*\n` +
    `/add — add courses (paste multiple URLs at once)\n` +
    `/list — show monitored courses\n` +
    `/edit <number> — change times or days for a course\n` +
    `/remove <number> — stop monitoring a course\n` +
    `/check — run a manual check right now\n` +
    `/test — send a fake alert to preview notifications\n` +
    `/help — show this message\n\n` +
    `Works with any booking site. I only talk when a new tee time opens up or when you use a command.`
  );
}

async function handleAdd(chatId: string): Promise<void> {
  await sendMessage(
    chatId,
    `Paste your booking page URL(s) — one per line, or comma separated.\n\n` +
    `You can add as many courses at once as you want.`
  );
  setSession(chatId, { name: "awaiting_urls" });
}

async function handleList(chatId: string): Promise<void> {
  const courses = getAllCourses();
  if (courses.length === 0) {
    await sendMessage(chatId, "No courses monitored yet. Use /add.");
    return;
  }

  const lines = courses.map((c, i) => {
    const time =
      c.earliestTime && c.latestTime
        ? `${c.earliestTime}–${c.latestTime}`
        : c.earliestTime ? `after ${c.earliestTime}`
        : c.latestTime ? `before ${c.latestTime}`
        : "any time";
    const days = c.daysOfWeek ? formatDays(c.daysOfWeek) : "every day";
    const link = c.bookingUrl ? `\n   ${c.bookingUrl}` : "";
    return `${i + 1}. *${c.name}*\n   ${c.platform} · ${time} · ${days}${link}`;
  });

  await sendMessage(chatId, `*Monitored courses:*\n\n${lines.join("\n\n")}`);
}

async function handleRemove(chatId: string, args: string): Promise<void> {
  const idx = parseInt(args.trim(), 10) - 1;
  if (isNaN(idx)) {
    await sendMessage(chatId, "Usage: `/remove 1` — use /list to see numbers.");
    return;
  }
  const removed = removeCourseByIndex(idx);
  if (!removed) {
    await sendMessage(chatId, `No course at #${idx + 1}. Use /list.`);
  } else {
    await sendMessage(chatId, `Removed *${removed.name}*.`);
  }
}

async function handleCheck(chatId: string): Promise<void> {
  const courses = getAllCourses();
  if (courses.length === 0) {
    await sendMessage(chatId, "No courses to check. Use /add first.");
    return;
  }
  await sendMessage(chatId, `Checking ${courses.length} course(s)…`);
  try {
    const { results, errors } = await checkAllCoursesDetailed(courses);

    if (results.length === 0 && errors.length === 0) {
      await sendMessage(chatId, "No tee times available right now.");
    } else {
      if (results.length > 0) {
        await sendNotification(results, chatId);
      } else {
        await sendMessage(chatId, "No tee times found in your time window.");
      }
      if (errors.length > 0) {
        await sendMessage(
          chatId,
          `⚠️ *Errors on ${errors.length} course(s):*\n` +
          errors.map((e) => `• ${e}`).join("\n")
        );
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendMessage(chatId, `Error: ${msg}`);
  }
}

async function handleTest(chatId: string): Promise<void> {
  const courses = getAllCourses();
  if (courses.length === 0) {
    await sendMessage(chatId, "No courses configured. Use /add first.");
    return;
  }

  const fakeResults: CourseResult[] = courses.map((course) => {
    const now = new Date();
    const daysUntilSat = (6 - now.getDay() + 7) % 7 || 7;
    const sat = new Date(now);
    sat.setDate(now.getDate() + daysUntilSat);
    const dateStr = sat.toISOString().split("T")[0];

    return {
      course,
      date: dateStr,
      teeTimes: [
        { time: "07:30", players: 4, holes: 18, price: 65, bookingUrl: course.bookingUrl },
        { time: "09:00", players: 2, holes: 18, price: 75, bookingUrl: course.bookingUrl },
      ],
    };
  });

  await sendNotification(fakeResults, chatId);
}

async function handleEdit(chatId: string, args: string): Promise<void> {
  const idx = parseInt(args.trim(), 10) - 1;
  if (isNaN(idx)) {
    await sendMessage(chatId, "Usage: `/edit 1` — use /list to see numbers.");
    return;
  }
  const courses = getAllCourses();
  if (idx < 0 || idx >= courses.length) {
    await sendMessage(chatId, `No course at #${idx + 1}. Use /list.`);
    return;
  }
  const c = courses[idx];
  const time =
    c.earliestTime && c.latestTime ? `${c.earliestTime}–${c.latestTime}`
    : c.earliestTime ? `after ${c.earliestTime}`
    : c.latestTime ? `before ${c.latestTime}`
    : "any time";
  const days = c.daysOfWeek ? formatDays(c.daysOfWeek) : "every day";

  await sendMessage(
    chatId,
    `Editing *${c.name}*\n` +
    `Current: ${time} · ${days}\n\n` +
    `What do you want to change?\n` +
    `• \`time\` — change the time window\n` +
    `• \`days\` — change the days\n` +
    `• \`both\` — change time and days`
  );
  setSession(chatId, { name: "awaiting_edit_field", courseIdx: idx });
}

async function handleAwaitingEditField(
  chatId: string,
  text: string,
  session: Extract<Step, { name: "awaiting_edit_field" }>
): Promise<void> {
  const s = text.trim().toLowerCase();
  if (s === "time" || s === "both") {
    await sendMessage(chatId, `New *time window*? (e.g. \`5am-3pm\`, \`07:00-15:00\`, or \`any\`)`);
    setSession(chatId, { name: "awaiting_edit_time", courseIdx: session.courseIdx });
  } else if (s === "days") {
    await sendMessage(chatId, `New *days*? (\`weekends\`, \`weekdays\`, \`fri sat sun\`, or \`all\`)`);
    setSession(chatId, { name: "awaiting_edit_days", courseIdx: session.courseIdx });
  } else {
    await sendMessage(chatId, `Reply with \`time\`, \`days\`, or \`both\`.`);
  }
}

async function handleAwaitingEditTime(
  chatId: string,
  text: string,
  session: Extract<Step, { name: "awaiting_edit_time" }>
): Promise<void> {
  const window = parseTimeWindow(text);
  if (window === null) {
    await sendMessage(chatId, `Try \`5am-3pm\`, \`07:00-15:00\`, or \`any\`.`);
    return;
  }
  // Check if we were in "both" mode (came from awaiting_edit_field with "both")
  // We handle this by going to awaiting_edit_days next
  await sendMessage(chatId, `New *days*? (\`weekends\`, \`weekdays\`, \`fri sat sun\`, or \`all\`)`);
  setSession(chatId, {
    name: "awaiting_edit_days",
    courseIdx: session.courseIdx,
    earliest: window.earliest,
    latest: window.latest,
  });
}

async function handleAwaitingEditDays(
  chatId: string,
  text: string,
  session: Extract<Step, { name: "awaiting_edit_days" }>
): Promise<void> {
  const days = parseDays(text);
  if (days === null) {
    await sendMessage(chatId, `Try \`weekends\`, \`weekdays\`, \`fri sat\`, or \`all\`.`);
    return;
  }

  const updates: Parameters<typeof updateCourseByIndex>[1] = {
    earliestTime: session.earliest,
    latestTime: session.latest,
    daysOfWeek: days.length > 0 ? days : undefined,
  };

  const updated = updateCourseByIndex(session.courseIdx, updates);
  setSession(chatId, { name: "idle" });

  if (!updated) {
    await sendMessage(chatId, "Couldn't update — course not found. Use /list.");
    return;
  }

  const time =
    updated.earliestTime && updated.latestTime ? `${updated.earliestTime}–${updated.latestTime}`
    : updated.earliestTime ? `after ${updated.earliestTime}`
    : updated.latestTime ? `before ${updated.latestTime}`
    : "any time";
  const daysLabel = updated.daysOfWeek ? formatDays(updated.daysOfWeek) : "every day";

  await sendMessage(chatId, `✅ Updated *${updated.name}*\nNow monitoring *${daysLabel}*, *${time}*.`);
}

// ---------------------------------------------------------------------------
// /add flow
// ---------------------------------------------------------------------------

/** Extract all URLs from a message (comma, newline, or space separated). */
function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s,<>"]+/g);
  return matches ?? [];
}

async function handleAwaitingUrls(chatId: string, text: string): Promise<void> {
  const urls = extractUrls(text);
  if (urls.length === 0) {
    await sendMessage(chatId, "No URLs found. Paste booking page URLs starting with https://");
    return;
  }

  await sendMessage(chatId, `Parsing ${urls.length} URL(s)…`);

  const entries: ParsedEntry[] = [];
  const failed: string[] = [];

  for (const url of urls) {
    const parsed = await parseBookingUrl(url);
    if (parsed) {
      entries.push({ parsed, name: parsed.suggestedName });
    } else {
      failed.push(url);
    }
  }

  if (failed.length > 0) {
    await sendMessage(chatId, `Couldn't parse: ${failed.join("\n")}`);
  }
  if (entries.length === 0) {
    await sendMessage(chatId, "No valid courses found. Try again with /add.");
    setSession(chatId, { name: "idle" });
    return;
  }

  // Show what we found
  const summary = entries
    .map((e, i) => `${i + 1}. ${e.name || "❓ Unknown"} (${e.parsed.platform})`)
    .join("\n");
  await sendMessage(chatId, `Found:\n${summary}`);

  // Check if any need names
  const needsName = entries.findIndex((e) => !e.name);
  if (needsName >= 0) {
    await sendMessage(
      chatId,
      `What's the name of course #${needsName + 1}? (${entries[needsName].parsed.partial.bookingUrl ?? "unknown URL"})`
    );
    setSession(chatId, { name: "awaiting_name", entries, currentIdx: needsName });
  } else {
    await sendMessage(chatId, `What *time window*? (e.g. \`5am-3pm\` or \`any\`)`);
    setSession(chatId, { name: "awaiting_time", entries });
  }
}

async function handleAwaitingName(
  chatId: string,
  text: string,
  session: Extract<Step, { name: "awaiting_name" }>
): Promise<void> {
  const courseName = text.trim();
  if (courseName.length < 2) {
    await sendMessage(chatId, "Enter a name (at least 2 characters).");
    return;
  }

  session.entries[session.currentIdx].name = courseName;

  // Find next unnamed
  const nextIdx = session.entries.findIndex((e, i) => i > session.currentIdx && !e.name);
  if (nextIdx >= 0) {
    await sendMessage(
      chatId,
      `What's the name of course #${nextIdx + 1}? (${session.entries[nextIdx].parsed.partial.bookingUrl ?? "unknown URL"})`
    );
    setSession(chatId, { ...session, currentIdx: nextIdx });
  } else {
    await sendMessage(chatId, `What *time window*? (e.g. \`5am-3pm\` or \`any\`)`);
    setSession(chatId, { name: "awaiting_time", entries: session.entries });
  }
}

async function handleAwaitingTime(
  chatId: string,
  text: string,
  session: Extract<Step, { name: "awaiting_time" }>
): Promise<void> {
  const window = parseTimeWindow(text);
  if (window === null) {
    await sendMessage(chatId, `Try \`5am-3pm\`, \`07:00-15:00\`, or \`any\`.`);
    return;
  }

  await sendMessage(chatId, `Which *days*? (\`weekends\`, \`weekdays\`, \`fri sat sun\`, or \`all\`)`);
  setSession(chatId, {
    name: "awaiting_days",
    entries: session.entries,
    earliest: window.earliest,
    latest: window.latest,
  });
}

async function handleAwaitingDays(
  chatId: string,
  text: string,
  session: Extract<Step, { name: "awaiting_days" }>
): Promise<void> {
  const days = parseDays(text);
  if (days === null) {
    await sendMessage(chatId, `Try \`weekends\`, \`weekdays\`, \`fri sat\`, or \`all\`.`);
    return;
  }

  // Save all courses
  const names: string[] = [];
  for (const entry of session.entries) {
    const p = entry.parsed.partial;
    const course: CourseConfig = {
      name: entry.name,
      platform: p.platform!,
      ...(p.foreupScheduleId ? { foreupScheduleId: p.foreupScheduleId } : {}),
      ...(p.foreupBookingClass ? { foreupBookingClass: p.foreupBookingClass } : {}),
      ...(p.tesnapCourseId ? { tesnapCourseId: p.tesnapCourseId } : {}),
      ...(p.chronogolfClubId ? { chronogolfClubId: p.chronogolfClubId } : {}),
      ...(p.bookingUrl ? { bookingUrl: p.bookingUrl } : {}),
      ...(session.earliest ? { earliestTime: session.earliest } : {}),
      ...(session.latest ? { latestTime: session.latest } : {}),
      ...(days.length > 0 ? { daysOfWeek: days } : {}),
    };
    addCourse(course);
    names.push(course.name);
  }

  setSession(chatId, { name: "idle" });

  const time =
    session.earliest && session.latest
      ? `${session.earliest}–${session.latest}`
      : "any time";
  const daysLabel = formatDays(days);

  await sendMessage(
    chatId,
    `✅ Added *${names.length}* course(s):\n` +
    names.map((n) => `• *${n}*`).join("\n") +
    `\n\nMonitoring *${daysLabel}*, *${time}*. Use /test to preview alerts.`
  );
}

// ---------------------------------------------------------------------------
// Main message dispatcher
// ---------------------------------------------------------------------------

async function handleMessage(chatId: string, text: string): Promise<void> {
  const t = text.trim();
  const cmd = t.split(/\s|@/)[0].toLowerCase();

  if (cmd === "/help" || cmd === "/start") return handleHelp(chatId);
  if (cmd === "/add") return handleAdd(chatId);
  if (cmd === "/list") return handleList(chatId);
  if (cmd === "/check") return handleCheck(chatId);
  if (cmd === "/test") return handleTest(chatId);
  if (cmd === "/edit") return handleEdit(chatId, t.replace(/^\/edit\S*/i, ""));
  if (cmd === "/remove") return handleRemove(chatId, t.replace(/^\/remove\S*/i, ""));
  if (cmd === "/cancel") {
    setSession(chatId, { name: "idle" });
    await sendMessage(chatId, "Cancelled.");
    return;
  }

  // Mid-flow responses
  const session = getSession(chatId);
  if (session.name === "awaiting_urls") return handleAwaitingUrls(chatId, t);
  if (session.name === "awaiting_name") return handleAwaitingName(chatId, t, session);
  if (session.name === "awaiting_time") return handleAwaitingTime(chatId, t, session);
  if (session.name === "awaiting_days") return handleAwaitingDays(chatId, t, session);
  if (session.name === "awaiting_edit_field") return handleAwaitingEditField(chatId, t, session);
  if (session.name === "awaiting_edit_time") return handleAwaitingEditTime(chatId, t, session);
  if (session.name === "awaiting_edit_days") return handleAwaitingEditDays(chatId, t, session);

  // Silent — don't respond to random messages
}

// ---------------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------------

export async function startTelegramBot(): Promise<void> {
  BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
  CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";

  const rawAllowed = process.env.TELEGRAM_ALLOWED_CHATS ?? "";
  ALLOWED_CHATS = rawAllowed
    ? new Set(rawAllowed.split(",").map((s) => s.trim()).filter(Boolean))
    : new Set();

  if (!BOT_TOKEN) {
    console.error("[bot] TELEGRAM_BOT_TOKEN not set — bot disabled");
    return;
  }

  console.log("[bot] Telegram bot started (long-polling)");

  let offset = 0;

  while (true) {
    try {
      const updates = await getUpdates(offset);
      for (const update of updates) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text) continue;

        const chatId = String(msg.chat.id);

        if (ALLOWED_CHATS.size > 0 && !ALLOWED_CHATS.has(chatId)) {
          continue;
        }

        await handleMessage(chatId, msg.text).catch((err) => {
          console.error(`[bot] handler error:`, err);
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("ETIMEOUT") && !msg.includes("timeout")) {
        console.error("[bot] polling error:", msg);
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }
}
