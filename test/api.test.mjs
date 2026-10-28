// Testes de ponta a ponta: sobe o servidor numa pasta temporária e exercita API, ingestão e MCP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.mjs';

let app, base, dir;
const TOKEN = 'test-token';
const call = async (method, p, body, { token = TOKEN, type = 'application/json', headers = {} } = {}) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': type, Authorization: `Bearer ${token}`, ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
};

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'gtd-test-'));
  app = createApp({ dataDir: dir, token: TOKEN });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => { app.server.close(); app.store.db.close(); rmSync(dir, { recursive: true, force: true }); });

test('auth obrigatória e health público', async () => {
  assert.equal((await call('GET', '/api/bootstrap', undefined, { token: 'x' })).status, 401);
  assert.equal((await call('GET', '/health', undefined, { token: '' })).status, 200);
});

test('semente carregada do framework original', async () => {
  const { body } = await call('GET', '/api/bootstrap');
  assert.equal(body.projects.length, 17);
  assert.equal(body.items.inbox.length, 16);
  assert.equal(body.today.total, 7);
  assert.equal(body.projects.filter(p => p.status === 'ativo').length, 7);
});

test('captura, deduplicação e processamento para projeto/tarefa', async () => {
  const a = await call('POST', '/api/items', { text: 'Ideia X', source: 'Lovable', source_ref: 'lv-1', hub: 'side-projects' });
  assert.equal(a.status, 201);
  const dup = await call('POST', '/api/items', { text: 'Ideia X', source: 'Lovable', source_ref: 'lv-1' });
  assert.equal(dup.body.duplicate, true);
  const p = await call('POST', `/api/items/${a.body.item.id}/process`, { action: 'projeto', project: 'HQ autoral' });
  assert.equal(p.status, 200);
  assert.ok(p.body.project.steps.includes('Ideia X'));
  const b = await call('POST', '/api/items', { text: 'Ligar para orientadora' });
  const t = await call('POST', `/api/items/${b.body.item.id}/process`, { action: 'tarefa', period: 'manhã', date: 'amanhã' });
  assert.equal(t.body.task.period, 'manhã');
  assert.equal(t.body.item.bucket, 'processed');
});

test('ingestão: texto em lote, e-mail e GitHub', async () => {
  const txt = await call('POST', '/api/ingest/keep', '- [ ] comprar café\n- [x] já feito\n* revisar slides\n\n# título', { type: 'text/plain' });
  assert.equal(txt.body.captured.length, 2);
  assert.equal(txt.body.captured[0].source, 'Google Keep');
  const mail = await call('POST', '/api/ingest/email', { from: 'a@b.com', subject: 'Reunião', snippet: 'amanhã 10h', messageId: 'm1' });
  assert.equal(mail.body.captured[0].text, 'Reunião');
  const gh = await call('POST', '/api/ingest/github', { action: 'opened', repository: { full_name: 'usuario/rsl-xai-mas' },
    issue: { number: 7, title: 'Bug no corpus', html_url: 'https://github.com/x', body: '' } },
  { headers: { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': 'd-1' } });
  assert.equal(gh.body.captured[0].hub, 'doutorado');
});

test('WIP bloqueia ativação acima do limite', async () => {
  const r = await call('PATCH', '/api/projects/Raio-X', { status: 'ativo' });
  assert.equal(r.status, 409);
  const f = await call('PATCH', '/api/projects/Raio-X?force=1', { status: 'ativo' });
  assert.equal(f.body.status, 'ativo');
  await call('PATCH', '/api/projects/Raio-X', { status: 'backlog' });
});

test('operações de projeto: avançar etapa e mover kanban', async () => {
  const s = await call('PATCH', '/api/projects/Survey', { advance_step: true });
  assert.equal(s.body.current_step, 2);
  const k = await call('PATCH', '/api/projects/Trabalho%20principal', { kanban_move: { card: 'Sprint Review', to: 'doing' } });
  assert.ok(k.body.kanban.doing.some(c => c.startsWith('Sprint Review')));
});

test('MCP: initialize, tools/list, tools/call, notificação', async () => {
  const init = await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(init.body.result.serverInfo.name, 'gtd-framework');
  const notif = await call('POST', '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notif.status, 202);
  const list = await call('POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(list.body.result.tools.find(t => t.name === 'gtd_context'));
  const ctx = await call('POST', '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gtd_context', arguments: { hub: 'doutorado' } } });
  assert.match(ctx.body.result.content[0].text, /RSL XAI em MAS/);
  const cap = await call('POST', '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'gtd_capture', arguments: { text: 'via MCP' } } });
  assert.match(cap.body.result.content[0].text, /capturado/);
  const bad = await call('POST', '/mcp', { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'gtd_process', arguments: { id: 'nope', action: 'trash' } } });
  assert.equal(bad.body.result.isError, true);
});

test('export/import ida e volta', async () => {
  const ex = await call('GET', '/api/export');
  assert.equal(ex.body._meta.app, 'GTD Server');
  const im = await call('POST', '/api/import', ex.body);
  assert.ok(im.body.imported > 0);
  const legacy = await call('POST', '/api/import', { _meta: { app: 'GTD Framework' }, 'gtd-inbox': { inbox: [{ text: 'legado', source: 'Gmail' }], someday: [], reference: [], trash: [] } });
  assert.equal(legacy.body.mode, 'legacy');
});
