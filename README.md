# Chat agent with web search

```bash
npm install
cp .env.example .env   # add GROQ_API_KEY and TAVILY_API_KEY
npm run dev            # http://localhost:3000
```
Architecture and trade-offs: see [DESIGN.md](DESIGN.md).

Memory is scoped to a server-issued browser cookie across that browser’s chats. Clearing cookies loses access; this is a demo identity, not account authentication. Legacy unscoped logs are not imported automatically. Set TZ for the intended calendar timezone.

Run `npm test` and `npm run typecheck` for offline checks. Real model/search quality still needs API-backed evaluation.
