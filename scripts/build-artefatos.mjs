// Gera docs/artefatos.html: uma página navegável com todos os artefatos do projeto
// (EAP, README, contrato, guias, código de integração), renderizados a partir dos arquivos.
// Uso: node scripts/build-artefatos.mjs
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLANO_URL = 'https://claude.ai/artifact/Uv1ViLwctzk9dfXT1UbqSb';

const DOCS = [
  { id: 'eap', grupo: 'Gestão', titulo: 'EAP do projeto', arquivo: 'EAP.md', tipo: 'md' },
  { id: 'readme', grupo: 'Gestão', titulo: 'README', arquivo: 'README.md', tipo: 'md' },
  { id: 'plano', grupo: 'Gestão', titulo: 'Plano de integração com o Diário', arquivo: 'docs/plano-integracao-diario.html', tipo: 'link', url: PLANO_URL },
  { id: 'contrato', grupo: 'Ligação com o Diário', titulo: 'Contrato gtd-link/1', arquivo: 'docs/contrato-ligacao.md', tipo: 'md' },
  { id: 'schema', grupo: 'Ligação com o Diário', titulo: 'Esquema JSON do contrato', arquivo: 'docs/contrato-ligacao.schema.json', tipo: 'code', lang: 'json' },
  { id: 'fontes', grupo: 'Integrações', titulo: 'Fontes de captura', arquivo: 'integrations/fontes.md', tipo: 'md' },
  { id: 'lovable', grupo: 'Integrações', titulo: 'Conectar apps Lovable', arquivo: 'integrations/lovable.md', tipo: 'md' },
  { id: 'gmail', grupo: 'Integrações', titulo: 'Gmail → GTD (Apps Script)', arquivo: 'integrations/gmail-apps-script.gs', tipo: 'code', lang: 'javascript' },
];

const git = cmd => { try { return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return ''; } };
const commit = git('git log -1 --format=%h');
const docs = DOCS.map(d => {
  const file = path.join(ROOT, d.arquivo);
  return { ...d, conteudo: d.tipo === 'link' ? '' : readFileSync(file, 'utf8'), alterado: statSync(file).mtime.toISOString(),
    ultimoCommit: git(`git log -1 --format=%h·%cs -- "${d.arquivo}"`) || 'não commitado' };
});
const geradoEm = new Date().toISOString();
const data = JSON.stringify({ docs, commit, geradoEm }).replace(/</g, '\\u003c');

const html = `<title>Artefatos do GTD Framework</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap">
<script src="https://cdnjs.cloudflare.com/ajax/libs/marked/4.3.0/marked.min.js"></script>
<style>
/* Layout: biblioteca de documentos — índice à esquerda (vira faixa no celular), leitura em coluna de ~70ch à direita. */
:root{
  --bg:#EEF1F3; --surface:#FFFFFF; --surface2:#F4F6F8; --ink:#15212B; --muted:#5B6B78; --line:#D3DAE0;
  --accent:#0B6E75; --accent-soft:#D8EDEF; --ok:#23764A; --ok-soft:#DDF0E4; --warn:#8F5A00; --warn-soft:#FBEBCB;
  --f-display:'Bricolage Grotesque','Segoe UI',system-ui,sans-serif;
  --f-body:'IBM Plex Sans',system-ui,-apple-system,'Segoe UI',sans-serif;
  --f-mono:'JetBrains Mono',ui-monospace,Consolas,Menlo,monospace;
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){
  --bg:#0E151B; --surface:#16202A; --surface2:#1C2833; --ink:#E4EBF1; --muted:#90A2B1; --line:#2B3C4C;
  --accent:#56C3CC; --accent-soft:#12383D; --ok:#5CC88C; --ok-soft:#173A29; --warn:#E3B04B; --warn-soft:#3C2E10; color-scheme:dark}}
:root[data-theme="dark"]{
  --bg:#0E151B; --surface:#16202A; --surface2:#1C2833; --ink:#E4EBF1; --muted:#90A2B1; --line:#2B3C4C;
  --accent:#56C3CC; --accent-soft:#12383D; --ok:#5CC88C; --ok-soft:#173A29; --warn:#E3B04B; --warn-soft:#3C2E10; color-scheme:dark}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font:400 15px/1.65 var(--f-body);padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));padding-block:24px 64px}
.app{max-width:1180px;margin:0 auto;display:grid;grid-template-columns:260px minmax(0,1fr);gap:24px;align-items:start}
@media (max-width:800px){.app{grid-template-columns:minmax(0,1fr)}}
header.top{grid-column:1/-1;display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap}
h1{margin:0;font:700 clamp(24px,4vw,32px)/1.1 var(--f-display);letter-spacing:-.015em}
.meta{font:500 12px var(--f-mono);color:var(--muted)}
nav.idx{position:sticky;top:calc(16px + env(safe-area-inset-top,0px));display:flex;flex-direction:column;gap:14px}
@media (max-width:800px){nav.idx{position:static;flex-direction:row;overflow-x:auto;gap:8px;padding-bottom:4px}}
.grp{display:flex;flex-direction:column;gap:4px}
@media (max-width:800px){.grp{flex-direction:row;gap:6px}.grp-t{display:none}}
.grp-t{font:600 11px var(--f-mono);text-transform:uppercase;letter-spacing:.08em;color:var(--muted);padding:0 10px}
.doc-btn{text-align:left;font:500 14px var(--f-body);color:var(--ink);background:transparent;border:1px solid transparent;border-radius:6px;padding:8px 10px;cursor:pointer;white-space:nowrap}
.doc-btn:hover{background:var(--surface)}
.doc-btn[aria-current="true"]{background:var(--surface);border-color:var(--accent);color:var(--accent)}
.doc-btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
main{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:24px 28px;min-width:0}
@media (max-width:520px){main{padding:18px 16px}}
.dochead{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline;border-bottom:1px solid var(--line);padding-bottom:12px;margin-bottom:16px}
.path{font:500 12.5px var(--f-mono);color:var(--muted);overflow-wrap:anywhere}
.tag{display:inline-block;font:600 10.5px/1 var(--f-mono);text-transform:uppercase;letter-spacing:.06em;padding:4px 8px;border-radius:999px;background:var(--ok-soft);color:var(--ok)}
.tag.warn{background:var(--warn-soft);color:var(--warn)}
.md{max-width:76ch}
.md h1,.md h2,.md h3{font-family:var(--f-display);letter-spacing:-.01em;text-wrap:balance;line-height:1.2}
.md h1{font-size:26px;margin:0 0 12px}.md h2{font-size:20px;margin:28px 0 10px}.md h3{font-size:16px;margin:20px 0 8px}
.md p,.md ul,.md ol{margin:0 0 12px}
.md li{margin:3px 0}
.md a{color:var(--accent)}
.md code{font:500 .86em var(--f-mono);background:var(--surface2);padding:1px 5px;border-radius:4px}
.md pre,.code{background:var(--surface2);border:1px solid var(--line);border-radius:8px;padding:12px 14px;overflow-x:auto;font:400 12.5px/1.55 var(--f-mono);margin:0 0 14px}
.md pre code{background:none;padding:0}
.md table{border-collapse:collapse;display:block;overflow-x:auto;margin:0 0 14px;font-size:14px}
.md th,.md td{border:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top}
.md th{background:var(--surface2);font-weight:600}
.md blockquote{margin:0 0 12px;padding:8px 14px;border-left:3px solid var(--accent);background:var(--surface2);border-radius:0}
.linkcard{display:flex;flex-direction:column;gap:10px;max-width:60ch}
.linkcard a{color:var(--accent);font-weight:600}
.empty{color:var(--muted)}
</style>

<div class="app">
  <header class="top">
    <div><div class="meta">GTD Framework · gtd-framework/</div><h1>Artefatos do projeto</h1></div>
    <div class="meta" id="gen"></div>
  </header>
  <nav class="idx" id="idx" aria-label="Artefatos"></nav>
  <main id="view" aria-live="polite"><p class="empty">Carregando…</p></main>
</div>

<script>
var DATA = ${data};
(function(){
  'use strict';
  var esc = function(s){ return String(s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); };
  var fmt = function(iso){ try { return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); } catch (e) { return iso; } };
  document.getElementById('gen').textContent = 'Gerado em ' + fmt(DATA.geradoEm) + (DATA.commit ? ' · commit ' + DATA.commit : '');
  var groups = [];
  DATA.docs.forEach(function(d){ var g = groups.filter(function(x){ return x.n === d.grupo; })[0]; if (!g) groups.push(g = { n: d.grupo, docs: [] }); g.docs.push(d); });
  var idx = document.getElementById('idx');
  idx.innerHTML = groups.map(function(g){
    return '<div class="grp"><div class="grp-t">' + esc(g.n) + '</div>' + g.docs.map(function(d){
      return '<button class="doc-btn" id="b-' + d.id + '" data-id="' + d.id + '">' + esc(d.titulo) + '</button>'; }).join('') + '</div>';
  }).join('');
  function render(md){
    if (window.marked) { try { return window.marked.parse(md, { mangle: false, headerIds: false }); } catch (e) {} }
    return '<pre class="code">' + esc(md) + '</pre>';
  }
  function show(id){
    var d = DATA.docs.filter(function(x){ return x.id === id; })[0] || DATA.docs[0];
    idx.querySelectorAll('.doc-btn').forEach(function(b){ b.setAttribute('aria-current', String(b.dataset.id === d.id)); });
    var head = '<div class="dochead"><span class="path">' + esc(d.arquivo) + '</span><span><span class="tag' + (d.ultimoCommit === 'não commitado' ? ' warn' : '') + '">' + esc(d.ultimoCommit === 'não commitado' ? 'não commitado' : 'commit ' + d.ultimoCommit) + '</span></span></div>';
    var body;
    if (d.tipo === 'md') body = '<div class="md">' + render(d.conteudo) + '</div>';
    else if (d.tipo === 'code') body = '<pre class="code"><code>' + esc(d.conteudo) + '</code></pre>';
    else body = '<div class="linkcard"><p>Este artefato é uma página interativa própria, com a demonstração de troca do tipo de controle.</p><a href="' + esc(d.url) + '" target="_blank" rel="noopener">Abrir o plano de integração ↗</a><p class="meta">Arquivo local: ' + esc(d.arquivo) + '</p></div>';
    var view = document.getElementById('view');
    view.innerHTML = head + body;
    view.querySelectorAll('.md a[href]').forEach(function(a){ if (/^https?:/.test(a.getAttribute('href'))) { a.target = '_blank'; a.rel = 'noopener'; } });
    try { localStorage.setItem('gtd-artefatos-doc', d.id); } catch (e) {}
  }
  idx.addEventListener('click', function(e){ var b = e.target.closest('.doc-btn'); if (b) { show(b.dataset.id); window.scrollTo(0, 0); } });
  var start = (location.hash || '').slice(1);
  if (!DATA.docs.some(function(d){ return d.id === start; })) { try { start = localStorage.getItem('gtd-artefatos-doc') || 'eap'; } catch (e) { start = 'eap'; } }
  show(start);
})();
</script>
`;
writeFileSync(path.join(ROOT, 'docs', 'artefatos.html'), html);
console.log(`docs/artefatos.html gerado com ${docs.length} artefatos (commit ${commit || '—'})`);
