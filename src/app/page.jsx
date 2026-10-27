'use client';

import { useEffect, useRef, useState } from 'react';

const base = '/liga-skalama';
const assetVersion = process.env.NEXT_PUBLIC_ASSET_VERSION || 'dev';

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
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
        const response = await fetch(`${base}/app-markup.html?v=${assetVersion}`, { cache: "no-store" });
        if (!response.ok) throw new Error('Não foi possível carregar a interface da Liga Skalama.');
        const markup = await response.text();
        if (!active || !container.current) return;
        container.current.innerHTML = markup;
        if (!window.__LIGA_SKALAMA_SCRIPTS_LOADED__) {
          window.__LIGA_SKALAMA_SCRIPTS_LOADED__ = true;
          await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/dist/umd/supabase.js');
          await loadScript(`${base}/app-live.js?v=${assetVersion}`);
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

