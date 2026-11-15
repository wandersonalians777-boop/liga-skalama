-- Super Liga atual (dados): o jogo 2017 FC 3 × 2 SKALAMA é a final que decide o título;
-- o 2017 FC 9 × 1 SKALAMA vira amistoso (conta para os rankings, não muda o campeão).
-- Nada é apagado: os valores antigos ficam em superLigaIdOriginal / stageOriginal.
-- Também corrige a grafia "2017 fc" -> "2017 FC". Só roda uma vez (confere se o amistoso ainda está como final).
do $$
declare
  s jsonb;
  final_id text := '6261f148-2210-47e8-bb23-3afaac5e03da';
  friendly_id text := '08841dce-68b2-4000-80fd-3d885cc6a503';
  fix_name text := '^2017 fc$';
begin
  select state into s from public.league_night where id = 1 for update;
  if not exists (select 1 from jsonb_array_elements(s->'gameHistory') g where g->>'id' = friendly_id and g->>'stage' = 'final') then
    raise notice 'Nada a fazer: dados já ajustados.';
    return;
  end if;
  s := jsonb_set(s, '{gameHistory}', (
    select jsonb_agg(
      (case
         when g->>'id' = final_id then g || jsonb_build_object('superLigaId', s->'superLiga'->'id', 'superLigaIdOriginal', g->'superLigaId')
         when g->>'id' = friendly_id then g || jsonb_build_object('stage', 'amistoso', 'stageOriginal', g->'stage')
         else g end)
      || case when g->>'homeLabel' ~* fix_name then '{"homeLabel":"2017 FC"}'::jsonb else '{}'::jsonb end
      || case when g->>'awayLabel' ~* fix_name then '{"awayLabel":"2017 FC"}'::jsonb else '{}'::jsonb end
      order by ord)
    from jsonb_array_elements(s->'gameHistory') with ordinality as t(g, ord)));
  s := jsonb_set(s, '{superLiga,teams}', (
    select jsonb_agg(case when t->>'name' ~* fix_name then t || '{"name":"2017 FC"}'::jsonb else t end order by ord)
    from jsonb_array_elements(s->'superLiga'->'teams') with ordinality as x(t, ord)));
  s := jsonb_set(s, '{superLiga,fixtures}', jsonb_build_array(
    (select f from jsonb_array_elements(s->'superLiga'->'fixtures') f where f->>'stage' = 'final' limit 1)
      || jsonb_build_object('home', 'sl-02b2a5d9', 'away', 'sl-c8b02573', 'gameId', final_id),
    jsonb_build_object('id', gen_random_uuid(), 'stage', 'amistoso', 'round', null, 'home', 'sl-c8b02573', 'away', 'sl-02b2a5d9', 'gameId', friendly_id)));
  update public.league_night set state = s, updated_at = now() where id = 1;
end $$;
