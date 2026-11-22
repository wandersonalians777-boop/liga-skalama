-- Modo treino: jogos com training = true não vão para visitantes e não contam em nada.

-- 1) Gols de jogos de treino ficam marcados na tabela goals.
alter table public.goals add column if not exists training boolean not null default false;

-- 2) Gols de treino (training = true): visitante (anon) não lê; organizador lê tudo.
-- A regra do anon NÃO pode citar league_admins (anon não tem acesso a essa tabela e a consulta inteira falharia).
drop policy if exists "public can read goals" on public.goals;
create policy "public can read goals" on public.goals for select to anon using (not training);
create policy "logged users read official goals and admins read all" on public.goals for select to authenticated
  using (not training or exists (select 1 from public.league_admins a where a.user_id = (select auth.uid())));

-- 3) A view pública tira os jogos de treino do histórico e esconde o jogo atual quando ele é de treino.
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
