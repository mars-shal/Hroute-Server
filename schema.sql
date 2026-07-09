-- Enable pgvector extension (run once)
create extension if not exists vector;

-- ── Jobs (shared, no user isolation) ──────────────────────────

create table if not exists public.jobs (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  company       text not null,
  location      text,
  description   text,
  skills        jsonb default '[]'::jsonb,
  remote_status text default 'unknown',
  salary_range  text,
  apply_url     text,
  source_site   text,
  source_url    text unique not null,
  posted_date   text,
  crawled_at    timestamptz default now(),
  logo_url      text,
  created_at    timestamptz default now()
);

alter table public.jobs add column if not exists logo_url text;

-- Optional: speed up recent-jobs queries and source_url lookups
create index if not exists jobs_crawled_at_idx on public.jobs (crawled_at desc);
create index if not exists jobs_source_url_idx on public.jobs (source_url);

alter table public.jobs enable row level security;

drop policy if exists "jobs_select_all" on public.jobs;
create policy "jobs_select_all"
  on public.jobs for select
  to authenticated
  using (true);

drop policy if exists "jobs_insert_server" on public.jobs;
create policy "jobs_insert_server"
  on public.jobs for insert
  to authenticated
  with check (true);

-- ── Job vectors (one vector per job, 384-dim) ─────────────────

create table if not exists public.job_vectors (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid unique not null references public.jobs(id) on delete cascade,
  embedding  vector(384) not null,
  created_at timestamptz default now()
);

-- HNSW index for fast cosine-similarity search
create index if not exists job_vectors_embedding_hnsw_idx
  on public.job_vectors
  using hnsw (embedding vector_cosine_ops);

-- ── Applications (per-user) ──────────────────────────────────

create table if not exists public.applications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  job_id     uuid not null references public.jobs(id) on delete cascade,
  status     text not null default 'saved',
  notes      text,
  deadline   timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, job_id)
);

alter table public.applications enable row level security;

drop policy if exists "applications_own" on public.applications;
create policy "applications_own"
  on public.applications for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ── Profiles ────────────────────────────────────────────────

create table if not exists public.profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  display_name      text,
  headline          text,
  location          text,
  avatar_url        text,
  timezone          text,
  skills            jsonb default '[]'::jsonb,
  resume_text       text,
  resume_embedding  vector(384),
  created_at        timestamptz default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles_own" on public.profiles;
create policy "profiles_own"
  on public.profiles for all
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- ── Vector search function ───────────────────────────────────

drop function if exists public.match_jobs;

create function public.match_jobs (
  query_embedding vector(384),
  match_threshold float,
  match_count int
)
returns table (
  id uuid,
  title text,
  company text,
  location text,
  description text,
  skills jsonb,
  remote_status text,
  salary_range text,
  apply_url text,
  source_site text,
  posted_date text,
  logo_url text,
  crawled_at timestamptz,
  similarity float
)
language sql stable
as $$
  select
    j.id,
    j.title,
    j.company,
    j.location,
    j.description,
    j.skills,
    j.remote_status,
    j.salary_range,
    j.apply_url,
    j.source_site,
    j.posted_date,
    j.logo_url,
    j.crawled_at,
    (1 - (jv.embedding <=> query_embedding))::float as similarity
  from public.job_vectors jv
  join public.jobs j on j.id = jv.job_id
  where (1 - (jv.embedding <=> query_embedding)) > match_threshold
  order by (1 - (jv.embedding <=> query_embedding)) desc
  limit least(match_count, 200);
$$;
