-- rls_auto_enable é a função do gatilho que liga o RLS em tabelas novas; ninguém precisa chamá-la pela API.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
