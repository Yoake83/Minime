import { promises as fs } from "node:fs";
import path from "node:path";

const DIR = path.resolve(process.env.DATA_DIR ?? "data");

export type Source = { id: number; title: string; url: string; date?: string };
export type Turn = {
  role: "user" | "assistant";
  text: string;
  at: string; // ISO timestamp
  sources?: Source[];
};
export type Session = { id: string; createdAt: string; turns: Turn[] };

const cache = new Map<string, Session>();
const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "default";

export async function loadSession(rawId: string): Promise<Session> {
  const id = safeId(rawId);
  const hit = cache.get(id);
  if (hit) return hit;
  let s: Session;
  try {
    s = JSON.parse(await fs.readFile(path.join(DIR, `${id}.json`), "utf8"));
  } catch {
    s = { id, createdAt: new Date().toISOString(), turns: [] };
  }
  cache.set(id, s);
  return s;
}

export async function saveSession(s: Session) {
  await fs.mkdir(DIR, { recursive: true });
  const tmp = path.join(DIR, `${s.id}.json.tmp`);
  await fs.writeFile(tmp, JSON.stringify(s));
  await fs.rename(tmp, path.join(DIR, `${s.id}.json`)); // atomic write
}

/** Every user/assistant exchange across ALL sessions whose user turn falls in [from, to). */
export async function exchangesBetween(from: Date, to: Date, excludeSession?: string) {
  await fs.mkdir(DIR, { recursive: true });
  const out: { session: string; at: string; question: string; answer?: string; sources?: Source[] }[] = [];
  for (const f of await fs.readdir(DIR)) {
    if (!f.endsWith(".json")) continue;
    const id = f.slice(0, -5);
    if (id === excludeSession) continue; // current chat is already in context
    const s = await loadSession(id);
    s.turns.forEach((t, i) => {
      const at = new Date(t.at);
      if (t.role !== "user" || at < from || at >= to) return;
      const next = s.turns[i + 1];
      out.push({
        session: id,
        at: t.at,
        question: t.text,
        answer: next?.role === "assistant" ? next.text : undefined,
        sources: next?.sources,
      });
    });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
