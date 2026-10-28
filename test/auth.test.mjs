// Login da interface: dono único (e-mail) + senha, sessão por cookie, token só para integrações.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.mjs';
import { hashPassword, verifyPassword } from '../server/auth.mjs';

let app, base, dir;
const TOKEN = 'auth-token';
const OWNER = 'dono@exemplo.com';
const PASS = 'senha-forte-123';
const req = async (method, p, { body, cookie, headers = {} } = {}) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, body: await res.json().catch(() => null), cookie: setCookie ? setCookie.split(';')[0] : null, setCookie };
};

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'gtd-auth-'));
  app = createApp({ dataDir: dir, token: TOKEN, seed: false, ownerEmail: OWNER });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => { app.server.close(); app.store.db.close(); rmSync(dir, { recursive: true, force: true }); });

test('hash de senha com scrypt confere e rejeita senha errada', () => {
  const h = hashPassword('abc-123-xyz');
  assert.match(h, /^scrypt\$/);
  assert.ok(verifyPassword('abc-123-xyz', h));
  assert.ok(!verifyPassword('outra', h));
});

let cookie;
test('sem senha criada: interface pede para criar, API exige autenticação', async () => {
  const s = await req('GET', '/api/session');
  assert.equal(s.status, 401);
  assert.equal(s.body.setup, true);
  assert.equal((await req('GET', '/api/bootstrap')).status, 401);
});

test('criar senha: só o e-mail do dono, só no próprio computador, senha mínima', async () => {
  assert.equal((await req('POST', '/api/setup', { body: { email: 'outra@pessoa.com', password: PASS } })).status, 403);
  assert.equal((await req('POST', '/api/setup', { body: { email: OWNER, password: 'curta' } })).status, 400);
  const viaTunel = await req('POST', '/api/setup', { body: { email: OWNER, password: PASS }, headers: { 'cf-connecting-ip': '203.0.113.9' } });
  assert.equal(viaTunel.status, 403);
  const ok = await req('POST', '/api/setup', { body: { email: ' Dono@Exemplo.com ', password: PASS } });
  assert.equal(ok.status, 200);
  assert.match(ok.setCookie, /HttpOnly/);
  assert.match(ok.setCookie, /SameSite=Strict/);
  cookie = ok.cookie;
  const cfg = JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(cfg.owner_email, OWNER);
  assert.ok(!JSON.stringify(cfg).includes(PASS), 'a senha não fica em texto no arquivo');
  assert.equal((await req('POST', '/api/setup', { body: { email: OWNER, password: PASS } })).status, 409);
});

test('com sessão: acessa os dados e recebe o token das integrações', async () => {
  assert.equal((await req('GET', '/api/bootstrap', { cookie })).status, 200);
  const s = await req('GET', '/api/session', { cookie });
  assert.equal(s.body.logged, true);
  assert.equal(s.body.token, TOKEN);
});

test('o token continua valendo para integrações (sem login)', async () => {
  const r = await req('GET', '/api/items', { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(r.status, 200);
});

test('pedido de outro site com o cookie é recusado', async () => {
  const r = await req('POST', '/api/items', { cookie, body: { text: 'x' }, headers: { Origin: 'https://site-malicioso.com' } });
  assert.equal(r.status, 401);
  const ok = await req('POST', '/api/items', { cookie, body: { text: 'do próprio site' }, headers: { Origin: base } });
  assert.equal(ok.status, 201);
});

test('sair encerra a sessão no navegador', async () => {
  const r = await req('POST', '/api/logout', { cookie });
  assert.match(r.setCookie, /Max-Age=0/);
});

test('entrar: e-mail ou senha errados falham com a mesma mensagem; 5 erros bloqueiam', async () => {
  const ip = { 'x-forwarded-for': '198.51.100.7' };
  const a = await req('POST', '/api/login', { body: { email: 'outra@pessoa.com', password: PASS }, headers: ip });
  const b = await req('POST', '/api/login', { body: { email: OWNER, password: 'errada-errada' }, headers: ip });
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.equal(a.body.error, b.body.error);
  for (let i = 0; i < 3; i++) await req('POST', '/api/login', { body: { email: OWNER, password: 'errada-errada' }, headers: ip });
  const locked = await req('POST', '/api/login', { body: { email: OWNER, password: PASS }, headers: ip });
  assert.equal(locked.status, 429);
  const outroIp = await req('POST', '/api/login', { body: { email: 'DONO@exemplo.com', password: PASS }, headers: { 'x-forwarded-for': '198.51.100.8' } });
  assert.equal(outroIp.status, 200);
  cookie = outroIp.cookie;
  assert.equal((await req('GET', '/api/bootstrap', { cookie })).status, 200);
});

test('trocar a senha encerra as outras sessões', async () => {
  const outra = (await req('POST', '/api/login', { body: { email: OWNER, password: PASS } })).cookie;
  assert.equal((await req('POST', '/api/password', { cookie, body: { current: 'errada-errada', password: 'nova-senha-456' } })).status, 401);
  const r = await req('POST', '/api/password', { cookie, body: { current: PASS, password: 'nova-senha-456' } });
  assert.equal(r.status, 200);
  assert.equal((await req('GET', '/api/bootstrap', { cookie: outra })).status, 401, 'sessão antiga encerrada');
  assert.equal((await req('GET', '/api/bootstrap', { cookie: r.cookie })).status, 200, 'nova sessão vale');
  assert.equal((await req('POST', '/api/login', { body: { email: OWNER, password: 'nova-senha-456' } })).status, 200);
});
