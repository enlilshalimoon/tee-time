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
    `Send me any golf booking page URL and I'll monitor it for newly opened tee times.\n\n` +
    `*Commands:*\n` +
    `/list — show monitored courses\n` +
    `/remove <number> — stop monitoring a course\n` +
    `/check — run a manual check right now\n` +
    `/test — send a fake alert to see what notifications look like\n` +
    `/help — show this message\n\n` +
    `*Supported platforms:*\n` +
    `• ForeUp (foreupsoftware.com, teeitup.golf)\n` +
    `• TeeSnap (teesnap.net)\n` +
    `• Chronogolf / Lightspeed Golf\n\n` +
    `I only alert when a slot *newly opens up* — no spam for times you already know about.`
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
    const allResults = await checkAllCourses(courses);
    const newResults = filterNewlyOpened(allResults);
    if (newResults.length === 0) {
      await sendMessage(chatId, "No newly opened tee times found right now.");
    } else {
      await sendNotification(newResults);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendMessage(chatId, `Error during check: ${msg}`);
  }
}

async function handleTest(chatId: string): Promise<void> {
  const courses = getAllCourses();
  if (courses.length === 0) {
    await sendMessage(chatId, "No courses configured. Add one first, then /test.");
    return;
  }

  // Build a fake "newly opened" result for each course
  const fakeResults: CourseResult[] = courses.map((course) => {
    // Pick next Saturday
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

  await sendMessage(chatId, `Sending a *test notification* with ${fakeResults.length} course(s)…`);
  await sendNotification(fakeResults);
  await sendMessage(chatId, "✅ Test notification sent! That's what real alerts will look like.");
}

// ---------------------------------------------------------------------------
// URL flow
// ---------------------------------------------------------------------------

async function handleUrl(chatId: string, text: string): Promise<void> {
  await sendMessage(chatId, "🔍 Parsing that booking URL…");

  const parsed = await parseBookingUrl(text);
  if (!parsed) {
    await sendMessage(
      chatId,
      "Sorry, I couldn't recognise that URL as a supported booking platform.\n\n" +
      "*Supported:*\n" +
      "• ForeUp: `foreupsoftware.com` or `*.teeitup.golf`\n" +
      "• TeeSnap: `*.teesnap.net`\n" +
      "• Chronogolf: `chronogolf.com` or `golf.lightspeedhq.com`\n\n" +
      "Paste the actual booking page URL from the course's website."
    );
    return;
  }

  const platformLabel: Record<string, string> = {
    foreup: "ForeUp",
    teesnap: "TeeSnap",
    chronogolf: "Chronogolf/Lightspeed Golf",
  };

  // If auto-detection found a real name, skip straight to time window
  if (parsed.suggestedName) {
    await sendMessage(
      chatId,
      `✅ Found *${parsed.suggestedName}* on *${platformLabel[parsed.platform] ?? parsed.platform}*!\n\n` +
      `What *time window* do you want to monitor?\n` +
      `Reply with e.g. \`7am-11am\`, \`6:00-10:00\`, or \`any\``
    );

    setSession(chatId, {
      name: "awaiting_time",
      draft: { ...parsed.partial, name: parsed.suggestedName },
      suggestedName: parsed.suggestedName,
    });
  } else {
    // Name couldn't be detected — ask the user
    await sendMessage(
      chatId,
      `✅ Found a *${platformLabel[parsed.platform] ?? parsed.platform}* course!\n\n` +
      `What's the *name* of this course? (e.g. "Rustic Canyon")`
    );

    setSession(chatId, {
      name: "awaiting_name",
      draft: parsed.partial,
    });
  }
}

async function handleAwaitingName(
  chatId: string,
  text: string,
  session: Extract<Step, { name: "awaiting_name" }>
): Promise<void> {
  const courseName = text.trim();
  if (courseName.length < 2) {
    await sendMessage(chatId, "Please enter a course name (at least 2 characters).");
    return;
  }

  await sendMessage(
    chatId,
    `Great — *${courseName}*!\n\n` +
    `What *time window* do you want to monitor?\n` +
    `Reply with e.g. \`7am-11am\`, \`6:00-10:00\`, or \`any\``
  );

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
    await sendMessage(
      chatId,
      `Couldn't parse that time. Try \`7am-11am\`, \`07:00-11:00\`, or \`any\`.`
    );
    return;
  }

  const draft: Partial<CourseConfig> = { ...session.draft, ...window };
  await sendMessage(
    chatId,
    `Got it. Which *days* should I monitor?\n\n` +
    `Reply with \`weekends\`, \`weekdays\`, a list like \`fri sat sun\`, or \`all\``
  );
  setSession(chatId, { name: "awaiting_days", draft, suggestedName: session.suggestedName });
}

async function handleAwaitingDays(
  chatId: string,
  text: string,
  session: Extract<Step, { name: "awaiting_days" }>
): Promise<void> {
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
  const interval = process.env.CHECK_INTERVAL ?? "*/5 * * * *";

  await sendMessage(
    chatId,
    `✅ *${course.name}* added!\n\n` +
    `I'll check *${daysLabel}* between *${time}* (schedule: \`${interval}\`) and alert you when new slots open.\n\n` +
    `Use /list to see all monitored courses or /check to run a manual check now.`
  );
}

// ---------------------------------------------------------------------------
// Main message dispatcher
// ---------------------------------------------------------------------------

async function handleMessage(chatId: string, text: string): Promise<void> {
  const t = text.trim();

  if (t === "/help" || t === "/start") return handleHelp(chatId);
  if (t === "/list") return handleList(chatId);
  if (t === "/check") return handleCheck(chatId);
  if (t === "/test") return handleTest(chatId);
  if (t.startsWith("/remove")) return handleRemove(chatId, t.replace("/remove", ""));
  if (t === "/cancel") {
    setSession(chatId, { name: "idle" });
    await sendMessage(chatId, "Cancelled. Send a booking URL or /help to see commands.");
    return;
  }

  const session = getSession(chatId);

  if (session.name === "awaiting_name") return handleAwaitingName(chatId, t, session);
  if (session.name === "awaiting_time") return handleAwaitingTime(chatId, t, session);
  if (session.name === "awaiting_days") return handleAwaitingDays(chatId, t, session);

  // Detect booking URLs
  const isSupportedUrl =
    t.includes("foreupsoftware.com") ||
    t.includes("teeitup.golf") ||
    t.includes("teesnap.net") ||
    t.includes("chronogolf.com") ||
    t.includes("lightspeedhq.com") ||
    t.includes("lightspeedgolf.com");

  if (isSupportedUrl) {
    const urlMatch = t.match(/https?:\/\/\S+/);
    return handleUrl(chatId, urlMatch ? urlMatch[0] : t);
  }

  await sendMessage(
    chatId,
    "Not sure what to do with that. Send me a golf booking page URL to add a course, or type /help."
  );
}

// ---------------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------------

export async function startTelegramBot(): Promise<void> {
  BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
  CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";

  // TELEGRAM_ALLOWED_CHATS = comma-separated chat IDs that may use the bot.
  // If unset, the bot is open to everyone.  Set it to lock down to specific
  // users/groups, e.g.: TELEGRAM_ALLOWED_CHATS=-1001234567890,987654321
  const rawAllowed = process.env.TELEGRAM_ALLOWED_CHATS ?? "";
  ALLOWED_CHATS = rawAllowed
    ? new Set(rawAllowed.split(",").map((s) => s.trim()).filter(Boolean))
    : new Set();

  if (!BOT_TOKEN) {
    console.error("[bot] TELEGRAM_BOT_TOKEN not set — bot disabled");
    return;
  }

  console.log("[bot] Telegram bot started (long-polling)");

  if (CHAT_ID) {
    const courses = getAllCourses().filter((c) => !("_hint" in c));
    const greet =
      courses.length > 0
        ? `Bot restarted. Monitoring *${courses.length}* course(s) for newly opened weekend tee times. Use /list.`
        : `Bot started! Send me a golf booking URL and I'll alert you when tee times open up. Try /help.`;
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

        if (ALLOWED_CHATS.size > 0 && !ALLOWED_CHATS.has(chatId)) {
          await sendMessage(chatId, "Sorry, this bot is private. Ask the owner to add your chat ID.");
          continue;
        }

        await handleMessage(chatId, msg.text).catch(async (err) => {
          console.error(`[bot] handler error:`, err);
          await sendMessage(
            chatId,
            `Something went wrong: ${err instanceof Error ? err.message : String(err)}`
          ).catch(() => {});
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
