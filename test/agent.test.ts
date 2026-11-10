import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

process.env.GROQ_API_KEY = "offline-test";
process.env.LLM_BASE_URL = "https://model.example/v1";
const dir = await mkdtemp(path.join(process.cwd(), ".test-agent-"));
process.env.DATA_DIR = dir;

test("agent caps parallel searches, forces completion, validates citations and persists evidence", async () => {
  const original = globalThis.fetch;
  let modelCalls = 0; let searches = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("tavily")) {
      searches++;
      return new Response(JSON.stringify({ results: [{ title: "Official pricing", url: "https://vendor.example/pricing", raw_content: "$20 per seat per month" }] }));
    }
    const body = JSON.parse(String(init?.body));
    modelCalls++;
    const delta = modelCalls === 1
      ? { tool_calls: Array.from({ length: 14 }, (_, i) => ({ index: i, id: `call_${i}`, type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: `Vendor ${i} pricing` }) } })) }
      : { content: "Price is $20 [1]. Unsupported claim [999]." };
    if (modelCalls === 2) {
      assert.equal(body.tools, undefined);
      assert.equal(body.messages.filter((m: any) => m.role === "tool").length, 14);
    }
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  };
  try {
    const { runAgent } = await import("../src/agent.js");
    const events: any[] = [];
    const result = await runAgent({ sessionId: `${"a".repeat(32)}_test`, history: [], message: "Check vendor prices", emit: e => events.push(e) });
    assert.equal(searches, 12);
    assert.equal(modelCalls, 2);
    assert.match(result.text, /\[source unavailable\]/);
    assert.doesNotMatch(result.text, /\[999\]/);
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].evidence, "$20 per seat per month");
    assert.equal(events.filter(e => e.type === "delta").length, 1);
  } finally { globalThis.fetch = original; await rm(dir, { recursive: true, force: true }); }
});
