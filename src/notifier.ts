import nodemailer from "nodemailer";
import { CourseResult, TeeTime } from "./types";

function formatTeeTime(tt: TeeTime): string {
  const parts = [`${tt.time} — ${tt.players} player spot(s), ${tt.holes} holes`];
  if (tt.price !== undefined) parts.push(`$${tt.price.toFixed(2)}`);
  if (tt.bookingUrl) parts.push(`<a href="${tt.bookingUrl}">Book now</a>`);
  return parts.join(" | ");
}

function buildEmailBody(results: CourseResult[]): { text: string; html: string } {
  const lines: string[] = [];
  const htmlLines: string[] = [
    "<html><body>",
    "<h2 style='color:#2d6a2d'>⛳ Golf Tee Times Available</h2>",
  ];

  for (const result of results) {
    const header = `${result.course.name} — ${result.date} (${result.teeTimes.length} slot(s))`;
    lines.push(`\n${header}`);
    lines.push("=".repeat(header.length));
    htmlLines.push(`<h3>${result.course.name} — ${result.date}</h3><ul>`);

    for (const tt of result.teeTimes) {
      const plain = `  ${tt.time}  |  ${tt.players} spots  |  ${tt.holes}h` +
        (tt.price !== undefined ? `  |  $${tt.price.toFixed(2)}` : "") +
        (tt.bookingUrl ? `  |  ${tt.bookingUrl}` : "");
      lines.push(plain);

      const html = `<li>${formatTeeTime(tt)}</li>`;
      htmlLines.push(html);
    }

    htmlLines.push("</ul>");
  }

  htmlLines.push("<p style='color:#888;font-size:12px'>Sent by tee-time-bot</p></body></html>");

  return {
    text: lines.join("\n"),
    html: htmlLines.join("\n"),
  };
}

function buildSubject(results: CourseResult[]): string {
  const totalSlots = results.reduce((n, r) => n + r.teeTimes.length, 0);
  const courseNames = results.map((r) => r.course.name).join(", ");
  return `[Tee Time Alert] ${totalSlots} slot(s) at ${courseNames}`;
}

export async function sendNotification(results: CourseResult[]): Promise<void> {
  if (results.length === 0) return;

  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST ?? "smtp.gmail.com",
    port: parseInt(process.env.EMAIL_PORT ?? "587", 10),
    secure: process.env.EMAIL_SECURE === "true",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  const { text, html } = buildEmailBody(results);

  await transporter.sendMail({
    from: process.env.EMAIL_FROM ?? process.env.EMAIL_USER,
    to: process.env.EMAIL_TO,
    subject: buildSubject(results),
    text,
    html,
  });

  console.log(`[notifier] Email sent to ${process.env.EMAIL_TO}`);
}
