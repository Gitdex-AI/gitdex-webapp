-- GitDex V1 schema (PRD section 8).
--
-- Access model: every table has row level security enabled and NO policies, so
-- nothing is reachable through PostgREST with the anon/authenticated keys. All
-- reads and writes go through the `api` Edge Function, which connects directly
-- to Postgres and enforces auth, validation, rate limits and audit in one place
-- (shared by the REST and MCP adapters).

create or replace function public.gitdex_id(prefix text) returns text
language sql volatile as $$
  select prefix || '_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 14)
$$;

-- users ---------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  auth_provider text not null default 'email',
  status text not null default 'active' check (status in ('active', 'suspended')),
  is_admin boolean not null default false,
  notification_preferences jsonb not null default '{"in_app": true, "email": false}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.api_tokens (
  id text primary key default public.gitdex_id('tok'),
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  token_prefix text not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index api_tokens_user_idx on public.api_tokens (user_id);

-- software ------------------------------------------------------------------

create table public.software (
  id text primary key default public.gitdex_id('sw'),
  slug text not null unique,
  name text not null,
  canonical_url text not null,
  -- normalized host+path used for de-duplication
  url_key text not null unique,
  repository_url text,
  repo_key text unique,
  description text not null,
  capabilities text[] not null default '{}',
  platforms text[] not null default '{}',
  pricing_type text not null default 'unknown'
    check (pricing_type in ('free', 'freemium', 'paid', 'subscription', 'open_source', 'unknown')),
  pricing_notes text,
  license text,
  category text[] not null default '{}',
  source_refs jsonb not null default '[]'::jsonb,
  submitted_by uuid not null references public.profiles (id),
  submitted_via text,
  -- 'unreviewed' is the default for every submission: an agent or creator
  -- submitting a record never counts as independent verification.
  review_status text not null default 'unreviewed'
    check (review_status in ('unreviewed', 'reviewed', 'flagged', 'removed')),
  search_text text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index software_created_idx on public.software (created_at desc);
create index software_platforms_idx on public.software using gin (platforms);
create index software_category_idx on public.software using gin (category);
create index software_submitted_by_idx on public.software (submitted_by);

-- requests ------------------------------------------------------------------

create table public.requests (
  id text primary key default public.gitdex_id('req'),
  owner_user_id uuid not null references public.profiles (id),
  title text not null,
  goal text not null,
  must_have text[] not null default '{}',
  nice_to_have text[] not null default '{}',
  platforms text[] not null default '{}',
  price_constraint text,
  other_constraints text[] not null default '{}',
  status text not null default 'open'
    check (status in ('open', 'proposals_available', 'resolved', 'closed', 'removed')),
  visibility text not null default 'public' check (visibility in ('public', 'private')),
  resolved_proposal_id text,
  created_via text,
  search_text text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index requests_created_idx on public.requests (created_at desc);
create index requests_status_idx on public.requests (status);
create index requests_owner_idx on public.requests (owner_user_id);
create index requests_platforms_idx on public.requests using gin (platforms);

create table public.interests (
  id text primary key default public.gitdex_id('int'),
  user_id uuid not null references public.profiles (id) on delete cascade,
  request_id text not null references public.requests (id) on delete cascade,
  notifications_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, request_id)
);
create index interests_request_idx on public.interests (request_id);

-- solutions -----------------------------------------------------------------

create table public.solution_proposals (
  id text primary key default public.gitdex_id('sol'),
  request_id text not null references public.requests (id) on delete cascade,
  software_id text not null references public.software (id) on delete cascade,
  proposed_by uuid not null references public.profiles (id),
  coverage_notes text not null,
  unmet_requirements text[] not null default '{}',
  evidence_refs jsonb not null default '[]'::jsonb,
  -- Proposal status is independent of request status: "creator submitted"
  -- must never mean "request resolved".
  status text not null default 'proposed'
    check (status in ('proposed', 'accepted', 'rejected', 'withdrawn')),
  proposed_via text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index solution_proposals_active_uniq
  on public.solution_proposals (request_id, software_id) where status <> 'withdrawn';
create index solution_proposals_request_idx on public.solution_proposals (request_id);
create index solution_proposals_software_idx on public.solution_proposals (software_id);
create index solution_proposals_proposer_idx on public.solution_proposals (proposed_by);

alter table public.requests
  add constraint requests_resolved_proposal_fk
  foreign key (resolved_proposal_id) references public.solution_proposals (id) on delete set null;

create table public.acceptance_feedback (
  id text primary key default public.gitdex_id('fb'),
  proposal_id text not null references public.solution_proposals (id) on delete cascade,
  request_id text not null references public.requests (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  verdict text not null check (verdict in ('accepted', 'partial', 'rejected')),
  feedback text,
  -- true when given by the original requester; only that feedback can move
  -- proposal/request status. Supporter feedback is recorded individually.
  is_owner boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (proposal_id, user_id)
);
create index acceptance_feedback_request_idx on public.acceptance_feedback (request_id);

create table public.evidence (
  id text primary key default public.gitdex_id('ev'),
  entity_type text not null check (entity_type in ('software', 'solution')),
  entity_id text not null,
  claim text not null,
  source_url text,
  source_type text not null default 'other',
  observed_at timestamptz,
  -- 'tested' requires an independent test record and cannot be set by a
  -- submitter through the public API.
  verification_level text not null default 'claimed'
    check (verification_level in ('claimed', 'documented', 'tested', 'unknown')),
  last_checked_at timestamptz,
  submitted_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index evidence_entity_idx on public.evidence (entity_type, entity_id);

-- governance ----------------------------------------------------------------

create table public.audit_events (
  id bigint generated always as identity primary key,
  actor_user_id uuid,
  client_id text,
  event_type text not null,
  entity_type text,
  entity_id text,
  summary text not null,
  created_at timestamptz not null default now()
);
create index audit_events_entity_idx on public.audit_events (entity_type, entity_id);
create index audit_events_actor_idx on public.audit_events (actor_user_id, created_at desc);

create table public.notifications (
  id text primary key default public.gitdex_id('ntf'),
  user_id uuid not null references public.profiles (id) on delete cascade,
  type text not null,
  request_id text references public.requests (id) on delete cascade,
  proposal_id text references public.solution_proposals (id) on delete cascade,
  message text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);

create table public.reports (
  id text primary key default public.gitdex_id('rep'),
  reporter_user_id uuid not null references public.profiles (id) on delete cascade,
  entity_type text not null check (entity_type in ('software', 'request', 'solution')),
  entity_id text not null,
  reason text not null,
  status text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  created_at timestamptz not null default now()
);
create index reports_status_idx on public.reports (status, created_at desc);

create table public.idempotency_keys (
  user_id uuid not null references public.profiles (id) on delete cascade,
  key text not null,
  operation text not null,
  request_hash text not null,
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, key)
);

create table public.rate_limits (
  bucket text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (bucket, window_start)
);

-- lock everything down ------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.api_tokens enable row level security;
alter table public.software enable row level security;
alter table public.requests enable row level security;
alter table public.interests enable row level security;
alter table public.solution_proposals enable row level security;
alter table public.acceptance_feedback enable row level security;
alter table public.evidence enable row level security;
alter table public.audit_events enable row level security;
alter table public.notifications enable row level security;
alter table public.reports enable row level security;
alter table public.idempotency_keys enable row level security;
alter table public.rate_limits enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke execute on function public.gitdex_id(text) from anon, authenticated, public;
