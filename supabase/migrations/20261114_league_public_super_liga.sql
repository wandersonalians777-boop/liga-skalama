-- Liga Skalama: visitantes também veem a Super Liga (times, tabela de jogos e campeão).
create or replace view public.league_public with (security_barrier = true, security_invoker = false) as
select id, jsonb_strip_nulls(jsonb_build_object(
  'venue', state->'venue', 'matchDate', state->'matchDate', 'startTime', state->'startTime',
  'timerMode', state->'timerMode', 'durationMinutes', state->'durationMinutes', 'scoreRules', state->'scoreRules',
  'roundId', state->'roundId', 'lineups', state->'lineups', 'teams', state->'teams', 'teamLabels', state->'teamLabels',
  'matches', state->'matches', 'currentMatch', state->'currentMatch', 'matchResults', state->'matchResults',
  'incidents', state->'incidents', 'currentGame', state->'currentGame', 'pendingMatch', state->'pendingMatch',
  'challengeQueue', state->'challengeQueue', 'gameHistory', state->'gameHistory', 'keeperRatings', state->'keeperRatings', 'timer', state->'timer', 'shootout', state->'shootout',
  'superLiga', state->'superLiga'
)) as state, updated_at
from public.league_night;
grant select on public.league_public to anon, authenticated;
