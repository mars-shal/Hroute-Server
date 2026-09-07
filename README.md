# hrout_server

Job discovery + resume matching server (Bun + Express).

## Free / open-source stack

The pipeline is designed to run end-to-end at zero cost. Every provider has a
free default, and paid upgrades are opt-in via env vars.

| Layer | Free default | Paid opt-in |
|---|---|---|
| LLM | Groq free tier — open-weight models (`qwen/qwen3.8-27b` etc.) | Groq paid tier |
| LLM fallback (optional) | Ollama (local) if `OLLAMA_BASE_URL` is set; Google Gemini free tier via `GOOGLE_API_KEY` | — |
| Job discovery | `miniCrawler` (self-hosted axios+cheerio, robots.txt-aware) + free public feed APIs (RemoteOK, Remotive, WWR) | Firecrawl via `CRAWLER_MODE=auto\|firecrawl` |
| Embeddings | `Xenova/all-MiniLM-L6-v2` runs locally (transformers.js) | — |
| Cache/sessions | Upstash free tier; in-memory fallback with circuit breaker if unreachable | Upstash paid |
| DB | Supabase free tier | — |
| PDF | Puppeteer + @sparticuz/chromium (local) | — |

### LLM configuration

```bash
# Default (free tier): Groq open models — https://groq.com
GROQ_API_KEY=...
# LLM_PRIMARY_MODEL=qwen/qwen3.8-27b   (default; llama-3.3-70b was decommissioned upstream)
# LLM_FAST_MODEL=qwen/qwen3.8-27b
```

Precedence: Groq (with model fallback chain) → Google Gemini (free tier).

Optional: if you ever want fully-local inference, set `OLLAMA_BASE_URL`
(e.g. `http://127.0.0.1:11434`, model via `OLLAMA_MODEL`, default
`llama3.1:8b`) and it takes precedence over Groq. Leave it unset and
nothing runs locally.

### Crawler configuration

```bash
CRAWLER_MODE=mini       # default: self-hosted crawler, zero credits
# CRAWLER_MODE=auto     # Firecrawl first, mini crawler as free fallback
# CRAWLER_MODE=firecrawl
MINI_CRAWLER_CONCURRENCY=3
MINI_CRAWLER_DELAY_MS=1000
MINI_CRAWLER_MAX_LINKS=30
SCRAPE_CONCURRENCY=3
SCRAPE_DELAY_MS=250
DISCOVER_SEED_DELAY_MS=1500
```

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```
