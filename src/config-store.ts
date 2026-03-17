/**
 * Dynamic config store — reads and writes config.json at runtime.
 * Courses added via Telegram are persisted to disk immediately.
 */

import fs from "fs";
import path from "path";
import { CourseConfig } from "./types";

const CONFIG_PATH = path.resolve(process.cwd(), "config.json");

function readConfig(): { courses: CourseConfig[] } {
  if (!fs.existsSync(CONFIG_PATH)) return { courses: [] };
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw) as { courses: CourseConfig[] };
}

function writeConfig(data: { courses: CourseConfig[] }): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), "utf-8");
}

export function getAllCourses(): CourseConfig[] {
  return readConfig().courses.filter((c) => !("_hint" in c)); // strip placeholder entries
}

export function addCourse(course: CourseConfig): void {
  const data = readConfig();
  // Remove placeholder hints and any existing entry with the same name
  data.courses = data.courses
    .filter((c) => !("_hint" in c))
    .filter((c) => c.name !== course.name);
  data.courses.push(course);
  writeConfig(data);
}

export function removeCourse(name: string): boolean {
  const data = readConfig();
  const before = data.courses.length;
  data.courses = data.courses.filter(
    (c) => c.name.toLowerCase() !== name.toLowerCase()
  );
  if (data.courses.length === before) return false;
  writeConfig(data);
  return true;
}

export function updateCourseByIndex(
  idx: number,
  updates: Partial<Pick<CourseConfig, "name" | "earliestTime" | "latestTime" | "daysOfWeek">>
): CourseConfig | null {
  const data = readConfig();
  const real = data.courses.filter((c) => !("_hint" in c));
  if (idx < 0 || idx >= real.length) return null;
  const target = real[idx];
  const i = data.courses.findIndex((c) => c.name === target.name);
  if (i === -1) return null;

  // Apply updates: undefined means "remove the field", supplied value means "set it"
  const updated = { ...data.courses[i], ...updates };
  if (updates.earliestTime === undefined) delete updated.earliestTime;
  if (updates.latestTime === undefined) delete updated.latestTime;
  if (updates.daysOfWeek === undefined) delete updated.daysOfWeek;

  data.courses[i] = updated;
  writeConfig(data);
  return updated;
}

export function removeCourseByIndex(idx: number): CourseConfig | null {
  const data = readConfig();
  const real = data.courses.filter((c) => !("_hint" in c));
  if (idx < 0 || idx >= real.length) return null;
  const removed = real[idx];
  data.courses = data.courses.filter((c) => c.name !== removed.name);
  writeConfig(data);
  return removed;
}
