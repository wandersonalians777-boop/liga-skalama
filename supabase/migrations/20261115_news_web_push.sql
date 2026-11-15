-- SKALAMA News: notificações push (Web Push) quando uma notícia é publicada.
-- Segredos: NOTIFY_SECRET é gerado aqui dentro e fica só no Vault (nunca no código).
-- As chaves VAPID são geradas pela Edge Function notify-news (ação "setup") e também ficam só no Vault.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

-- Inscrições dos aparelhos. Sem acesso direto: só pelas funções subscribe_push/unsubscribe_push.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_success_at timestamptz,
  failures integer not null default 0
);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;

-- Uma notícia nunca é notificada duas vezes.
create table if not exists public.news_push_log (
  post_id uuid primary key references public.news_posts(id) on delete cascade,
  sent_at timestamptz not null default now(),
  total integer not null default 0,
  ok integer not null default 0,
  failed integer not null default 0
);
alter table public.news_push_log enable row level security;
revoke all on public.news_push_log from anon, authenticated;

-- Inscrever / desinscrever. Só aceita endereços dos serviços oficiais de push
-- (Google/FCM, Mozilla, Apple e Microsoft), para ninguém usar a função para disparar requisições a outros sites.
create or replace function public.subscribe_push(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_endpoint is null or length(p_endpoint) > 1000
     or p_endpoint !~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9.-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)/'
     or coalesce(p_p256dh, '') = '' or length(p_p256dh) > 200
     or coalesce(p_auth, '') = '' or length(p_auth) > 100 then
    raise exception 'Inscrição de notificação inválida.' using errcode = '22023';
  end if;
  insert into public.push_subscriptions (endpoint, p256dh, auth, user_agent)
  values (p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  on conflict (endpoint) do update
    set p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent, failures = 0;
end $$;

create or replace function public.unsubscribe_push(p_endpoint text)
returns void language sql security definer set search_path = '' as $$
  delete from public.push_subscriptions where endpoint = p_endpoint
$$;

revoke all on function public.subscribe_push(text, text, text, text), public.unsubscribe_push(text) from public;
grant execute on function public.subscribe_push(text, text, text, text), public.unsubscribe_push(text) to anon, authenticated;

-- Segredo da chamada banco -> Edge Function: gerado aleatoriamente e guardado só no Vault.
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'notify_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'notify_secret', 'Segredo do gatilho de push do SKALAMA News');
  end if;
end $$;

-- Chaves VAPID: geradas pela própria Edge Function (ação "setup") e guardadas só no Vault.
-- A chave privada nunca sai do Supabase. O contato VAPID (vapid_subject = mailto:<e-mail do dono>)
-- é gravado no Vault à parte, fora do repositório. Sem ele, vale o site como contato.
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'vapid_subject') then
    perform vault.create_secret('https://skalama.com.br', 'vapid_subject', 'Contato VAPID do SKALAMA News');
  end if;
end $$;

create or replace function public.news_push_vapid()
returns table (public_key text, private_key text, subject text)
language sql stable security definer set search_path = '' as $$
  select
    (select decrypted_secret from vault.decrypted_secrets where name = 'vapid_public_key' limit 1),
    (select decrypted_secret from vault.decrypted_secrets where name = 'vapid_private_key' limit 1),
    (select decrypted_secret from vault.decrypted_secrets where name = 'vapid_subject' limit 1)
$$;

create or replace function public.news_push_store_vapid(p_public text, p_private text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from vault.secrets where name in ('vapid_public_key', 'vapid_private_key')) then
    return false; -- já existem: nunca troca as chaves (as inscrições dependem delas)
  end if;
  perform vault.create_secret(p_public, 'vapid_public_key', 'Chave pública VAPID do SKALAMA News');
  perform vault.create_secret(p_private, 'vapid_private_key', 'Chave privada VAPID do SKALAMA News');
  return true;
end $$;

revoke all on function public.news_push_vapid(), public.news_push_store_vapid(text, text) from public, anon, authenticated;
grant execute on function public.news_push_vapid(), public.news_push_store_vapid(text, text) to service_role;

-- A Edge Function (com a chave de serviço) confere o segredo recebido sem nunca guardá-lo no código.
create or replace function public.news_push_check_secret(p_secret text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from vault.decrypted_secrets where name = 'notify_secret' and decrypted_secret = p_secret)
$$;
revoke all on function public.news_push_check_secret(text) from public, anon, authenticated;
grant execute on function public.news_push_check_secret(text) to service_role;

-- Gatilho: notícia passou a "published" (e não está apagada) e ainda não foi notificada -> chama a Edge Function.
create or replace function public.news_push_on_publish()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_secret text;
begin
  if new.status = 'published' and new.deleted_at is null
     and (tg_op = 'INSERT' or old.status is distinct from 'published' or old.deleted_at is not null)
     and not exists (select 1 from public.news_push_log l where l.post_id = new.id) then
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'notify_secret' limit 1;
    if v_secret is not null then
      perform net.http_post(
        url := 'https://lqmcmxjjvnlbjnwadzex.supabase.co/functions/v1/notify-news',
        body := jsonb_build_object('post_id', new.id),
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-notify-secret', v_secret),
        timeout_milliseconds := 15000
      );
    end if;
  end if;
  return new;
end $$;
revoke all on function public.news_push_on_publish() from public, anon, authenticated;

drop trigger if exists news_push_publish on public.news_posts;
create trigger news_push_publish
  after insert or update of status, deleted_at on public.news_posts
  for each row execute function public.news_push_on_publish();

-- Agendadas: o site só mostrava a notícia quando chegava a hora, sem mudar a situação.
-- A cada 5 minutos, as agendadas que já passaram do horário viram "published" (isso dispara o gatilho acima).
select cron.schedule(
  'news-publish-scheduled',
  '*/5 * * * *',
  $job$update public.news_posts
       set status = 'published', published_at = coalesce(scheduled_for, now())
       where status = 'scheduled' and scheduled_for is not null and scheduled_for <= now() and deleted_at is null$job$
);
