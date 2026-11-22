-- Fotos dos jogadores (perfil): bucket público só para leitura; enviar/trocar/apagar só para league_admins.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('player-photos', 'player-photos', true, 524288, array['image/webp'])
on conflict (id) do update set public = true, file_size_limit = 524288, allowed_mime_types = array['image/webp'];

drop policy if exists "player photos: organizer reads" on storage.objects;
drop policy if exists "player photos: organizer uploads" on storage.objects;
drop policy if exists "player photos: organizer updates" on storage.objects;
drop policy if exists "player photos: organizer deletes" on storage.objects;
-- Leitura pública é pela URL pública do bucket (sem regra de select para anon: ninguém lista os arquivos).
create policy "player photos: organizer reads" on storage.objects for select to authenticated
  using (bucket_id = 'player-photos' and exists (select 1 from public.league_admins a where a.user_id = (select auth.uid())));
create policy "player photos: organizer uploads" on storage.objects for insert to authenticated
  with check (bucket_id = 'player-photos' and exists (select 1 from public.league_admins a where a.user_id = (select auth.uid())));
create policy "player photos: organizer updates" on storage.objects for update to authenticated
  using (bucket_id = 'player-photos' and exists (select 1 from public.league_admins a where a.user_id = (select auth.uid())))
  with check (bucket_id = 'player-photos' and exists (select 1 from public.league_admins a where a.user_id = (select auth.uid())));
create policy "player photos: organizer deletes" on storage.objects for delete to authenticated
  using (bucket_id = 'player-photos' and exists (select 1 from public.league_admins a where a.user_id = (select auth.uid())));

-- A view pública passa a mostrar a versão de cada foto (state.playerPhotos), para o perfil montar a URL.
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
    'superLiga', state->'superLiga',
    'playerPhotos', state->'playerPhotos'
  )) as state,
  updated_at
from (
  select id, state, updated_at, coalesce(state->'currentGame'->>'training', 'false') = 'true' as training_now
  from public.league_night
) n;

grant select on public.league_public to anon, authenticated;
