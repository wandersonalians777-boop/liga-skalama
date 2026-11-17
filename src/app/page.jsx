'use client';

import { useEffect, useRef, useState } from 'react';

const base = '';
const assetVersion = process.env.NEXT_PUBLIC_ASSET_VERSION || 'dev';
const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/dist/umd/supabase.js';

// async=false: os scripts baixam ao mesmo tempo, mas executam na ordem em que foram inseridos.
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
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
            loadScript(SUPABASE_JS),
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

