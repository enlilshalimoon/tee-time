/**
 * Telegram bot — silent in groups unless spoken to via slash commands.
 *
 * Commands:
 *   /add                  → guided flow to add a course monitor
 *   /list                 → show monitored courses
 *   /remove <number>      → stop monitoring a course
 *   /check                → run a manual tee-time check right now
 *   /test                 → send a fake alert to preview notifications
 *   /help                 → show commands
 *
 * The bot NEVER talks unprompted — it only speaks when:
 *   1. Someone uses a slash command
 *   2. A newly opened tee time is found (scheduled alert)
 */

import axios from "axios";
import { CourseConfig, CourseResult } from "./types";
import { parseBookingUrl } from "./url-parser";
import { addCourse, getAllCourses, removeCourseByIndex } from "./config-store";
import { checkAllCourses } from "./checker";
import { filterNewlyOpened } from "./change-detector";
import { sendNotification } from "./notifier";

// ---------------------------------------------------------------------------
// Telegram API helpers
// ---------------------------------------------------------------------------

let BOT_TOKEN = "";
let CHAT_ID = "";
let ALLOWED_CHATS: Set<string> = new Set(); // empty = allow all
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

type Step =
  | { name: "idle" }
  | { name: "awaiting_url" }
  | { name: "awaiting_name"; draft: Partial<CourseConfig> }
  | { name: "awaiting_time"; draft: Partial<CourseConfig>; suggestedName: string }
  | { name: "awaiting_days"; draft: Partial<CourseConfig>; suggestedName: string };

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
    sun: 0, sunday: 0,
    mon: 1, monday: 1,
    tue: 2, tuesday: 2,
    wed: 3, wednesday: 3,
    thu: 4, thursday: 4,
    fri: 5, friday: 5,
    sat: 6, saturday: 6,
  };

  if (s === "weekends" || s === "weekend") return [0, 6];
  if (s === "weekdays" || s === "weekday") return [1, 2, 3, 4, 5];

  const parts = s.split(/[\s,]+/);
  const days: number[] = [];
  for (const part of parts) {
    if (/^\d$/.test(part)) {
      days.push(parseInt(part, 10));
    } else if (nameMap[part] !== undefined) {
      days.push(nameMap[part]);
    } else {
      return null;
    }
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
    `/add — add a course to monitor\n` +
    `/list — show monitored courses\n` +
    `/remove <number> — stop monitoring a course\n` +
    `/check — run a manual check right now\n` +
    `/test — send a fake alert to preview notifications\n` +
    `/help — show this message\n\n` +
    `Works with any booking site — ForeUp, TeeSnap, Chronogolf, EZLinks, Play18, GolfNow, and more.\n\n` +
    `I only talk when a new tee time opens up or when you use a command.`
  );
}

async function handleAdd(chatId: string): Promise<void> {
  await sendMessage(
    chatId,
    `Paste the *booking page URL* for the course you want to monitor.\n\n` +
    `Go to the course's website, find their tee time booking page, and paste that URL here.`
  );
  setSession(chatId, { name: "awaiting_url" });
}

async function handleList(chatId: string): Promise<void> {
  const courses = getAllCourses();
  if (courses.length === 0) {
    await sendMessage(chatId, "No courses monitored yet. Use /add to add one.");
    return;
  }

  const lines = courses.map((c, i) => {
    const time =
      c.earliestTime && c.latestTime
        ? `${c.earliestTime}–${c.latestTime}`
        : c.earliestTime
        ? `after ${c.earliestTime}`
        : c.latestTime
        ? `before ${c.latestTime}`
        : "any time";
    const days = c.daysOfWeek ? formatDays(c.daysOfWeek) : "every day";
    return `${i + 1}. *${c.name}*\n   ${c.platform} · ${time} · ${days}`;
  });

  await sendMessage(chatId, `*Monitored courses:*\n\n${lines.join("\n\n")}`);
}

async function handleRemove(chatId: string, args: string): Promise<void> {
  const idx = parseInt(args.trim(), 10) - 1;
  if (isNaN(idx)) {
    await sendMessage(chatId, "Usage: `/remove 1` — use /list to see course numbers.");
    return;
  }
  const removed = removeCourseByIndex(idx);
  if (!removed) {
    await sendMessage(chatId, `No course at position ${idx + 1}. Use /list to check.`);
  } else {
    await sendMessage(chatId, `Removed *${removed.name}* from monitoring.`);
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
    const allResults = await checkAllCourses(courses);
    const newResults = filterNewlyOpened(allResults);
    if (newResults.length === 0) {
      await sendMessage(chatId, "No newly opened tee times right now.");
    } else {
      await sendNotification(newResults);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendMessage(chatId, `Error: ${msg}`);
  }
}

async function handleTest(chatId: string): Promise<void> {
  const courses = getAllCourses();
  if (courses.length === 0) {
    await sendMessage(chatId, "No courses configured. Use /add first, then /test.");
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

  await sendNotification(fakeResults);
}

// ---------------------------------------------------------------------------
// /add flow — step handlers
// ---------------------------------------------------------------------------

async function handleAwaitingUrl(chatId: string, text: string): Promise<void> {
  const urlMatch = text.match(/https?:\/\/\S+/);
  if (!urlMatch) {
    await sendMessage(chatId, "That doesn't look like a URL. Paste the full booking page URL (starting with https://).");
    return;
  }

  await sendMessage(chatId, "🔍 Parsing…");

  const parsed = await parseBookingUrl(urlMatch[0]);
  if (!parsed) {
    await sendMessage(chatId, "Couldn't parse that URL. Try pasting the full booking page URL.");
    setSession(chatId, { name: "idle" });
    return;
  }

  if (parsed.suggestedName) {
    await sendMessage(
      chatId,
      `Found *${parsed.suggestedName}*!\n\n` +
      `What *time window*? (e.g. \`7am-11am\` or \`any\`)`
    );
    setSession(chatId, {
      name: "awaiting_time",
      draft: { ...parsed.partial, name: parsed.suggestedName },
      suggestedName: parsed.suggestedName,
    });
  } else {
    await sendMessage(chatId, `What's the *name* of this course?`);
    setSession(chatId, { name: "awaiting_name", draft: parsed.partial });
  }
}

async function handleAwaitingName(
  chatId: string,
  text: string,
  session: Extract<Step, { name: "awaiting_name" }>
): Promise<void> {
  const courseName = text.trim();
  if (courseName.length < 2) {
    await sendMessage(chatId, "Enter a course name (at least 2 characters).");
    return;
  }

  await sendMessage(chatId, `What *time window*? (e.g. \`7am-11am\` or \`any\`)`);
  setSession(chatId, {
    name: "awaiting_time",
    draft: { ...session.draft, name: courseName },
    suggestedName: courseName,
  });
}

async function handleAwaitingTime(
  chatId: string,
  text: string,
  session: Extract<Step, { name: "awaiting_time" }>
): Promise<void> {
  const window = parseTimeWindow(text);
  if (window === null) {
    await sendMessage(chatId, `Try \`7am-11am\`, \`07:00-11:00\`, or \`any\`.`);
    return;
  }

  const draft: Partial<CourseConfig> = { ...session.draft, ...window };
  await sendMessage(chatId, `Which *days*? (\`weekends\`, \`weekdays\`, \`fri sat sun\`, or \`all\`)`);
  setSession(chatId, { name: "awaiting_days", draft, suggestedName: session.suggestedName });
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

  const course: CourseConfig = {
    name: session.draft.name ?? session.suggestedName,
    platform: session.draft.platform!,
    ...(session.draft.foreupScheduleId ? { foreupScheduleId: session.draft.foreupScheduleId } : {}),
    ...(session.draft.foreupBookingClass ? { foreupBookingClass: session.draft.foreupBookingClass } : {}),
    ...(session.draft.tesnapCourseId ? { tesnapCourseId: session.draft.tesnapCourseId } : {}),
    ...(session.draft.chronogolfClubId ? { chronogolfClubId: session.draft.chronogolfClubId } : {}),
    ...(session.draft.earliestTime ? { earliestTime: session.draft.earliestTime } : {}),
    ...(session.draft.latestTime ? { latestTime: session.draft.latestTime } : {}),
    ...(session.draft.bookingUrl ? { bookingUrl: session.draft.bookingUrl } : {}),
    ...(days.length > 0 ? { daysOfWeek: days } : {}),
  };

  addCourse(course);
  setSession(chatId, { name: "idle" });

  const time =
    course.earliestTime && course.latestTime
      ? `${course.earliestTime}–${course.latestTime}`
      : "any time";
  const daysLabel = formatDays(days);

  await sendMessage(
    chatId,
    `✅ *${course.name}* added! Monitoring *${daysLabel}*, *${time}*.`
  );
}

// ---------------------------------------------------------------------------
// Main message dispatcher
// ---------------------------------------------------------------------------

async function handleMessage(chatId: string, text: string): Promise<void> {
  const t = text.trim();

  // Handle /commands — strip @botname suffix for group compatibility
  const cmd = t.split(/\s|@/)[0].toLowerCase();

  if (cmd === "/help" || cmd === "/start") return handleHelp(chatId);
  if (cmd === "/add") return handleAdd(chatId);
  if (cmd === "/list") return handleList(chatId);
  if (cmd === "/check") return handleCheck(chatId);
  if (cmd === "/test") return handleTest(chatId);
  if (cmd === "/remove") return handleRemove(chatId, t.replace(/^\/remove\S*/i, ""));
  if (cmd === "/cancel") {
    setSession(chatId, { name: "idle" });
    await sendMessage(chatId, "Cancelled.");
    return;
  }

  // If we're mid-flow from /add, handle the response
  const session = getSession(chatId);

  if (session.name === "awaiting_url") return handleAwaitingUrl(chatId, t);
  if (session.name === "awaiting_name") return handleAwaitingName(chatId, t, session);
  if (session.name === "awaiting_time") return handleAwaitingTime(chatId, t, session);
  if (session.name === "awaiting_days") return handleAwaitingDays(chatId, t, session);

  // Otherwise: stay silent. Don't respond to random chat messages.
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
          continue; // silently ignore
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
