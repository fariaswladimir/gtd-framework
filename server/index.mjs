// Servidor HTTP do GTD: API REST + MCP (/mcp) + SSE (/api/stream) + UI estática.
// Sem dependências: node:http + node:sqlite (Node ≥ 22.13).
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, createReadStream } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store, GtdError, LANES, WIP_GLOBAL, DAILY_MAX, PERIODS, HUBS, SOURCES, STATE_KEYS, today, addDays } from './store.mjs';
import { ingest } from './ingest.mjs';
import { createMcp } from './mcp.mjs';
import { openapi } from './openapi.mjs';
import { LinkService } from './link.mjs';
import { createAuth } from './auth.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

const REPLY = Symbol('reply');
/** Resposta HTTP explícita (status/headers/corpo cru). Qualquer outro retorno vira JSON 200. */
const R = o => ({ [REPLY]: true, ...o });

export function loadConfig(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'config.json');
  let cfg = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  if (!cfg.token) { cfg.token = randomBytes(24).toString('base64url'); writeFileSync(file, JSON.stringify(cfg, null, 2)); }
  return cfg;
}

export function createApp({ dataDir = process.env.GTD_DATA || path.join(ROOT, 'data'), token, seed = process.env.GTD_SEED !== '0', dbFile, ownerEmail } = {}) {
  const cfg = loadConfig(dataDir);
  const TOKEN = token || process.env.GTD_TOKEN || cfg.token;
  const auth = createAuth({ cfg, cfgFile: path.join(dataDir, 'config.json'), ownerEmail: ownerEmail || process.env.GTD_OWNER_EMAIL });
  const store = new Store(dbFile || path.join(dataDir, 'gtd.db'), { seed });
  const link = new LinkService(store);
  const mcp = createMcp(store, { version: VERSION });
  const sse = new Set();

  // ---- propagação de eventos: SSE + webhooks de saída ----
  store.on('event', ev => {
    const line = `event: change\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const res of sse) res.write(line);
    const hooks = store.getState('webhooks', []) || [];
    for (const h of hooks) {
      if (!h?.url || h.enabled === false) continue;
      if (h.events?.length && !h.events.some(p => ev.type.startsWith(p))) continue;
      fetch(h.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(h.secret ? { 'X-GTD-Secret': h.secret } : {}) },
        body: JSON.stringify({ event: ev.type, ts: ev.ts, entity_id: ev.entity_id, summary: ev.summary, data: ev.data }),
        signal: AbortSignal.timeout(8000) }).catch(() => {});
    }
  });

  // ---- roteamento ----
  const routes = [];
  const route = (method, pattern, handler, { auth = true } = {}) => routes.push({
    method, auth, handler, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '/?$'),
  });

  const bootstrap = () => {
    const items = {};
    for (const b of ['inbox', 'waiting', 'someday', 'reference', 'trash', 'processed']) items[b] = store.listItems({ bucket: b, limit: b === 'inbox' ? 500 : 150 });
    const state = {};
    for (const k of [...STATE_KEYS, 'default_subs']) if (k !== 'webhooks') state[k] = store.getState(k);
    state.webhooks = store.getState('webhooks', []);
    return {
      meta: { version: VERSION, today: today(), lanes: LANES, wip_global: WIP_GLOBAL, daily_max: DAILY_MAX, periods: PERIODS, hubs: HUBS, sources: SOURCES, root: ROOT },
      items, counts: store.counts(), projects: store.listProjects(),
      today: store.dayView(), tomorrow: store.listTasks({ date: addDays(today(), 1) }),
      reviews: store.reviews(), alerts: store.alerts(), state, events: store.events({ limit: 25 }),
      link: { status: link.status(), links: link.listLinks(), blockers: link.blockers(), pending: link.pending(), log: link.log({ limit: 20 }) },
    };
  };

  route('GET', '/health', () => ({ ok: true, app: 'gtd-framework', version: VERSION, today: today() }), { auth: false });

  // Login da interface (dono único). O token fica só para integrações e aparece para quem está logado.
  route('GET', '/api/session', ({ req }) => {
    const st = auth.status(req);
    return st.logged ? { ...st, token: TOKEN } : R({ status: 401, body: st });
  }, { auth: false });
  const loggedIn = r => R({ body: { logged: true, email: r.email, token: TOKEN }, headers: { 'Set-Cookie': r.cookie } });
  route('POST', '/api/setup', ({ req, body }) => loggedIn(auth.setup(req, body || {})), { auth: false });
  route('POST', '/api/login', ({ req, body }) => loggedIn(auth.login(req, body || {})), { auth: false });
  route('POST', '/api/logout', ({ req }) => R({ body: { logged: false }, headers: { 'Set-Cookie': auth.clearCookie(req) } }), { auth: false });
  route('POST', '/api/password', ({ req, body }) => R({ body: { ok: true }, headers: { 'Set-Cookie': auth.changePassword(req, body || {}).cookie } }));
  route('GET', '/api/openapi.json', ({ base }) => openapi(base), { auth: false });
  route('GET', '/api/bootstrap', bootstrap);
  route('GET', '/api/context', ({ query }) => (query.format === 'json' ? store.context({ hub: query.hub }) : R({ raw: store.contextMarkdown({ hub: query.hub }), type: 'text/markdown; charset=utf-8' })));
  route('GET', '/api/alerts', () => store.alerts());

  route('GET', '/api/items', ({ query }) => store.listItems(query));
  const capture = ({ body }) => {
    const list = Array.isArray(body) ? body : body?.items || [body];
    const res = store.captureMany(list.map(x => (typeof x === 'string' ? { text: x } : x)));
    return R({ status: 201, body: Array.isArray(body) || body?.items ? res : res[0] });
  };
  route('POST', '/api/items', capture);
  route('POST', '/api/inbox', capture);
  route('PATCH', '/api/items/:id', ({ params, body }) => store.updateItem(params.id, body));
  route('POST', '/api/items/:id/process', ({ params, body }) => store.processItem(params.id, body));
  route('DELETE', '/api/items/:id', ({ params }) => store.deleteItem(params.id));

  route('GET', '/api/projects', ({ query }) => store.listProjects(query));
  route('POST', '/api/projects', ({ body, query }) => R({ status: 201, body: store.createProject(body, { force: query.force === '1' }) }));
  route('GET', '/api/projects/:id', ({ params }) => store.findProject(decodeURIComponent(params.id)));
  route('PATCH', '/api/projects/:id', ({ params, body, query }) => store.updateProject(decodeURIComponent(params.id), body, { force: query.force === '1' || body?.force === true }));
  route('DELETE', '/api/projects/:id', ({ params }) => store.deleteProject(decodeURIComponent(params.id)));

  route('GET', '/api/today', ({ query }) => store.dayView(query.date));
  route('GET', '/api/tasks', ({ query }) => store.listTasks(query));
  route('POST', '/api/tasks', ({ body }) => R({ status: 201, body: store.addTask(body) }));
  route('PATCH', '/api/tasks/:id', ({ params, body }) => store.updateTask(params.id, body));
  route('DELETE', '/api/tasks/:id', ({ params }) => store.deleteTask(params.id));

  route('GET', '/api/reviews', () => store.reviews());
  route('POST', '/api/reviews/:cadence', ({ params, body }) => store.markReview(decodeURIComponent(params.cadence), body?.notes));

  route('GET', '/api/state/:key', ({ params }) => store.getState(params.key));
  route('PUT', '/api/state/:key', ({ params, body }) => {
    if (!STATE_KEYS.includes(params.key)) throw new GtdError(400, `Chave não permitida: ${params.key} (${STATE_KEYS.join(', ')})`);
    if (params.key === 'webhooks' && !Array.isArray(body)) throw new GtdError(400, 'webhooks deve ser uma lista [{url, events?, secret?, enabled?}]');
    return store.setState(params.key, body);
  });

  // Ligação estruturada com sistemas externos (contrato gtd-link/1 — docs/contrato-ligacao.md)
  route('POST', '/api/link/sync', ({ body }) => link.sync(body || {}));
  route('GET', '/api/link/status', () => link.status());
  route('GET', '/api/link/outbox', ({ query }) => link.pending(query.sistema || 'diario'));
  route('GET', '/api/link/log', ({ query }) => link.log(query));
  route('GET', '/api/links', ({ query }) => link.listLinks(query));
  route('POST', '/api/links', ({ body }) => R({ status: 201, body: link.createLink(body || {}) }));
  route('DELETE', '/api/links/:id', ({ params }) => link.deleteLink(params.id));

  route('GET', '/api/events', ({ query }) => store.events(query));
  route('POST', '/api/ingest/:kind', ({ params, body, raw, headers, query }) => ingest(store, params.kind, { body, raw, headers, query }));
  route('GET', '/api/export', () => R({ body: store.exportAll(), headers: { 'Content-Disposition': `attachment; filename="gtd-backup-${today()}.json"` } }));
  route('POST', '/api/import', ({ body, query }) => store.importAll(body, { mode: query.mode === 'replace' ? 'replace' : 'merge' }));

  // Bookmarklet / atalhos (iOS Shortcuts, Android): GET simples que captura e mostra confirmação.
  route('GET', '/capture', ({ query }) => {
    const text = query.text || query.title;
    const { item, duplicate } = store.capture({ text, url: query.url, notes: query.notes, source: query.source || 'Web', hub: query.hub });
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    return R({ raw: `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>GTD</title>
<body style="font:15px system-ui;padding:24px;background:#FAFAF7;color:#1a1a1a"><b>${duplicate ? '= Já estava na inbox' : '✓ Capturado na inbox'}</b><p>${esc(item.text)}</p>
<script>setTimeout(()=>window.close(),1500)</script>`, type: 'text/html; charset=utf-8' });
  });

  // MCP Streamable HTTP (sem sessão). Aceita lote JSON-RPC.
  route('POST', '/mcp', ({ body }) => {
    const msgs = Array.isArray(body) ? body : [body];
    const out = msgs.map(m => mcp.handle(m)).filter(Boolean);
    if (!out.length) return R({ status: 202, raw: '' });
    return Array.isArray(body) ? out : out[0];
  });
  route('GET', '/mcp', () => R({ status: 405, body: { error: 'Use POST (MCP Streamable HTTP, sem sessão)' } }));
  route('DELETE', '/mcp', () => R({ status: 405, body: { error: 'Sem sessões' } }));

  // ---- utilitários HTTP ----
  const tokenOk = (req, url) => {
    const h = req.headers.authorization || '';
    const t = h.startsWith('Bearer ') ? h.slice(7).trim() : req.headers['x-gtd-token'] || url.searchParams.get('token') || '';
    const a = Buffer.from(String(t)), b = Buffer.from(TOKEN);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  /** Token (integrações) ou sessão da interface. Com sessão, um pedido que altera dados precisa vir do próprio site. */
  const authOk = (req, url) => {
    if (tokenOk(req, url)) return true;
    if (!auth.session(req)) return false;
    if (['GET', 'HEAD'].includes(req.method)) return true;
    const origin = req.headers.origin;
    if (!origin) return true;
    try { return new URL(origin).host === (req.headers['x-forwarded-host'] || req.headers.host); } catch { return false; }
  };
  const cors = (req, res) => {
    const allowed = (process.env.GTD_CORS || '*').split(',').map(s => s.trim());
    const origin = req.headers.origin;
    res.setHeader('Access-Control-Allow-Origin', allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : allowed[0]);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-GTD-Token,Mcp-Protocol-Version,Mcp-Session-Id,X-GitHub-Event,X-GitHub-Delivery,X-Hub-Signature-256');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Vary', 'Origin');
  };
  const send = (res, status, payload, headers = {}) => {
    const isRaw = typeof payload === 'string' || Buffer.isBuffer(payload);
    res.writeHead(status, { 'Content-Type': isRaw ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
    res.end(isRaw ? payload : JSON.stringify(payload));
  };
  const readBody = req => new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > 10 * 1024 * 1024) { reject(new GtdError(413, 'Corpo maior que 10 MB')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
  const parseBody = (raw, type = '') => {
    if (!raw) return undefined;
    if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
    if (type.includes('json') || /^\s*[[{]/.test(raw)) {
      try { return JSON.parse(raw); } catch { throw new GtdError(400, 'JSON inválido'); }
    }
    return raw;
  };
  const serveStatic = (req, res, pathname) => {
    let file = path.normalize(path.join(PUBLIC, decodeURIComponent(pathname)));
    if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'Proibido' });
    if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    createReadStream(file).pipe(res);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    cors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    try {
      if (url.pathname === '/api/stream') {
        if (!authOk(req, url)) return send(res, 401, { error: 'Entre no GTD ou use o token' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(`event: hello\ndata: {"today":"${today()}"}\n\n`);
        sse.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => { clearInterval(ping); sse.delete(res); });
        return;
      }
      const r = routes.find(x => x.method === req.method && x.re.test(url.pathname));
      if (!r) {
        if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
        return send(res, 404, { error: `Rota não encontrada: ${req.method} ${url.pathname}` });
      }
      if (r.auth && !authOk(req, url)) return send(res, 401, { error: 'Não autenticado: entre no GTD (interface) ou envie Authorization: Bearer <token> (integrações)' });
      const raw = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : '';
      const proto = req.headers['x-forwarded-proto'] || 'http';
      const out = await r.handler({
        req, params: r.re.exec(url.pathname).groups || {}, query: Object.fromEntries(url.searchParams), headers: req.headers,
        body: parseBody(raw, req.headers['content-type']), raw, base: `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`,
      });
      if (out && out[REPLY]) {
        if (out.raw !== undefined) return send(res, out.status || 200, out.raw, out.type ? { 'Content-Type': out.type } : {});
        return send(res, out.status || 200, out.body ?? {}, out.headers || {});
      }
      send(res, 200, out ?? {});
    } catch (e) {
      if (e instanceof GtdError) return send(res, e.status, { error: e.message });
      console.error(e);
      send(res, 500, { error: 'Erro interno: ' + e.message });
    }
  });

  return { server, store, link, auth, token: TOKEN, mcp };
}

// Execução direta: node server/index.mjs
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const port = +process.env.PORT || 4317;
  const host = process.env.HOST || '127.0.0.1';
  const { server, auth } = createApp();
  server.on('error', e => {
    if (e.code === 'EADDRINUSE') { console.error(`Porta ${port} já em uso — o GTD provavelmente já está rodando.`); process.exit(0); }
    throw e;
  });
  server.listen(port, host, () => {
    const shown = host === '0.0.0.0' ? '127.0.0.1' : host;
    console.log(`\n  ⚙  GTD Framework v${VERSION}`);
    console.log(`  UI:   http://${shown}:${port}/   (${auth.passwordSet() ? 'entre com e-mail e senha' : 'abra neste computador para criar a senha'})`);
    console.log(`  API:  http://${shown}:${port}/api   (Authorization: Bearer <token de data/config.json>)`);
    console.log(`  MCP:  http://${shown}:${port}/mcp\n`);
  });
}
