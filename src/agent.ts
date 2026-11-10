import OpenAI from "openai";
import { webSearch, type SearchArgs } from "./search.js";
import { SYSTEM_PROMPT, dynamicContext } from "./prompt.js";
import { fmtDateTime, temporalContext } from "./temporal.js";
import type { Source, Turn } from "./store.js";

// Any OpenAI-compatible endpoint works; defaults to Groq.
const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1",
});
const MODEL = process.env.MODEL ?? "openai/gpt-oss-120b";
const MAX_ROUNDS = 4;
const MAX_SEARCHES = 12; // independent cap on admitted searches

export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "delta"; text: string }
  | { type: "sources"; sources: Source[] };

type Msg = OpenAI.Chat.ChatCompletionMessageParam;

const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web. Returns up to 5 results with title, url, publication/retrieval dates and extracted page text (snippet fallback). Call it several times in parallel for several entities.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Short, specific query. One entity or one question per call." },
          topic: { type: "string", enum: ["general", "news"] },
          published_after: { type: "string", description: "YYYY-MM-DD. Only results published on/after this date. Use for dated announcements; omit for current pricing/docs." },
          published_before: { type: "string", description: "YYYY-MM-DD upper bound." },
        },
        required: ["query"],
      },
    },
  },
];

const NUDGE: Msg = {
  role: "user",
  content: "[system] Search budget used up. Answer now from the results above, cite sources as [n], and say plainly what you could not verify. Do not call any tool.",
};

/** One streamed model call. withTools=false is used for the final, answer-only round. */
async function streamRound(messages: Msg[], withTools: boolean, emit: (e: AgentEvent) => void, signal: AbortSignal) {
  const stream = await client.chat.completions.create({
    model: MODEL,
    messages,
    ...(withTools ? { tools: TOOLS, tool_choice: "auto" as const } : {}),
    temperature: 0.3,
    max_completion_tokens: 2048,
    stream: true,
  }, { signal, maxRetries: 0 });
  let content = "";
  const calls: { id: string; name: string; args: string }[] = [];
  for await (const chunk of stream) {
    const d = chunk.choices[0]?.delta;
    if (d?.content) {
      content += d.content;
      // Buffer until citations are validated and the round is known to be final.
    }
    for (const tc of d?.tool_calls ?? []) {
      const c = (calls[tc.index] ??= { id: "", name: "", args: "" });
      if (tc.id) c.id = tc.id;
      if (tc.function?.name) c.name += tc.function.name;
      if (tc.function?.arguments) c.args += tc.function.arguments;
    }
  }
  return { content, calls };
}

function toMessages(history: Turn[], message: string, now: Date, system: string): Msg[] {
  const msgs: Msg[] = [{ role: "system", content: system }];
  const push = (role: "user" | "assistant", text: string) => {
    const last = msgs[msgs.length - 1];
    if (last.role === role) last.content = `${last.content}\n\n${text}`; // keep strict alternation
    else msgs.push({ role, content: text });
  };
  for (const t of history) push(t.role, t.role === "user" ? `[sent ${fmtDateTime(t.at)}] ${t.text}` : t.text);
  push("user", `[sent ${fmtDateTime(now)}] ${message}`);
  return msgs;
}

export async function runAgent(opts: {
  sessionId: string;
  history: Turn[];
  message: string;
  emit: (e: AgentEvent) => void;
}): Promise<{ text: string; sources: Source[] }> {
  const { emit } = opts;
  const now = new Date();
  const signal = AbortSignal.timeout(60_000);
  let searchCount = 0;
  const { resolved, recalled } = await temporalContext(opts.message, now, opts.sessionId);
  if (recalled.length) emit({ type: "status", text: "Recalling earlier conversation" });

  // Static prompt first, per-request context last, so provider-side prefix caching can hit.
  const system = `${SYSTEM_PROMPT}\n\n${dynamicContext(now, resolved, recalled)}`;
  const messages = toMessages(opts.history, opts.message, now, system);

  const sources: Source[] = [];
  const byUrl = new Map<string, number>();
  let finalText = "";

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const last = round === MAX_ROUNDS - 1 || searchCount >= MAX_SEARCHES || Date.now() - now.getTime() > 40_000;
    let r;
    try {
      r = await streamRound(last ? [...messages, NUDGE] : messages, !last, emit, signal);
    } catch (e: any) {
      // Model emitted a malformed/forbidden tool call: don't crash, make it answer with what it has.
      if (e?.code === "tool_use_failed" && !last) r = await streamRound([...messages, NUDGE], false, emit, signal);
      else throw e;
    }
    const { content, calls } = r;

    if (!calls.length) {
      finalText = content;
      break;
    }
    messages.push({
      role: "assistant",
      content: content || null,
      tool_calls: calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.args } })),
    });

    const parsed = calls.map((c) => {
      try {
        const a = JSON.parse(c.args || "{}");
        if (c.name !== "web_search" || typeof a.query !== "string" || !a.query.trim()) return null;
        if (a.topic !== undefined && !["general", "news"].includes(a.topic)) return null;
        for (const field of ["published_after", "published_before"]) {
          if (a[field] !== undefined && (typeof a[field] !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(a[field]) || !Number.isFinite(Date.parse(a[field])))) return null;
        }
        return a as SearchArgs;
      } catch { return null; }
    });
    emit({ type: "status", text: `Searching: ${parsed.map((a) => a?.query ?? "…").join(" · ")}` });

    // Parallel fan-out. Source ids are assigned after all results land, in call order, so numbering is deterministic.
    const settled = await Promise.allSettled(parsed.map((a) => {
      if (!a || searchCount >= MAX_SEARCHES) return Promise.reject(new Error("Invalid arguments or search budget exhausted"));
      searchCount++;
      return webSearch(a, signal);
    }));
    calls.forEach((c, i) => {
      const r = settled[i];
      let out: string;
      if (r.status === "rejected") {
        out = "Error: search failed or timed out. Retry once with a different query, or say you could not verify.";
      } else {
        const lines = r.value.map((h) => {
          let id = byUrl.get(h.url);
          if (!id) {
            id = sources.length + 1;
            byUrl.set(h.url, id);
            sources.push({ id, title: h.title, url: h.url, date: h.date, retrievedAt: h.retrievedAt, evidence: h.content, contentKind: h.contentKind });
          }
          const source = sources[id - 1];
          Object.assign(source, { retrievedAt: h.retrievedAt, evidence: h.content, contentKind: h.contentKind, date: h.date });
          return JSON.stringify({ id, ...h });
        });
        out = lines.length
          ? `<search_results untrusted="true">\n${lines.join("\n\n")}\n</search_results>`
          : "No results. Try broader terms or drop the date filter.";
      }
      messages.push({ role: "tool", tool_call_id: c.id, content: out });
    });
  }

  if (!finalText.trim()) throw new Error("Model returned no final answer");
  const validIds = new Set(sources.map(s => s.id));
  let invalid = false;
  finalText = finalText.replace(/\[(\d+)\]/g, (citation, id) => {
    if (validIds.has(Number(id))) return citation;
    invalid = true; return "[source unavailable]";
  });
  if (invalid) finalText += "\n\nSome citations could not be validated; those claims need verification.";
  emit({ type: "delta", text: finalText });
  // Only ship sources the answer actually cites.
  const cited = sources.filter((s) => finalText.includes(`[${s.id}]`));
  emit({ type: "sources", sources: cited });
  return { text: finalText, sources: cited };
}