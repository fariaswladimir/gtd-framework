// Contrato gtd-link/1 (L1) e ponta do GTD (L2).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.mjs';
import { validate, EXAMPLES, CONTRACT, refCovers } from '../server/link-contract.mjs';

let app, base, dir;
const TOKEN = 'link-token';
const call = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const sync = (mensagens = [], confirmados = []) => call('POST', '/api/link/sync', { sistema: 'diario', mensagens, confirmados });
const msg = (tipo, chave, alterado_em, dados, ligado_a) => ({ contrato: CONTRACT, tipo, chave, alterado_em, ...(ligado_a ? { ligado_a } : {}), dados });
const bootstrap = async () => (await call('GET', '/api/bootstrap')).body;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'gtd-link-'));
  app = createApp({ dataDir: dir, token: TOKEN });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => { app.server.close(); app.store.db.close(); rmSync(dir, { recursive: true, force: true }); });

// ---------- L1: contrato ----------
test('L1: exemplos do contrato são válidos', () => {
  for (const m of EXAMPLES) assert.deepEqual(validate(m), [], `${m.tipo} ${m.chave}`);
});
test('L1: rejeita contrato, chave, data e campos inválidos', () => {
  const [ok] = EXAMPLES;
  assert.match(validate({ ...ok, contrato: 'x' }).join(), /contrato/);
  assert.match(validate({ ...ok, chave: 'acao:1' }).join(), /chave inválida/);
  assert.match(validate({ ...ok, alterado_em: '17/10/2026' }).join(), /alterado_em/);
  assert.match(validate({ ...ok, dados: { ...ok.dados, texto: '' } }).join(), /texto é obrigatório/);
  assert.match(validate({ ...ok, dados: { ...ok.dados, prazo: '24/10/2026' } }).join(), /prazo/);
  assert.match(validate({ ...ok, dados: { ...ok.dados, estado: 'talvez' } }).join(), /estado/);
  assert.match(validate({ ...ok, tipo: 'acao.apagada' }).join(), /tipo desconhecido/);
  assert.match(validate(EXAMPLES.find(m => m.tipo === 'acao.concluida'), { from: 'diario' }).join(), /só pode ser enviado por "gtd"/);
});
test('L1: referência cobre descendentes', () => {
  assert.ok(refCovers('dd:eap:bib:4', 'dd:eap:bib:4_2_3'));
  assert.ok(refCovers('dd:eap:bib:4', 'dd:eap:bib:4'));
  assert.ok(!refCovers('dd:eap:bib:4', 'dd:eap:bib:41'));
  assert.ok(!refCovers('dd:eap:bib:4', 'dd:eap:dsr:4_1'));
});
test('L1: o documento e o esquema JSON citam todos os tipos', () => {
  const md = readFileSync(new URL('../docs/contrato-ligacao.md', import.meta.url), 'utf8');
  const schema = JSON.parse(readFileSync(new URL('../docs/contrato-ligacao.schema.json', import.meta.url), 'utf8'));
  for (const t of ['acao.upsert', 'acao.concluida', 'marco.status', 'bloqueio.aberto', 'bloqueio.fechado', 'captura.enviada']) {
    assert.ok(md.includes('`' + t + '`'), `md: ${t}`);
    assert.ok(schema.properties.tipo.enum.includes(t), `schema: ${t}`);
  }
});

// ---------- L2: ponta do GTD ----------
test('L2: criar ligação valida a referência e evita duplicata', async () => {
  const bad = await call('POST', '/api/links', { project: 'RSL XAI', ref: 'eap 4' });
  assert.equal(bad.status, 400);
  const a = await call('POST', '/api/links', { project: 'RSL XAI', ref: 'dd:eap:bib:4' });
  assert.equal(a.status, 201);
  assert.equal(a.body.project_name, 'RSL XAI em MAS');
  assert.equal((await call('POST', '/api/links', { project: 'RSL XAI', ref: 'dd:eap:bib:4' })).status, 409);
  assert.equal((await call('POST', '/api/links', { project: 'RSL XAI', ref: 'dd:gate:G3' })).status, 201);
});

test('L2: ação "eu" entra na inbox com hub do projeto; outra pessoa vai para Aguardando', async () => {
  const r = await sync([
    msg('acao.upsert', 'dd:acao:a1', '2026-10-17T10:00:00Z', { texto: 'Enviar Kappa à orientadora', responsavel: 'eu', prazo: '2026-10-24', estado: 'aberta' }, 'dd:eap:bib:4_2_3'),
    msg('acao.upsert', 'dd:acao:a2', '2026-10-17T10:00:00Z', { texto: 'Revisar amostra', responsavel: 'Orientadora', estado: 'aberta' }, 'dd:gate:G3'),
  ]);
  assert.deepEqual(r.body.aplicadas.map(a => a.resultado), ['criado', 'criado']);
  const b = await bootstrap();
  const it = b.items.inbox.find(i => i.source_ref === 'dd:acao:a1');
  assert.equal(it.source, 'Diário');
  assert.equal(it.hub, 'doutorado');
  assert.match(it.notes, /Prazo: 24\/10\/2026/);
  assert.equal(it.meta.project_id, b.projects.find(p => p.name === 'RSL XAI em MAS').id);
  const w = b.items.waiting.find(i => i.source_ref === 'dd:acao:a2');
  assert.match(w.destination, /Aguardando: Orientadora/);
});

test('L2: o mesmo lote duas vezes não duplica; mensagem mais antiga é ignorada', async () => {
  const before = (await bootstrap()).counts;
  const m = msg('acao.upsert', 'dd:acao:a1', '2026-10-17T10:00:00Z', { texto: 'Enviar Kappa à orientadora', responsavel: 'eu', estado: 'aberta' });
  const r1 = await sync([m]);
  const r2 = await sync([{ ...m, alterado_em: '2026-10-16T10:00:00Z' }]);
  assert.equal(r1.body.aplicadas[0].resultado, 'ignorado');
  assert.equal(r2.body.aplicadas[0].resultado, 'ignorado');
  assert.deepEqual((await bootstrap()).counts.inbox, before.inbox);
});

test('L2: atualização do Diário muda o texto enquanto o item está na inbox', async () => {
  const r = await sync([msg('acao.upsert', 'dd:acao:a1', '2026-10-17T11:00:00Z', { texto: 'Enviar planilha de Kappa à orientadora', responsavel: 'eu', prazo: '2026-10-25', estado: 'aberta' }, 'dd:eap:bib:4_2_3')]);
  assert.equal(r.body.aplicadas[0].resultado, 'atualizado');
  const it = (await bootstrap()).items.inbox.find(i => i.source_ref === 'dd:acao:a1');
  assert.equal(it.text, 'Enviar planilha de Kappa à orientadora');
  assert.match(it.notes, /25\/10\/2026/);
});

test('L2: concluir a tarefa gera acao.concluida; confirmar limpa a pendência', async () => {
  const it = (await bootstrap()).items.inbox.find(i => i.source_ref === 'dd:acao:a1');
  const p = await call('POST', `/api/items/${it.id}/process`, { action: 'tarefa', period: 'manhã', date: 'hoje' });
  assert.equal((await sync()).body.pendentes.length, 0, 'só processar não conclui');
  await call('PATCH', `/api/tasks/${p.body.task.id}`, { done: true });
  const r = await sync();
  assert.equal(r.body.pendentes.length, 1);
  const pend = r.body.pendentes[0];
  assert.equal(pend.tipo, 'acao.concluida');
  assert.equal(pend.chave, 'dd:acao:a1');
  assert.equal(pend.ligado_a, 'dd:eap:bib:4_2_3');
  assert.deepEqual(validate(pend, { from: 'gtd' }), []);
  assert.equal((await sync()).body.pendentes.length, 1, 'continua pendente até confirmar');
  assert.equal((await sync([], [pend.id])).body.pendentes.length, 0);
});

test('L2: ação marcada feita no Diário fecha a tarefa sem eco', async () => {
  await sync([msg('acao.upsert', 'dd:acao:a3', '2026-10-17T10:00:00Z', { texto: 'Atualizar protocolo', estado: 'aberta' })]);
  const it = (await bootstrap()).items.inbox.find(i => i.source_ref === 'dd:acao:a3');
  const p = await call('POST', `/api/items/${it.id}/process`, { action: 'tarefa', date: 'hoje' });
  await sync([msg('acao.upsert', 'dd:acao:a3', '2026-10-17T12:00:00Z', { texto: 'Atualizar protocolo', estado: 'feita' })]);
  const b = await bootstrap();
  assert.equal(b.today.periods.flatMap(x => x.tasks).find(t => t.id === p.body.task.id).done, true);
  assert.equal(b.link.pending.length, 0, 'não devolve acao.concluida para o dono');
});

test('L2: ação cancelada no Diário sai da inbox para o lixo', async () => {
  await sync([msg('acao.upsert', 'dd:acao:a4', '2026-10-17T10:00:00Z', { texto: 'Marcar banca', estado: 'aberta' })]);
  await sync([msg('acao.upsert', 'dd:acao:a4', '2026-10-17T13:00:00Z', { texto: 'Marcar banca', estado: 'cancelada' })]);
  const b = await bootstrap();
  assert.ok(!b.items.inbox.some(i => i.source_ref === 'dd:acao:a4'));
  assert.match(b.items.trash.find(i => i.source_ref === 'dd:acao:a4').destination, /Cancelada no Diário/);
});

test('L2: marco.status aparece no projeto ligado e no gtd_context', async () => {
  const r = await sync([msg('marco.status', 'dd:gate:G3', '2026-10-17T14:00:00Z', { titulo: 'Gate G3 · RSL → DSR', status: 'em_andamento', progresso: 33, pendencias: 'Kappa da leitura completa' }),
    msg('marco.status', 'dd:gate:G9', '2026-10-17T14:00:00Z', { titulo: 'Gate sem ligação' })]);
  assert.equal(r.body.aplicadas[0].resultado, 'criado');
  assert.match(r.body.aplicadas[1].motivo, /nenhum projeto ligado/);
  const links = (await call('GET', '/api/links?project=RSL')).body;
  assert.equal(links.find(l => l.ref === 'dd:gate:G3').mirror.dados.progresso, 33);
  const ctx = await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'gtd_context', arguments: { hub: 'doutorado' } } });
  assert.match(ctx.body.result.content[0].text, /No Diário \(dd:gate:G3\): Gate G3 · RSL → DSR · 33%/);
});

test('L2: bloqueio aberto vira alerta e fechado o remove', async () => {
  await sync([msg('bloqueio.aberto', 'dd:bloqueio:b1', '2026-10-17T15:00:00Z', { texto: 'Segundo revisor indisponível' }, 'dd:eap:bib:4_3')]);
  let alerts = (await bootstrap()).alerts;
  assert.ok(alerts.some(a => a.code === 'bloqueio_externo' && /RSL XAI em MAS/.test(a.text) && /Segundo revisor/.test(a.text)));
  await sync([msg('bloqueio.fechado', 'dd:bloqueio:b1', '2026-10-17T16:00:00Z', {})]);
  alerts = (await bootstrap()).alerts;
  assert.ok(!alerts.some(a => a.code === 'bloqueio_externo'));
});

test('L2: dono decide — o GTD recusa mensagens de que ele é dono e mensagens inválidas', async () => {
  const r = await sync([msg('acao.concluida', 'dd:acao:a1', '2026-10-17T15:00:00Z', { concluida_em: '2026-10-17T15:00:00Z' }), { tipo: 'lixo' }]);
  assert.deepEqual(r.body.aplicadas.map(a => a.resultado), ['recusado', 'recusado']);
  assert.match(r.body.aplicadas[0].motivo, /só pode ser enviado por "gtd"/);
  const log = (await call('GET', '/api/link/log?limit=5')).body;
  assert.ok(log.some(l => l.resultado === 'recusado'));
});

test('L2: "→ Diário" gera captura.enviada com a referência do projeto', async () => {
  const c = await call('POST', '/api/items', { text: 'Ideia: Kappa ponderado', hub: 'doutorado' });
  await call('POST', `/api/items/${c.body.item.id}/process`, { action: 'diario', project: 'RSL XAI' });
  const pend = (await sync()).body.pendentes.find(p => p.tipo === 'captura.enviada');
  assert.equal(pend.chave, `gtd:item:${c.body.item.id}`);
  assert.equal(pend.ligado_a, 'dd:eap:bib:4');
  assert.equal(pend.dados.texto, 'Ideia: Kappa ponderado');
  assert.deepEqual(validate(pend, { from: 'gtd' }), []);
});

test('L2: MCP gtd_link_sync e gtd_links', async () => {
  const list = await call('POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = list.body.result.tools.map(t => t.name);
  assert.ok(names.includes('gtd_link_sync') && names.includes('gtd_links'));
  const r = await call('POST', '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gtd_link_sync', arguments: {
    sistema: 'diario', mensagens: [msg('acao.upsert', 'dd:acao:m1', '2026-10-17T10:00:00Z', { texto: 'Via MCP' })] } } });
  assert.equal(JSON.parse(r.body.result.content[0].text).aplicadas[0].resultado, 'criado');
  const l = await call('POST', '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'gtd_links', arguments: {} } });
  assert.ok(JSON.parse(l.body.result.content[0].text).links.length >= 2);
});

test('L2: backup leva as ligações junto', async () => {
  const ex = (await call('GET', '/api/export')).body;
  assert.ok(ex.link.links.length >= 2);
  assert.ok(ex.link.keys.some(k => k.chave === 'dd:gate:G3'));
});
