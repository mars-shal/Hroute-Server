-- Add experience_level column to jobs table
-- Used by feed-based job ingestion to classify entry/mid/senior level positions

alter table public.jobs add column if not exists experience_level text default 'unspecified';

-- Update match_jobs function to include experience_level in results
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
  experience_level text,
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
    j.experience_level,
    j.crawled_at,
    (1 - (jv.embedding <=> query_embedding))::float as similarity
  from public.job_vectors jv
  join public.jobs j on j.id = jv.job_id
  where (1 - (jv.embedding <=> query_embedding)) > match_threshold
  order by (1 - (jv.embedding <=> query_embedding)) desc
  limit least(match_count, 200);
$$;
