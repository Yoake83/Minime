import { promises as fs } from "node:fs";
import path from "node:path";

const DIR = path.resolve(process.env.DATA_DIR ?? "data");

export type Source = { id: number; title: string; url: string; date?: string; retrievedAt?: string; evidence?: string; contentKind?: string };
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

/** Bounded lexical recall with adjacent exchanges; scope is a server-issued browser namespace. */
export async function recall(message: string, days: string[], dayOf: (at: string) => string, currentSession: string) {
  await fs.mkdir(DIR, { recursive: true });
  const scope = currentSession.split("_")[0];
  if (!/^[a-f0-9]{32}$/.test(scope)) return []; // never mix legacy unowned logs
  const stop = new Set("what did ask you about has any them changed since last on the for with today still correct pricing shipped something big we our earlier".split(" "));
  const words = [...new Set(message.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter(w => w.length > 2 && !stop.has(w));
  const candidates: { session: string; at: string; question: string; answer?: string; sources?: Source[]; score: number }[] = [];
  for (const f of await fs.readdir(DIR)) {
    if (!f.startsWith(`${scope}_`) || !f.endsWith(".json")) continue;
    const session = await loadSession(f.slice(0, -5));
    session.turns.forEach((t, i) => {
      if (t.role !== "user") return;
      const next = session.turns[i + 1];
      const text = `${t.text} ${next?.role === "assistant" ? next.text : ""}`.toLowerCase();
      const lexical = words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
      const dated = days.includes(dayOf(t.at));
      if (!dated && !lexical) return;
      // Neighboring turns preserve shortlist corrections and follow-up context.
      for (const j of [i - 2, i, i + 2]) {
        const q = session.turns[j]; const a = session.turns[j + 1];
        if (q?.role !== "user") continue;
        candidates.push({ session: session.id, at: q.at, question: q.text, answer: a?.role === "assistant" ? a.text : undefined, sources: a?.sources, score: lexical + (dated ? 10 : 0) - (j === i ? 0 : 1) });
      }
    });
  }
  const seen = new Set<string>();
  return candidates.sort((a,b) => b.score - a.score || b.at.localeCompare(a.at)).filter(r => {
    const key = `${r.session}:${r.at}:${r.question}`;
    if (seen.has(key)) return false; seen.add(key); return true;
  }).slice(0, 12).sort((a,b) => a.at.localeCompare(b.at));
}
