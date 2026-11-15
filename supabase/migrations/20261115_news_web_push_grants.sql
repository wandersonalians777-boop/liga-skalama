-- Permissões mínimas para a Edge Function notify-news (que usa a chave de serviço).
-- Neste projeto o papel service_role não recebe permissões automáticas nas tabelas.
grant select on public.news_posts to service_role;
grant select on public.league_admins to service_role;
grant select, update, delete on public.push_subscriptions to service_role;
grant select, insert, update on public.news_push_log to service_role;
