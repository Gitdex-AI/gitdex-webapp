-- Two-language records and software images.
--
-- Every software record, request and proposal is written in one language
-- (`language`) and can carry the other one in `translations`, shaped
-- { "<lang>": { "<field>": text | text[] } }. Pages show a visitor exactly one
-- version. English and Chinese only for now.
--
-- Images are public https URLs supplied by the submitter. GitDex neither
-- fetches nor hosts them.

alter table public.software
  add column language text not null default 'en' check (language in ('en', 'zh')),
  add column translations jsonb not null default '{}'::jsonb,
  add column icon_url text,
  add column screenshots jsonb not null default '[]'::jsonb;

alter table public.requests
  add column language text not null default 'en' check (language in ('en', 'zh')),
  add column translations jsonb not null default '{}'::jsonb;

alter table public.solution_proposals
  add column language text not null default 'en' check (language in ('en', 'zh')),
  add column translations jsonb not null default '{}'::jsonb;

-- Records written before this migration: mark the ones written in Chinese.
update public.software set language = 'zh' where description ~ '[一-鿿]';
update public.requests set language = 'zh' where (title || goal) ~ '[一-鿿]';
update public.solution_proposals set language = 'zh' where coverage_notes ~ '[一-鿿]';
