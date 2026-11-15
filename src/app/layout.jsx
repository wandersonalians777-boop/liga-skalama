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
  return (
    <html lang="pt-BR">
      <head>
        <link rel="stylesheet" href={`/styles.css?v=${assetVersion}`} />
        <script
          dangerouslySetInnerHTML={{
            __html: `window.LIGA_CONFIG=${JSON.stringify(ligaConfig).replace(/</g, '\\u003c')};`,
          }}
        />
      </head>
      <body className="light-theme">{children}</body>
    </html>
  );
}
