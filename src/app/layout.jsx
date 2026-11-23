import { preconnect, preload } from 'react-dom';

export const metadata = {
  title: 'LIGA SKALAMA — Dia de Fut',
  description: 'Organização da Liga Skalama: sorteio, partidas, placares e estatísticas.',
  icons: {
    icon: '/assets/escudo-skalama-oficial.png',
    apple: '/icons/apple-touch-icon.png',
  },
  // Manifest e modo "app": necessários para o iPhone aceitar notificações (site adicionado à Tela de Início).
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'LIGA SKALAMA', statusBarStyle: 'black-translucent' },
  other: { 'apple-mobile-web-app-capable': 'yes' },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#f4f4f1',
};

const assetVersion = process.env.NEXT_PUBLIC_ASSET_VERSION || 'dev';

// Definidas no build (.env.local ou variáveis do GitHub). Use só a chave pública anon/publishable.
// A chave VAPID pública também é pública por natureza (a privada fica só no Vault do Supabase).
const ligaConfig = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
  vapidPublicKey:
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ||
    'BHffLwBOEcbRFrxrrZl4UmLVJgOZltD9vxzAQuDsknzPWrXH91YAypfVwAiJyg0zBOByK5oXzE6_pBmDKcTBoII',
};

export default function RootLayout({ children }) {
  // Conexões e arquivos que a página vai precisar: o navegador começa a buscar tudo logo no início
  // (antes, cada arquivo só era pedido depois do anterior chegar).
  preconnect('https://cdn.jsdelivr.net', { crossOrigin: 'anonymous' });
  if (ligaConfig.supabaseUrl) preconnect(ligaConfig.supabaseUrl, { crossOrigin: 'anonymous' });
  preload(`/app-markup.html?v=${assetVersion}`, { as: 'fetch', crossOrigin: 'anonymous' });
  // integrity/crossOrigin iguais aos do page.jsx, senão o navegador baixa o arquivo duas vezes.
  preload('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/dist/umd/supabase.js', {
    as: 'script',
    crossOrigin: 'anonymous',
    integrity: 'sha384-rwykjmWNwVxboyFmvK9OXN0wj9hnMHA2aAHtits54DuACyCq0M2PrSNxhRb+hvXT',
  });
  preload(`/app-live.js?v=${assetVersion}`, { as: 'script' });
  preload('/assets/fonts/barlow-condensed-900.woff2', { as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' });
  preload('/assets/fonts/dm-sans-latin.woff2', { as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' });
  return (
    <html lang="pt-BR">
      <head>
        <link rel="stylesheet" href={`/styles.css?v=${assetVersion}`} />
        <script
          dangerouslySetInnerHTML={{
            __html: `window.LIGA_CONFIG=${JSON.stringify(ligaConfig).replace(/</g, '\\u003c')};` +
              // Instalar o app: guarda o convite do navegador para o botão "Instalar" da Tela principal.
              "window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();window.__skInstall=e;document.dispatchEvent(new Event('sk-installable'))});" +
              "window.addEventListener('appinstalled',function(){window.__skInstall=null;window.__skInstalled=true;document.dispatchEvent(new Event('sk-installed'))});",
          }}
        />
      </head>
      <body className="light-theme">{children}</body>
    </html>
  );
}
