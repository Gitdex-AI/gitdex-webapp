-- Store listings. A software record can carry the address of its App Store
-- and Google Play listing; the page shows each store's own badge for it. The
-- service only stores a normalized address on the store's own host; the checks
-- here keep a badge from ever pointing anywhere else.

alter table public.software
  add column app_store_url text check (app_store_url like 'https://apps.apple.com/%'),
  add column google_play_url text check (google_play_url like 'https://play.google.com/store/apps/details?id=%');
