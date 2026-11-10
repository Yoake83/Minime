import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = await mkdtemp(path.join(process.cwd(), ".test-data-"));
process.env.DATA_DIR = dir;
process.env.TZ = "Asia/Kolkata";
const { loadSession, saveSession, recall } = await import("../src/store.js");
const { temporalContext, isoDay } = await import("../src/temporal.js");
const { webSearch } = await import("../src/search.js");

test("topic recall preserves corrections and isolates browser owners and legacy logs", async () => {
  const owner = "a".repeat(32);
  for (const id of [`${owner}_old`, `${"b".repeat(32)}_private`, "legacy"]) {
    const s = await loadSession(id);
    s.turns = [
      { role: "user", text: "Shortlist CRM Alpha and Beta", at: "2026-11-02T10:00:00Z" },
      { role: "assistant", text: "Alpha and Beta shortlisted", at: "2026-11-02T10:01:00Z" },
      { role: "user", text: "Replace Beta with Gamma", at: "2026-11-03T10:00:00Z" },
      { role: "assistant", text: "Updated to Alpha and Gamma", at: "2026-11-03T10:01:00Z" },
    ];
    await saveSession(s);
  }
  const found = await recall("our CRM shortlist", [], at => isoDay(new Date(at)), `${owner}_new`);
  assert.equal(found.length, 2);
  assert.ok(found.every(r => r.session === `${owner}_old`));
  assert.match(found[1].question, /Replace Beta/);
  const dated = await temporalContext("What did I ask on 3 November?", new Date("2026-11-10T10:00:00Z"), `${owner}_new`);
  assert.equal(dated.resolved[0].date, "2026-11-03");
  assert.ok(dated.recalled.some(r => /Replace/.test(r.question)));
  assert.equal(isoDay(new Date("2026-11-02T20:00:00Z")), "2026-11-03");
});

test("search preserves page evidence, snippet fallback, retrieval time and aborts", async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (_input, init) => {
    requests++;
    assert.equal(JSON.parse(String(init?.body)).include_raw_content, true);
    return new Response(JSON.stringify({ results: [
      { title: "Pricing", url: "https://example.com/pricing", content: "short", raw_content: "Full pricing evidence" },
      { title: "News", url: "https://example.com/news", content: "Only snippet", published_date: "2026-11-03" },
    ] }));
  };
  try {
    const hits = await webSearch({ query: "pricing test" });
    assert.equal(hits[0].content, "Full pricing evidence");
    assert.equal(hits[0].contentKind, "page");
    assert.equal(hits[1].contentKind, "snippet");
    assert.ok(Date.parse(hits[0].retrievedAt));
    await webSearch({ query: "pricing test" });
    assert.equal(requests, 1);
    await assert.rejects(webSearch({ query: "aborted" }, AbortSignal.abort()));
    globalThis.fetch = async () => { throw new Error("offline"); };
    await assert.rejects(webSearch({ query: "failure" }), /offline/);
  } finally { globalThis.fetch = original; await rm(dir, { recursive: true, force: true }); }
});
