import "dotenv/config";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "./agent.js";
import { loadSession, saveSession } from "./store.js";

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

for (const k of ["GROQ_API_KEY", "TAVILY_API_KEY"])
  if (!process.env[k]) console.warn(`⚠ ${k} is not set (see .env.example)`);

const readBody = (req: http.IncomingMessage) =>
  new Promise<string>((res, rej) => {
    let b = "";
    req.on("data", (c) => ((b += c), b.length > 1e5 && req.destroy()));
    req.on("end", () => res(b));
    req.on("error", rej);
  });

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");

      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(await readFile(path.join(PUBLIC, "index.html")));
      }

      if (req.method === "GET" && url.pathname === "/api/history") {
        const s = await loadSession(url.searchParams.get("session") ?? "default");
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(s.turns));
      }

      if (req.method === "POST" && url.pathname === "/api/chat") {
        const { sessionId, message } = JSON.parse(await readBody(req));
        if (typeof message !== "string" || !message.trim()) {
          res.writeHead(400);
          return res.end();
        }
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);

        const session = await loadSession(String(sessionId ?? "default"));
        const asked = new Date().toISOString();
        try {
          const out = await runAgent({ sessionId: session.id, history: session.turns, message, emit: send });
          session.turns.push({ role: "user", text: message, at: asked });
          session.turns.push({ role: "assistant", text: out.text, at: new Date().toISOString(), sources: out.sources });
          await saveSession(session);
          send({ type: "done" });
        } catch (e) {
          console.error(e);
          session.turns.push({ role: "user", text: message, at: asked });
          await saveSession(session);
          const limited = (e as any)?.status === 429 || (e as any)?.code === "rate_limit_exceeded";
          send({ type: "error", text: limited ? "Hit the model's rate limit. Wait about a minute and try again." : "Something went wrong on my side. Please try again." });
        }
        return res.end();
      }

      res.writeHead(404);
      res.end();
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  })
  .listen(PORT, () => console.log(`Chat agent on http://localhost:${PORT}`));