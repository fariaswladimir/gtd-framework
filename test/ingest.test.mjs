// Ingestão geral: texto colado com itens, links, listas e hubs misturados.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.mjs';
import { parseBulk, normalizeUrl } from '../server/ingest.mjs';

let app, base, dir, site, siteUrl;
const TOKEN = 'ingest-token';
const call = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'gtd-ingest-'));
  app = createApp({ dataDir: dir, token: TOKEN, seed: false });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  // site de teste para a busca de títulos
  site = http.createServer((req, res) => {
    if (req.url === '/artigo') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<html><head><title>Explicabilidade em SMA &amp; LLM</title></head><body>x</body></html>'); }
    else if (req.url === '/og') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<meta property="og:title" content="Título OG"><title>fallback</title>'); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(r => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${site.address().port}`;
});
after(() => { app.server.close(); site.close(); app.store.db.close(); rmSync(dir, { recursive: true, force: true }); });

test('linhas: listas, checkboxes feitos ignorados, links viram url', () => {
  const r = parseBulk(`- Ligar para a orientadora
- [x] já feito
1. Ler artigo https://arxiv.org/abs/2401.00001 — sobre XAI
* https://github.com/usuario/rsl-xai-mas/issues/12
[ ] Revisar slides`);
  assert.equal(r.length, 4);
  assert.deepEqual(r.map(x => x.text), ['Ligar para a orientadora', 'Ler artigo — sobre XAI', 'github.com/usuario/rsl-xai-mas/issues/12', 'Revisar slides']);
  assert.equal(r[1].url, 'https://arxiv.org/abs/2401.00001');
  assert.equal(r[2].sem_titulo, true);
  assert.equal(r[2].source_ref, 'url:https://github.com/usuario/rsl-xai-mas/issues/12');
});

test('hubs: #tag no item e título markdown valem para os itens abaixo', () => {
  const r = parseBulk(`Item solto
## Doutorado
Revisar protocolo
Comprar teclado #pessoal
## Side projects
MANGUE: arte da cena 4
## Anotações gerais
Sem hub`);
  assert.deepEqual(r.map(x => [x.text, x.hub]), [
    ['Item solto', null], ['Revisar protocolo', 'doutorado'], ['Comprar teclado', 'pessoal'],
    ['MANGUE: arte da cena 4', 'side-projects'], ['Sem hub', null]]);
});

test('hub padrão vale quando o texto não define outro', () => {
  const r = parseBulk('A\nB #edge', { hub: 'doutorado' });
  assert.deepEqual(r.map(x => x.hub), ['doutorado', 'edge']);
});

test('blocos: primeira linha é o título, o resto vira notas, link do bloco vai para url', () => {
  const r = parseBulk(`Reunião com a orientadora
Pauta: Kappa e extração
https://meet.google.com/abc-defg-hij

Ideia para o MANGUE
cena de abertura no mangue ao amanhecer`, { mode: 'blocos' });
  assert.equal(r.length, 2);
  assert.equal(r[0].text, 'Reunião com a orientadora');
  assert.match(r[0].notes, /Pauta: Kappa/);
  assert.equal(r[0].url, 'https://meet.google.com/abc-defg-hij');
  assert.equal(r[1].notes, 'cena de abertura no mangue ao amanhecer');
});

test('normaliza links: tira rastreio, âncora, barra final e pontuação colada', () => {
  assert.equal(normalizeUrl('https://site.com/a/?utm_source=x&id=3#topo'), 'https://site.com/a/?id=3');
  assert.equal(normalizeUrl('https://site.com/a/).'), 'https://site.com/a');
});

test('pré-visualização não grava; captura grava; o mesmo link não duplica', async () => {
  const text = `Ler artigo https://exemplo.org/x?utm_source=feed #doutorado\nOutra ideia`;
  const prev = await call('POST', '/api/ingest/geral', { text, dry: true });
  assert.equal(prev.body.previa, true);
  assert.equal(prev.body.total, 2);
  assert.equal((await call('GET', '/api/items')).body.length, 0, 'prévia não grava nada');
  const cap = await call('POST', '/api/ingest/geral', { text, source: 'Web' });
  assert.equal(cap.body.captured.length, 2);
  assert.equal(cap.body.captured[0].hub, 'doutorado');
  assert.equal(cap.body.captured[0].url, 'https://exemplo.org/x');
  const again = await call('POST', '/api/ingest/geral', { text: 'Mesmo link, outro texto https://exemplo.org/x#sec', source: 'Web', dry: true });
  assert.equal(again.body.itens[0].ja_existe, true);
  assert.equal(again.body.novos, 0);
});

test('busca o título da página para links sem texto', async () => {
  const r = await call('POST', '/api/ingest/geral', { text: `${siteUrl}/artigo\n${siteUrl}/og\n${siteUrl}/nao-existe`, titulos: true, dry: true });
  assert.deepEqual(r.body.itens.map(i => i.text), ['Explicabilidade em SMA & LLM', 'Título OG', `127.0.0.1:${new URL(siteUrl).port}/nao-existe`]);
  assert.deepEqual(r.body.itens.map(i => i.titulo_buscado), [true, true, false]);
});

test('MCP: gtd_capture com texto livre', async () => {
  const r = await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'gtd_capture', arguments: {
    texto: '## Edge\nPauta da retro\nhttps://teams.microsoft.com/l/meetup #edge', source: 'Claude' } } });
  const text = r.body.result.content[0].text;
  assert.match(text, /\+ capturado .*Pauta da retro/);
  const items = (await call('GET', '/api/items?hub=edge')).body;
  assert.ok(items.some(i => i.url === 'https://teams.microsoft.com/l/meetup'));
});
