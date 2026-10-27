-- Liga Skalama: adiciona assistência e limita a leitura pública aos dados da rodada.
begin;

alter table public.goals add column if not exists assisted_by text;

alter table public.league_night enable row level security;

-- Remove políticas antigas da tabela principal para que nenhuma regra pública permissiva sobreviva.
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='league_night' loop
    execute format('drop policy if exists %I on public.league_night', p.policyname);
  end loop;
end $$;

create policy "organizer can read full league state" on public.league_night
  for select to authenticated
  using (exists (select 1 from public.league_admins a where a.user_id = auth.uid()));
create policy "organizer can insert league night" on public.league_night
  for insert to authenticated
  with check (exists (select 1 from public.league_admins a where a.user_id = auth.uid()));
create policy "organizer can update league night" on public.league_night
  for update to authenticated
  using (exists (select 1 from public.league_admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.league_admins a where a.user_id = auth.uid()));
create policy "organizer can delete league night" on public.league_night
  for delete to authenticated
  using (exists (select 1 from public.league_admins a where a.user_id = auth.uid()));

revoke all on public.league_night from anon;
grant select, insert, update, delete on public.league_night to authenticated;

-- Visitantes recebem apenas equipes formadas e informações públicas da rodada.
create or replace view public.league_public with (security_barrier = true) as
select id,
  jsonb_strip_nulls(jsonb_build_object(
    'venue', state->'venue', 'matchDate', state->'matchDate', 'startTime', state->'startTime',
    'timerMode', state->'timerMode', 'durationMinutes', state->'durationMinutes',
    'scoreRules', state->'scoreRules', 'roundId', state->'roundId', 'lineups', state->'lineups',
    'teams', state->'teams', 'teamLabels', state->'teamLabels', 'matches', state->'matches',
    'currentMatch', state->'currentMatch', 'matchResults', state->'matchResults',
    'incidents', state->'incidents', 'currentGame', state->'currentGame',
    'pendingMatch', state->'pendingMatch', 'challengeQueue', state->'challengeQueue',
    'gameHistory', state->'gameHistory', 'keeperRatings', state->'keeperRatings', 'timer', state->'timer'
  )) as state,
  updated_at
from public.league_night;
grant select on public.league_public to anon, authenticated;

-- Cria somente o registro base quando ainda não existir; preserva qualquer estado atual.
insert into public.league_night (id, state) values (1, '{}'::jsonb) on conflict (id) do nothing;
commit;
