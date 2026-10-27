export const metadata = {
  title: 'LIGA SKALAMA — Dia de Fut',
  description: 'Organização da Liga Skalama: sorteio, partidas, placares e estatísticas.',
  icons: { icon: '/liga-skalama/assets/escudo-skalama-oficial.png' },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#f4f4f1',
};

const assetVersion = process.env.NEXT_PUBLIC_ASSET_VERSION || 'dev';

// Definidas no build (.env.local ou variáveis do GitHub). Use só a chave pública anon/publishable.
const ligaConfig = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
  publicReadOnly: true,
};

export default function RootLayout({ children }) {
  return (
    <html lang="pt-BR">
      <head>
        <link rel="stylesheet" href={`/liga-skalama/styles.css?v=${assetVersion}`} />
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

