/**
 * Interactive Telegram bot — long-polling.
 *
 * Commands:
 *   Send any booking URL  → guided flow to add a course monitor
 *   /list                 → show monitored courses
 *   /remove <number>      → stop monitoring a course
 *   /check                → run a manual tee-time check right now
 *   /help                 → show this list
 */

import axios from "axios";
import { CourseConfig } from "./types";
import { parseBookingUrl } from "./url-parser";
import { addCourse, getAllCourses, removeCourseByIndex } from "./config-store";
import { checkAllCourses } from "./checker";
import { sendNotification } from "./notifier";

// ---------------------------------------------------------------------------
// Telegram API helpers
// ---------------------------------------------------------------------------

let BOT_TOKEN = "";
let CHAT_ID = "";
const TG = () => `https://api.telegram.org/bot${BOT_TOKEN}`;

async function sendMessage(chatId: string, text: string): Promise<void> {
  await axios.post(`${TG()}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
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
// Conversation state machine
// ---------------------------------------------------------------------------

type Step =
  | { name: "idle" }
  | { name: "awaiting_time"; draft: Partial<CourseConfig>; suggestedName: string }
  | { name: "awaiting_days"; draft: Partial<CourseConfig>; suggestedName: string }
  | { name: "awaiting_name"; draft: Partial<CourseConfig> };

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

/** Parse "7am-11am", "7:00-11:00", "any", etc. → { earliest, latest } */
function parseTimeWindow(input: string): { earliest?: string; latest?: string } | null {
  const s = input.trim().toLowerCase();
  if (s === "any" || s === "all") return {};

  // Match formats: "7am-11am", "7:00am-11:00am", "07:00-11:00", "7-11am"
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
  const latest = toHour(match[4], match[5], match[6] ?? match[3]); // inherit am/pm if only one given
  return { earliest, latest };
}

/** Parse "weekends", "weekdays", "friday saturday", "all", numbers 0-6 */
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

  // Space/comma separated day names or numbers
  const parts = s.split(/[\s,]+/);
  const days: number[] = [];
  for (const part of parts) {
    if (/^\d$/.test(part)) {
      days.push(parseInt(part, 10));
    } else if (nameMap[part] !== undefined) {
      days.push(nameMap[part]);
    } else {
      return null; // unrecognized
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
    `Send me any booking page URL and I'll set up monitoring for you.\n\n` +
    `*Commands:*\n` +
    `/list — show monitored courses\n` +
    `/remove <number> — stop monitoring a course\n` +
    `/check — run a manual check right now\n` +
    `/help — show this message\n\n` +
    `*Supported platforms:*\n` +
    `• ForeUp (foreupsoftware.com)\n` +
    `• TeeSnap (teesnap.net)\n` +
    `• EZLinks / GolfNow`
  );
}

async function handleList(chatId: string): Promise<void> {
  const courses = getAllCourses();
  if (courses.length === 0) {
    await sendMessage(chatId, "No courses monitored yet. Send me a booking URL to add one!");
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
    await sendMessage(chatId, "Usage: /remove <number> — use /list to see course numbers.");
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
    await sendMessage(chatId, "No courses to check yet. Send me a booking URL first!");
    return;
  }
  await sendMessage(chatId, `Checking ${courses.length} course(s) right now…`);
  try {
    const results = await checkAllCourses(courses);
    if (results.length === 0) {
      await sendMessage(chatId, "No matching tee times found right now.");
    } else {
      await sendNotification(results);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendMessage(chatId, `Error during check: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// URL flow — step 1: got a URL
// ---------------------------------------------------------------------------

async function handleUrl(chatId: string, text: string): Promise<void> {
  await sendMessage(chatId, "🔍 Parsing that URL…");

  const parsed = await parseBookingUrl(text);
  if (!parsed) {
    await sendMessage(
      chatId,
      "Sorry, I couldn't recognise that as a ForeUp, TeeSnap, or EZLinks booking URL.\n\n" +
      "Make sure it's the actual tee-time booking page, e.g.:\n" +
      "`https://foreupsoftware.com/index.php/booking/21903/9285#teetimes`"
    );
    return;
  }

  const platformLabel = { foreup: "ForeUp", teesnap: "TeeSnap", ezlinks: "EZLinks/GolfNow" }[parsed.platform];
  await sendMessage(
    chatId,
    `✅ Found a *${platformLabel}* course!\n` +
    `Detected name: *${parsed.suggestedName}*\n\n` +
    `What *time window* do you want?\n` +
    `Reply with e.g. \`7am-11am\`, \`6:00-10:00\`, or \`any\``
  );

  setSession(chatId, {
    name: "awaiting_time",
    draft: { ...parsed.partial, name: parsed.suggestedName },
    suggestedName: parsed.suggestedName,
  });
}

// ---------------------------------------------------------------------------
// URL flow — step 2: time window
// ---------------------------------------------------------------------------

async function handleAwaitingTime(chatId: string, text: string, session: Extract<Step, { name: "awaiting_time" }>): Promise<void> {
  const window = parseTimeWindow(text);
  if (window === null) {
    await sendMessage(
      chatId,
      `Couldn't parse that. Try something like \`7am-11am\`, \`07:00-11:00\`, or \`any\`.`
    );
    return;
  }

  const draft: Partial<CourseConfig> = {
    ...session.draft,
    ...window,
  };

  await sendMessage(
    chatId,
    `Got it. Which *days* should I monitor?\n\n` +
    `Reply with \`weekends\`, \`weekdays\`, a list like \`fri sat sun\`, or \`all\``
  );

  setSession(chatId, { name: "awaiting_days", draft, suggestedName: session.suggestedName });
}

// ---------------------------------------------------------------------------
// URL flow — step 3: days of week → finalize and save
// ---------------------------------------------------------------------------

async function handleAwaitingDays(chatId: string, text: string, session: Extract<Step, { name: "awaiting_days" }>): Promise<void> {
  const days = parseDays(text);
  if (days === null) {
    await sendMessage(
      chatId,
      `Couldn't parse that. Try \`weekends\`, \`weekdays\`, \`fri sat\`, or \`all\`.`
    );
    return;
  }

  const course: CourseConfig = {
    name: session.draft.name ?? session.suggestedName,
    platform: session.draft.platform!,
    ...(session.draft.foreupScheduleId ? { foreupScheduleId: session.draft.foreupScheduleId } : {}),
    ...(session.draft.foreupBookingClass ? { foreupBookingClass: session.draft.foreupBookingClass } : {}),
    ...(session.draft.tesnapCourseId ? { tesnapCourseId: session.draft.tesnapCourseId } : {}),
    ...(session.draft.ezlinksFacilityId ? { ezlinksFacilityId: session.draft.ezlinksFacilityId } : {}),
    ...(session.draft.ezlinksBookingUrl ? { ezlinksBookingUrl: session.draft.ezlinksBookingUrl } : {}),
    ...(session.draft.earliestTime ? { earliestTime: session.draft.earliestTime } : {}),
    ...(session.draft.latestTime ? { latestTime: session.draft.latestTime } : {}),
    ...(days.length > 0 ? { daysOfWeek: days } : {}),
  };

  addCourse(course);
  setSession(chatId, { name: "idle" });

  const time =
    course.earliestTime && course.latestTime
      ? `${course.earliestTime}–${course.latestTime}`
      : "any time";
  const daysLabel = formatDays(days);
  const interval = process.env.CHECK_INTERVAL ?? "*/5 * * * *";

  await sendMessage(
    chatId,
    `✅ *${course.name}* added!\n\n` +
    `I'll check *${daysLabel}* between *${time}* every few minutes (schedule: \`${interval}\`) and alert you when spots open.\n\n` +
    `Use /list to see all monitored courses or /check to run a manual check.`
  );
}

// ---------------------------------------------------------------------------
// Main message dispatcher
// ---------------------------------------------------------------------------

async function handleMessage(chatId: string, text: string): Promise<void> {
  const t = text.trim();

  // Commands
  if (t === "/help" || t === "/start") return handleHelp(chatId);
  if (t === "/list") return handleList(chatId);
  if (t === "/check") return handleCheck(chatId);
  if (t.startsWith("/remove")) return handleRemove(chatId, t.replace("/remove", ""));
  if (t === "/cancel") {
    setSession(chatId, { name: "idle" });
    await sendMessage(chatId, "Cancelled. Send a booking URL or /help to see commands.");
    return;
  }

  // State machine
  const session = getSession(chatId);

  if (session.name === "awaiting_time") {
    return handleAwaitingTime(chatId, t, session);
  }
  if (session.name === "awaiting_days") {
    return handleAwaitingDays(chatId, t, session);
  }

  // Detect URLs (idle state)
  if (t.includes("foreupsoftware.com") || t.includes("teesnap") || t.includes("ezlinks") || t.includes("golfnow") || t.includes("teeitup")) {
    // Extract URL from text (user might paste extra text alongside)
    const urlMatch = t.match(/https?:\/\/\S+/);
    return handleUrl(chatId, urlMatch ? urlMatch[0] : t);
  }

  // Fallback
  await sendMessage(
    chatId,
    `Not sure what to do with that. Send me a booking page URL to add a course, or type /help.`
  );
}

// ---------------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------------

export async function startTelegramBot(): Promise<void> {
  BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
  CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";

  if (!BOT_TOKEN) {
    console.error("[bot] TELEGRAM_BOT_TOKEN not set — bot disabled");
    return;
  }

  console.log("[bot] Telegram bot started (long-polling)");

  // Greet on startup
  if (CHAT_ID) {
    const courses = getAllCourses().filter((c) => !("_hint" in c));
    const greet =
      courses.length > 0
        ? `Bot restarted. Monitoring *${courses.length}* course(s). Use /list to see them.`
        : `Bot started! Send me a golf booking URL and I'll monitor it for you. Try /help.`;
    try {
      await sendMessage(CHAT_ID, greet);
    } catch {
      // non-fatal
    }
  }

  let offset = 0;

  while (true) {
    try {
      const updates = await getUpdates(offset);
      for (const update of updates) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text) continue;

        const chatId = String(msg.chat.id);

        // Only respond to the configured chat (security)
        if (CHAT_ID && chatId !== CHAT_ID) {
          await sendMessage(chatId, "Sorry, I'm a private bot.");
          continue;
        }

        await handleMessage(chatId, msg.text).catch(async (err) => {
          console.error(`[bot] handler error:`, err);
          await sendMessage(chatId, `Something went wrong: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
        });
      }
    } catch (err) {
      // Network hiccup — wait a bit then retry
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("ETIMEOUT") && !msg.includes("timeout")) {
        console.error("[bot] polling error:", msg);
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }
}
