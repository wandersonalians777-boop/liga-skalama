'use client';

import { useEffect, useRef, useState } from 'react';

const base = '';
const assetVersion = process.env.NEXT_PUBLIC_ASSET_VERSION || 'dev';
const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/dist/umd/supabase.js';
// Hash do arquivo acima (conferido com o pacote oficial no npm). Se o CDN entregar outro conteúdo,
// o navegador se recusa a executar. Ao trocar de versão, recalcule:
//   curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A
const SUPABASE_JS_INTEGRITY = 'sha384-rwykjmWNwVxboyFmvK9OXN0wj9hnMHA2aAHtits54DuACyCq0M2PrSNxhRb+hvXT';

// async=false: os scripts baixam ao mesmo tempo, mas executam na ordem em que foram inseridos.
function loadScript(src, integrity) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    if (integrity) {
      script.integrity = integrity;
      script.crossOrigin = 'anonymous';
    }
    script.async = false;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Não foi possível carregar ${src}`));
    document.body.appendChild(script);
  });
}

export default function Home() {
  const container = useRef(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    async function mountLegacyInterface() {
      try {
        // O endereço já muda a cada publicação (?v=), então o navegador pode reaproveitar o arquivo baixado.
        const response = await fetch(`${base}/app-markup.html?v=${assetVersion}`);
        if (!response.ok) throw new Error('Não foi possível carregar a interface da Liga Skalama.');
        const markup = await response.text();
        if (!active || !container.current) return;
        container.current.innerHTML = markup;
        if (!window.__LIGA_SKALAMA_SCRIPTS_LOADED__) {
          window.__LIGA_SKALAMA_SCRIPTS_LOADED__ = true;
          // A configuração do Supabase (window.LIGA_CONFIG) já vem do layout.jsx.
          await Promise.all([
            loadScript(SUPABASE_JS, SUPABASE_JS_INTEGRITY),
            loadScript(`${base}/app-live.js?v=${assetVersion}`),
          ]);
        }
      } catch (cause) {
        window.__LIGA_SKALAMA_SCRIPTS_LOADED__ = false;
        if (active) setError(cause.message || 'Falha ao abrir o sistema. Atualize a página para tentar novamente.');
      }
    }
    mountLegacyInterface();
    return () => { active = false; };
  }, []);

  return (
    <>
      {error ? <p role="alert" style={{ padding: 24 }}>{error}</p> : null}
      <div ref={container} />
    </>
  );
}

