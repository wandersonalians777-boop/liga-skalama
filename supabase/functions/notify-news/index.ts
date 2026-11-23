// SKALAMA News: envia notificação push quando uma notícia é publicada.
//
// Formas de chamada (a autenticação é feita aqui dentro, por isso a função roda com verify_jwt desligado):
//  1) Pelo gatilho do banco (pg_net), com o header x-notify-secret (o segredo fica só no Vault):
//     { "post_id": "<uuid>" }
//  2) Pelo organizador logado no site, para testar no próprio aparelho:
//     { "test": true, "endpoint": "<endpoint da inscrição deste aparelho>" }  + Authorization: Bearer <sessão>
//  3) Uma única vez, pelo banco (com o mesmo header secreto), para gerar as chaves VAPID:
//     { "setup": true }  -> gera o par, guarda no Vault e devolve só a chave pública.
//  4) Pelo banco (mesmo header secreto), quando a lista de espera puxa alguém para a lista de presença:
//     { "presence_queue_id": 123 }  -> avisa só os aparelhos ligados a esse jogador (player_push_links).
//
// Chaves VAPID: lidas do Vault (news_push_vapid). Se existirem os secrets VAPID_PUBLIC_KEY,
// VAPID_PRIVATE_KEY e VAPID_SUBJECT na função, eles têm prioridade. Nada disso fica no repositório.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const SITE = "https://skalama.com.br";
const ALLOWED_ORIGINS = new Set(["https://skalama.com.br", "https://www.skalama.com.br", "http://localhost:3000"]);

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : SITE,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function json(req: Request, status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders(req), "Content-Type": "application/json" } });
}

async function vapidReady(): Promise<boolean> {
  let publicKey = Deno.env.get("VAPID_PUBLIC_KEY"), privateKey = Deno.env.get("VAPID_PRIVATE_KEY"), subject = Deno.env.get("VAPID_SUBJECT");
  if (!publicKey || !privateKey || !subject) {
    const { data } = await admin.rpc("news_push_vapid");
    const row = Array.isArray(data) ? data[0] : data;
    publicKey = publicKey || row?.public_key;
    privateKey = privateKey || row?.private_key;
    subject = subject || row?.subject;
  }
  if (!publicKey || !privateKey || !subject) return false;
  webpush.setVapidDetails(subject, publicKey, privateKey);
  return true;
}

async function secretOk(req: Request): Promise<boolean> {
  const secret = req.headers.get("x-notify-secret") || "";
  if (!secret) return false;
  const { data } = await admin.rpc("news_push_check_secret", { p_secret: secret });
  return data === true;
}

// Gera as chaves VAPID uma única vez e guarda no Vault; devolve só a pública.
async function handleSetup(req: Request) {
  if (!(await secretOk(req))) return json(req, 401, { error: "não autorizado" });
  const keys = webpush.generateVAPIDKeys();
  const { data: stored } = await admin.rpc("news_push_store_vapid", { p_public: keys.publicKey, p_private: keys.privateKey });
  if (stored !== true) {
    const { data } = await admin.rpc("news_push_vapid");
    const row = Array.isArray(data) ? data[0] : data;
    return json(req, 200, { created: false, public_key: row?.public_key || null });
  }
  return json(req, 200, { created: true, public_key: keys.publicKey });
}

type Sub = { id: string; endpoint: string; p256dh: string; auth: string; failures: number };

// Envia para várias inscrições; apaga as que não existem mais (404/410) e conta falhas das outras.
async function sendToAll(subs: Sub[], payload: Record<string, unknown>) {
  const body = JSON.stringify(payload);
  const okIds: string[] = [], goneIds: string[] = [], failed: Sub[] = [];
  for (let i = 0; i < subs.length; i += 25) {
    const batch = subs.slice(i, i + 25);
    const results = await Promise.allSettled(
      batch.map((s) => webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 86400, urgency: "normal" })),
    );
    results.forEach((result, index) => {
      const sub = batch[index];
      if (result.status === "fulfilled") okIds.push(sub.id);
      else {
        const code = (result.reason as { statusCode?: number })?.statusCode;
        if (code === 404 || code === 410) goneIds.push(sub.id);
        else failed.push(sub);
        console.warn("push falhou", code, String((result.reason as Error)?.message || result.reason).slice(0, 200));
      }
    });
  }
  if (okIds.length) await admin.from("push_subscriptions").update({ last_success_at: new Date().toISOString(), failures: 0 }).in("id", okIds);
  if (goneIds.length) await admin.from("push_subscriptions").delete().in("id", goneIds);
  // Depois de 5 falhas seguidas a inscrição é descartada.
  for (const sub of failed) {
    if (sub.failures + 1 >= 5) await admin.from("push_subscriptions").delete().eq("id", sub.id);
    else await admin.from("push_subscriptions").update({ failures: sub.failures + 1 }).eq("id", sub.id);
  }
  return { total: subs.length, ok: okIds.length, failed: goneIds.length + failed.length, removed: goneIds.length };
}

async function handleTest(req: Request, endpoint: string) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  if (userError || !userData?.user) return json(req, 401, { error: "Entre como organizador para enviar o teste." });
  const { data: adminRow } = await admin.from("league_admins").select("user_id").eq("user_id", userData.user.id).maybeSingle();
  if (!adminRow) return json(req, 403, { error: "Só organizadores podem enviar o teste." });
  const { data: sub } = await admin.from("push_subscriptions").select("id, endpoint, p256dh, auth, failures").eq("endpoint", endpoint).maybeSingle();
  if (!sub) return json(req, 404, { error: "Este aparelho não está inscrito. Ative as notificações primeiro." });
  const result = await sendToAll([sub as Sub], {
    title: "SKALAMA News",
    body: "Notificação de teste: está funcionando! ✅",
    url: SITE + "/",
    tag: "skalama-teste",
  });
  return json(req, 200, { test: true, ...result });
}

async function handlePublish(req: Request, postId: string) {
  if (!(await secretOk(req))) return json(req, 401, { error: "não autorizado" });

  const { data: post, error } = await admin
    .from("news_posts")
    .select("id, slug, title, excerpt, cover_image_url, status, deleted_at")
    .eq("id", postId)
    .maybeSingle();
  if (error || !post) return json(req, 404, { error: "notícia não encontrada" });
  if (post.status !== "published" || post.deleted_at) return json(req, 200, { skipped: "notícia não está publicada" });

  // Reserva a notícia no log antes de enviar: se já existe, outra chamada já cuidou dela.
  const { error: claimError } = await admin.from("news_push_log").insert({ post_id: post.id });
  if (claimError) return json(req, 200, { skipped: "notícia já notificada" });

  const { data: subs } = await admin.from("push_subscriptions").select("id, endpoint, p256dh, auth, failures");
  const cover = typeof post.cover_image_url === "string" && /^https:\/\//i.test(post.cover_image_url) ? post.cover_image_url : undefined;
  const result = await sendToAll((subs || []) as Sub[], {
    title: "SKALAMA News",
    body: post.title,
    url: SITE + "/#noticia-" + encodeURIComponent(post.slug),
    image: cover,
    tag: "news-" + post.id,
  });
  await admin.from("news_push_log").update({ sent_at: new Date().toISOString(), total: result.total, ok: result.ok, failed: result.failed }).eq("post_id", post.id);
  return json(req, 200, { post: post.slug, ...result });
}

// Lista de espera: avisa o jogador que entrou na lista (só nos aparelhos que ele ligou com o PIN).
async function handlePresence(req: Request, queueId: number) {
  if (!(await secretOk(req))) return json(req, 401, { error: "não autorizado" });
  // Reserva o aviso: só uma chamada envia.
  const { data: item } = await admin.from("presence_push_queue").update({ sent_at: new Date().toISOString() })
    .eq("id", queueId).is("sent_at", null).select("id, round_key, player_name").maybeSingle();
  if (!item) return json(req, 200, { skipped: "aviso já enviado" });
  const { data: links } = await admin.from("player_push_links").select("endpoint").eq("player_name", item.player_name);
  const endpoints = (links || []).map((l: { endpoint: string }) => l.endpoint);
  let result = { total: 0, ok: 0, failed: 0, removed: 0 };
  if (endpoints.length) {
    const { data: subs } = await admin.from("push_subscriptions").select("id, endpoint, p256dh, auth, failures").in("endpoint", endpoints);
    const [, m, d] = String(item.round_key).split("-");
    result = await sendToAll((subs || []) as Sub[], {
      title: "LIGA SKALAMA",
      body: "Abriu vaga: você está confirmado para o jogo de " + d + "/" + m + ". ✅",
      url: SITE + "/#presenca",
      tag: "presenca-" + item.round_key,
    });
  }
  await admin.from("presence_push_queue").update({ total: result.total, ok: result.ok }).eq("id", item.id);
  return json(req, 200, { presence: true, ...result });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { error: "use POST" });
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json(req, 400, { error: "corpo inválido" }); }
  try {
    if (body.setup === true) return await handleSetup(req);
    if (!(await vapidReady())) return json(req, 500, { error: "Chaves VAPID ainda não configuradas." });
    if (body.test === true && typeof body.endpoint === "string") return await handleTest(req, body.endpoint);
    if (typeof body.presence_queue_id === "number") return await handlePresence(req, body.presence_queue_id);
    if (typeof body.post_id === "string") return await handlePublish(req, body.post_id);
    return json(req, 400, { error: "pedido inválido" });
  } catch (err) {
    console.error("notify-news erro", err);
    return json(req, 500, { error: "erro ao enviar notificações" });
  }
});
