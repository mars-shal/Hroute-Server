# Draft: hrout-job-search-pipeline

## Status
`awaiting-approval`

## Intent
- **routing:** CLEAR
- **review_required:** false
- **justification:** User knows the outcome (job search pipeline with crawl→LLM→vector→match), described their architecture clearly.

## Decisions recorded
| Decision | Choice | Justification |
|----------|--------|---------------|
| Embedding provider | `@xenova/transformers` (local ONNX) | Zero cost, no API keys, privacy, self-contained |
| Vector dimension | 384 (all-MiniLM-L6-v2) | Standard, pgvector-optimized, sufficient accuracy |
| LLM extraction | Groq (via model/LLM.ts) | Already planned, fast inference, good free tier |
| Crawler | Firecrawl (already wired) | Already set up with API key |
| Database | Supabase + pgvector | Mentioned by user, well-suited |
| Cache | Redis | Mentioned by user |
| Real-time | WebSocket | Mentioned by user |
| Web framework | Express | Already in dependencies |
| Resume storage | Supabase (users table) + Redis cache | Cost-effective |

## Topology (components)
1. Seed URL curation & discovery
2. Crawler pipeline (Firecrawl → markdown)
3. LLM extraction layer (Groq → structured job objects)
4. Embedding & vector storage (Xenova → Supabase pgvector)
5. Resume intake & embedding (Xenova → Redis cache)
6. Match & ranking service (cosine similarity via pgvector)
7. WebSocket delivery (Express + ws)
8. Dedup & application state machine (Redis + Supabase)

## Pending approval
User needs to approve the approach described in the brief before plan generation.
