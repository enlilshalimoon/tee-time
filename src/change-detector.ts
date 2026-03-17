/**
 * Change detector — tracks which tee times were seen in the last check
 * and surfaces only *newly appeared* slots.
 *
 * State is persisted to state.json so restarts don't flood with old alerts.
 * Format:
 *   {
 *     "Course Name|2026-03-29": ["07:00", "08:30", "10:00"],
 *     ...
 *   }
 */

import fs from "fs";
import path from "path";
import { CourseResult, TeeTime } from "./types";

const STATE_PATH = path.resolve(process.cwd(), "state.json");

type StateMap = Record<string, string[]>; // key -> sorted array of HH:MM times

function readState(): StateMap {
  try {
    if (fs.existsSync(STATE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")) as StateMap;
    }
  } catch {
    // corrupt file — start fresh
  }
  return {};
}

function writeState(state: StateMap): void {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    console.error("[state] Failed to write state.json:", err);
  }
}

function stateKey(courseName: string, date: string): string {
  return `${courseName}|${date}`;
}

/**
 * Given all current check results, returns only the tee times that are
 * NEWLY available since the last call to this function.
 *
 * Also updates state.json to reflect current availability.
 */
export function filterNewlyOpened(results: CourseResult[]): CourseResult[] {
  const state = readState();
  const nextState: StateMap = { ...state };
  const newResults: CourseResult[] = [];

  for (const result of results) {
    const key = stateKey(result.course.name, result.date);
    const previousTimes = new Set<string>(state[key] ?? []);
    const currentTimes = result.teeTimes.map((t) => t.time);

    // Slots that exist now but didn't before → newly opened
    const newSlots: TeeTime[] = result.teeTimes.filter(
      (t) => !previousTimes.has(t.time)
    );

    // Update state to current snapshot (includes all currently available times)
    nextState[key] = currentTimes;

    if (newSlots.length > 0) {
      newResults.push({ ...result, teeTimes: newSlots });
      console.log(
        `[change] ${result.course.name} on ${result.date}: ${newSlots.length} newly opened slot(s): ${newSlots.map((t) => t.time).join(", ")}`
      );
    }
  }

  // Prune stale keys (dates more than 60 days in the past)
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 60);
  for (const key of Object.keys(nextState)) {
    const datePart = key.split("|")[1];
    if (datePart && new Date(datePart) < cutoff) {
      delete nextState[key];
    }
  }

  writeState(nextState);
  return newResults;
}
