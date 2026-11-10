import type { Source } from "./store.js";
export type { Source };

export type SearchArgs = {
  query: string;
  topic?: "general" | "news";
  published_after?: string; // YYYY-MM-DD
  published_before?: string;
};
export type SearchHit = { title: string; url: string; content: string; date?: string };

const TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; hits: SearchHit[] }>();

async function once(args: SearchArgs, signal: AbortSignal): Promise<SearchHit[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
    body: JSON.stringify({
      query: args.query.slice(0, 380),
      topic: args.topic ?? "general",
      search_depth: "basic",
      max_results: 5,
      start_date: args.published_after,
      end_date: args.published_before,
    }),
  });
  if (!res.ok) throw new Error(`search ${res.status}`);
  const j: any = await res.json();
  return (j.results ?? []).map((r: any) => ({
    title: r.title, url: r.url, date: r.published_date, content: String(r.content ?? "").slice(0, 450),
  }));
}

/** Cached, time-boxed, retried once. Never throws past the agent: failure becomes a tool error the model can reason about. */
export async function webSearch(args: SearchArgs): Promise<SearchHit[]> {
  const key = JSON.stringify(args);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.hits;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const hits = await once(args, ctl.signal);
      cache.set(key, { at: Date.now(), hits });
      return hits;
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}