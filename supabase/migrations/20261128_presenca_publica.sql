-- Lista de presença pública (aba Modo Liga): a leitura pública devolve só nome, status (in/wait), ordem e goleiro
-- (+ "promoted", usado para o aviso "Abriu vaga"). A origem da confirmação (source) só vai para o organizador.
create or replace function skalama_private.presence_view(p_round text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  rr public.attendance_rounds%rowtype;
  v_key text := p_round;
  v_admin boolean := skalama_private.is_admin();
begin
  if v_key is null or v_key = '' then
    select coalesce(
      (select a.round_key from public.attendance_rounds a, public.league_night n where n.id = 1 and a.round_key = n.state->>'matchDate'),
      (select a.round_key from public.attendance_rounds a order by a.match_date desc limit 1)
    ) into v_key;
  end if;
  select * into rr from public.attendance_rounds where round_key = v_key;
  return jsonb_build_object(
    'round', case when rr.round_key is null then null else jsonb_build_object(
      'round_key', rr.round_key, 'match_date', rr.match_date, 'start_time', to_char(rr.start_time, 'HH24:MI'), 'venue', rr.venue,
      'slots', rr.slots, 'open', skalama_private.presence_is_open(rr), 'closes_at', rr.closes_at) end,
    'players', coalesce((
      select jsonb_agg(jsonb_build_object('name', a.player_name, 'status', a.status, 'keeper', coalesce(ro.keeper, false),
          'promoted', a.status = 'in' and a.promoted_at is not null)
          || case when v_admin then jsonb_build_object('source', a.source) else '{}'::jsonb end
        order by case a.status when 'in' then 0 else 1 end,
          case when a.status = 'in' then coalesce(a.confirmed_at, a.created_at) end, a.position, a.created_at)
      from public.attendance a left join skalama_private.roster() ro on ro.name = a.player_name
      where a.round_key = rr.round_key and a.status <> 'out'), '[]'::jsonb),
    'counts', jsonb_build_object(
      'in', (select count(*) from public.attendance a where a.round_key = rr.round_key and a.status = 'in'),
      'wait', (select count(*) from public.attendance a where a.round_key = rr.round_key and a.status = 'wait')),
    'roster', coalesce((select jsonb_agg(jsonb_build_object('name', ro.name, 'keeper', ro.keeper,
        'has_pin', exists (select 1 from public.player_pins p where p.player_name = ro.name)) order by ro.name)
      from skalama_private.roster() ro), '[]'::jsonb)
  );
end;
$$;
