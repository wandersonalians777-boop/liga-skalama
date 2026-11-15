/* SKALAMA News — service worker das notificações push.
   Só cuida de notificações: não guarda páginas em cache, então o site continua sempre atualizado. */
const SITE_ORIGIN = "https://skalama.com.br";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Só abre endereços do próprio site; qualquer outra coisa vira a página inicial.
function safeUrl(raw) {
  try {
    const url = new URL(raw || "/", self.location.origin);
    if (url.origin === self.location.origin) return url.href;
    if (url.origin === SITE_ORIGIN) return new URL(url.pathname + url.search + url.hash, self.location.origin).href;
  } catch (error) {}
  return new URL("/", self.location.origin).href;
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (error) {
    data = { body: event.data ? event.data.text() : "" };
  }
  const options = {
    body: data.body || "Tem notícia nova na liga!",
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png",
    tag: data.tag || "skalama-news",
    renotify: true,
    data: { url: safeUrl(data.url) },
  };
  if (data.image && /^https:\/\//i.test(data.image)) options.image = data.image;
  event.waitUntil(self.registration.showNotification(data.title || "SKALAMA News", options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = safeUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (open) {
        // Aba do site já aberta: traz para frente e pede para abrir a notícia (sem recarregar a página).
        await open.focus();
        open.postMessage({ type: "skalama-open-url", url });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
