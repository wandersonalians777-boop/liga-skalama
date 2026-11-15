-- SKALAMA News: portal de notícias da liga.
-- Ajustes em relação ao rascunho original:
--   * match_id aponta para o id (uuid) de uma partida do histórico, que fica no JSON de league_night;
--     como não existe tabela "matches", a coluna não tem chave estrangeira.
--   * Jogadores são identificados pelo nome (não há tabela de jogadores): player_name text.
--   * author_id referencia auth.users e é preenchido com quem criou a notícia.
begin;

do $$ begin
  create type public.news_category as enum ('resultado', 'destaque', 'anuncio', 'comunidade');
exception when duplicate_object then null;
end $$;
do $$ begin
  create type public.news_status as enum ('draft', 'published', 'scheduled', 'archived');
exception when duplicate_object then null;
end $$;

create table if not exists public.news_posts (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  title text not null,
  subtitle text,
  excerpt text,
  content text,
  category public.news_category not null default 'resultado',
  status public.news_status not null default 'draft',
  is_featured boolean not null default false,
  published_at timestamptz,
  scheduled_for timestamptz,
  cover_image_url text,
  match_id uuid,
  round_id uuid,
  author_id uuid references auth.users(id) on delete set null default auth.uid(),
  views_count integer not null default 0,
  shares_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.news_post_players (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.news_posts(id) on delete cascade,
  player_name text not null,
  role text, -- mentioned | player_of_the_night | goalkeeper_of_the_night | scorer
  goals integer not null default 0
);

create table if not exists public.news_media (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.news_posts(id) on delete cascade,
  url text not null,
  type text not null default 'image',
  caption text,
  order_index integer not null default 0
);

create table if not exists public.news_highlights (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.news_posts(id) on delete cascade,
  player_name text,
  type text, -- player_of_the_night | goalkeeper_of_the_night | top_scorer
  value numeric,
  label text
);

create index if not exists idx_news_posts_feed on public.news_posts (status, published_at desc) where deleted_at is null;
create index if not exists idx_news_posts_category on public.news_posts (category, published_at desc);
create index if not exists idx_news_posts_match on public.news_posts (match_id);
create index if not exists idx_news_post_players_post on public.news_post_players (post_id);
create index if not exists idx_news_media_post on public.news_media (post_id);
create index if not exists idx_news_highlights_post on public.news_highlights (post_id);

-- updated_at automático
create or replace function public.news_touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists news_posts_touch on public.news_posts;
create trigger news_posts_touch before update on public.news_posts
  for each row execute function public.news_touch_updated_at();

-- Visível para o público: publicada, ou agendada com horário já alcançado; nunca apagada.
create or replace function public.news_is_public(p public.news_posts) returns boolean
language sql stable set search_path = '' as $$
  select p.deleted_at is null and (
    (p.status = 'published' and (p.published_at is null or p.published_at <= now()))
    or (p.status = 'scheduled' and p.scheduled_for is not null and p.scheduled_for <= now())
  )
$$;

create or replace function public.news_is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.league_admins a where a.user_id = auth.uid())
$$;

alter table public.news_posts enable row level security;
alter table public.news_post_players enable row level security;
alter table public.news_media enable row level security;
alter table public.news_highlights enable row level security;

drop policy if exists "news public read" on public.news_posts;
drop policy if exists "news admin all" on public.news_posts;
create policy "news public read" on public.news_posts for select to anon, authenticated
  using (public.news_is_public(news_posts));
create policy "news admin all" on public.news_posts for all to authenticated
  using (public.news_is_admin()) with check (public.news_is_admin());

do $$ declare t text; begin
  foreach t in array array['news_post_players', 'news_media', 'news_highlights'] loop
    execute format('drop policy if exists "news child public read" on public.%I', t);
    execute format('drop policy if exists "news child admin all" on public.%I', t);
    execute format('create policy "news child public read" on public.%I for select to anon, authenticated using (exists (select 1 from public.news_posts p where p.id = post_id and public.news_is_public(p)))', t);
    execute format('create policy "news child admin all" on public.%I for all to authenticated using (public.news_is_admin()) with check (public.news_is_admin())', t);
  end loop;
end $$;

grant select on public.news_posts, public.news_post_players, public.news_media, public.news_highlights to anon, authenticated;
grant insert, update, delete on public.news_posts, public.news_post_players, public.news_media, public.news_highlights to authenticated;

-- Contadores: qualquer visitante soma 1, só em notícia visível ao público.
create or replace function public.news_register_view(p_post uuid) returns void
language sql security definer set search_path = '' as $$
  update public.news_posts p set views_count = p.views_count + 1
  where p.id = p_post and public.news_is_public(p)
$$;
create or replace function public.news_register_share(p_post uuid) returns void
language sql security definer set search_path = '' as $$
  update public.news_posts p set shares_count = p.shares_count + 1
  where p.id = p_post and public.news_is_public(p)
$$;
revoke all on function public.news_register_view(uuid), public.news_register_share(uuid) from public;
grant execute on function public.news_register_view(uuid), public.news_register_share(uuid) to anon, authenticated;
revoke all on function public.news_is_admin() from public;
grant execute on function public.news_is_admin() to anon, authenticated;

commit;
