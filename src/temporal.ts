import * as chrono from "chrono-node";
import { exchangesBetween } from "./store.js";

export const TZ = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

export const fmtDate = (d: Date | string) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: TZ }).format(new Date(d));
export const fmtDateTime = (d: Date | string) =>
  new Intl.DateTimeFormat("en-GB", {
    weekday: "short", day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", timeZone: TZ,
  }).format(new Date(d));
export const isoDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d); // YYYY-MM-DD

/**
 * Deterministic pre-step (no LLM call, ~0 ms): resolve "3 November", "last Tuesday", "yesterday"...
 * to absolute dates, then pull what was said on those days from the persistent log.
 * Models are bad at calendar arithmetic and cannot search their own history with a web-only tool,
 * so the harness does both.
 */
export async function temporalContext(message: string, now: Date, currentSession: string) {
  const parsed = chrono.parse(message, { instant: now, timezone: TZ }, { forwardDate: false });
  const resolved: { phrase: string; date: string }[] = [];
  const recalled: Awaited<ReturnType<typeof exchangesBetween>> = [];
  const seen = new Set<string>();

  for (const r of parsed) {
    const start = r.start.date();
    if (start > now) continue; // only the past is recallable
    const day = isoDay(start);
    if (seen.has(day)) continue;
    seen.add(day);
    resolved.push({ phrase: r.text, date: day });
    const from = new Date(start); from.setHours(0, 0, 0, 0);
    const to = new Date(from); to.setDate(to.getDate() + 1);
    recalled.push(...(await exchangesBetween(from, to, currentSession)));
  }
  return { resolved, recalled: recalled.slice(-6) };
}
