-- LIGA SKALAMA: backend compartilhado para uma noite pública.
-- Leitura pública; alterações somente para contas explicitamente autorizadas em league_admins.
create table if not exists public.league_night (
  id integer primary key check (id = 1),
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(),
  player_name text not null,
  team_name text,
  match_number integer not null,
  game_id uuid,
  score_team_name text,
  own_goal boolean not null default false,
  assisted_by text,
  training boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists public.league_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.league_night enable row level security;
alter table public.goals enable row level security;
alter table public.league_admins enable row level security;
-- Remove every previous policy so an old permissive policy cannot override the secure rules below.
do $$ declare p record; begin
  for p in select tablename, policyname from pg_policies where schemaname='public' and tablename in ('league_night','goals','league_admins') loop
    execute format('drop policy if exists %I on public.%I',p.policyname,p.tablename);
  end loop;
end $$;
create policy "organizer can read full league state" on public.league_night for select to authenticated using (exists (select 1 from public.league_admins a where a.user_id=auth.uid()));
-- 2) Gols de treino (training = true): visitante (anon) não lê; organizador lê tudo.
-- A regra do anon NÃO pode citar league_admins (anon não tem acesso a essa tabela e a consulta inteira falharia).
drop policy if exists "public can read goals" on public.goals;
create policy "public can read goals" on public.goals for select to anon using (not training);
create policy "logged users read official goals and admins read all" on public.goals for select to authenticated
  using (not training or exists (select 1 from public.league_admins a where a.user_id = (select auth.uid())));
create policy "organizer can read own access" on public.league_admins for select to authenticated using (user_id = auth.uid());
create policy "organizer can insert league night" on public.league_night for insert to authenticated with check (exists (select 1 from public.league_admins a where a.user_id=auth.uid()));
create policy "organizer can update league night" on public.league_night for update to authenticated using (exists (select 1 from public.league_admins a where a.user_id=auth.uid())) with check (exists (select 1 from public.league_admins a where a.user_id=auth.uid()));
create policy "organizer can delete league night" on public.league_night for delete to authenticated using (exists (select 1 from public.league_admins a where a.user_id=auth.uid()));
create policy "organizer can insert goals" on public.goals for insert to authenticated with check (exists (select 1 from public.league_admins a where a.user_id=auth.uid()));
create policy "organizer can update goals" on public.goals for update to authenticated using (exists (select 1 from public.league_admins a where a.user_id=auth.uid())) with check (exists (select 1 from public.league_admins a where a.user_id=auth.uid()));
create policy "organizer can delete goals" on public.goals for delete to authenticated using (exists (select 1 from public.league_admins a where a.user_id=auth.uid()));
revoke all on public.league_admins from anon, authenticated;
grant select on public.league_admins to authenticated;
grant select, insert, update, delete on public.goals to anon, authenticated;
revoke all on public.league_night from anon;
grant select, insert, update, delete on public.league_night to authenticated;
-- Visitantes: sem jogos de treino no histórico e sem o jogo atual quando ele é de treino.
create or replace view public.league_public with (security_barrier = true, security_invoker = false) as
select id,
  jsonb_strip_nulls(jsonb_build_object(
    'venue', state->'venue', 'matchDate', state->'matchDate', 'startTime', state->'startTime',
    'timerMode', state->'timerMode', 'durationMinutes', state->'durationMinutes', 'scoreRules', state->'scoreRules',
    'roundId', state->'roundId', 'lineups', state->'lineups', 'teams', state->'teams', 'teamLabels', state->'teamLabels',
    'matches', state->'matches', 'currentMatch', state->'currentMatch', 'matchResults', state->'matchResults',
    'incidents', case when training_now then null else state->'incidents' end,
    'currentGame', case when training_now then null else state->'currentGame' end,
    'pendingMatch', state->'pendingMatch', 'challengeQueue', state->'challengeQueue',
    'gameHistory', case when jsonb_typeof(state->'gameHistory') = 'array' then (
      select coalesce(jsonb_agg(g order by ord), '[]'::jsonb)
      from jsonb_array_elements(state->'gameHistory') with ordinality t(g, ord)
      where coalesce(g->>'training', 'false') <> 'true'
    ) else state->'gameHistory' end,
    'keeperRatings', state->'keeperRatings',
    'timer', case when training_now then null else state->'timer' end,
    'shootout', case when training_now then null else state->'shootout' end,
    'superLiga', state->'superLiga'
  )) as state,
  updated_at
from (
  select id, state, updated_at, coalesce(state->'currentGame'->>'training', 'false') = 'true' as training_now
  from public.league_night
) n;

grant select on public.league_public to anon, authenticated;
insert into public.league_night (id,state) values (1,'{}'::jsonb) on conflict (id) do nothing;
do $$ begin
  alter publication supabase_realtime add table public.league_night;
exception when duplicate_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.goals;
exception when duplicate_object then null;
end $$;
-- Additional field for recording the minute of each goal in the live match.
alter table public.goals add column if not exists minute integer;
alter table public.goals add column if not exists game_id uuid;


alter table public.goals add column if not exists score_team_name text;
alter table public.goals add column if not exists own_goal boolean not null default false;
alter table public.goals add column if not exists assisted_by text;

-- ---------- SKALAMA News (o mesmo conteúdo de supabase/migrations/20261115_skalama_news.sql) ----------
-- SKALAMA News: portal de notícias da liga.
-- Ajustes em relação ao rascunho original:
--   * match_id aponta para o id (uuid) de uma partida do histórico, que fica no JSON de league_night;
--     como não existe tabela "matches", a coluna não tem chave estrangeira.
--   * Jogadores são identificados pelo nome (não há tabela de jogadores): player_name text.
--   * author_id referencia auth.users e é preenchido com quem criou a notícia.

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


-- Presença pelo link, PIN do jogador e votação do Craque da noite: ver supabase/migrations/20261123_presenca_votacao.sql
-- (tabelas sem acesso direto; funções com privilégio no schema skalama_private; portas security invoker no public).
