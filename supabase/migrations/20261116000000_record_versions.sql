-- Editing with history. An author can change a record they published; the
-- version it replaces is kept, so anyone who saw (or judged) the earlier text
-- can still look it up. Each record carries its current `version`; every
-- earlier version is one row here.

alter table public.software add column version integer not null default 1;
alter table public.requests add column version integer not null default 1;
alter table public.solution_proposals add column version integer not null default 1;

create table public.record_revisions (
  id bigint generated always as identity primary key,
  entity_type text not null check (entity_type in ('software', 'request', 'solution')),
  entity_id text not null,
  -- the version this row preserves
  version integer not null,
  -- the record's content fields as they were in that version
  snapshot jsonb not null,
  -- what the author said about the edit that replaced it
  change_note text,
  edited_by uuid references public.profiles (id) on delete set null,
  published_at timestamptz not null,
  replaced_at timestamptz not null default now(),
  unique (entity_type, entity_id, version)
);

alter table public.record_revisions enable row level security;
revoke all on public.record_revisions from anon, authenticated;
