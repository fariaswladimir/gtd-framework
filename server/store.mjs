// Camada de dados do GTD: SQLite embutido (node:sqlite), sem dependências externas.
// Toda mutação gera um evento (tabela events + EventEmitter) — é isso que alimenta
// a UI em tempo real (SSE), os webhooks de saída e o "o que mudou" do MCP.
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { buildSeed } from './seed.mjs';

export const LANES = {
  sustento: { name: 'Sustento', wip: 2 },
  paralelos: { name: 'Proj. Paralelos', wip: 3 },
  sandbox: { name: 'Sandbox', wip: 2 },
};
export const WIP_GLOBAL = 7;
export const DAILY_MAX = 7;
export const BUCKETS = ['inbox', 'waiting', 'someday', 'reference', 'trash', 'processed'];
export const STATUSES = ['backlog', 'ativo', 'pausado', 'concluido', 'abandonado'];
export const MODES = ['projeto', 'kanban', 'todo'];
export const PERIODS = [
  { period: 'manhã', emoji: '🌅', label: 'Foco profundo · 5h–8h' },
  { period: 'tarde', emoji: '☀️', label: 'Execução · 8h–17h' },
  { period: 'noite', emoji: '🌙', label: 'Criativo + Fechamento · 20h–22h' },
];
export const HUBS = {
  'edge': 'Trabalho principal',
  'doutorado': 'XAI/MAS/SDD',
  'side-projects': 'MANGUE, curta',
  'consultoria-dados': 'Pipeline IA',
  'consultoria-n8n': 'Automação',
  'pessoal': 'GTD, saúde, vida',
};
export const SOURCES = ['Captura manual', 'Diário', 'Gmail', 'Google Keep', 'Google Drive', 'GitHub', 'Claude', 'Claude Edge',
  'WhatsApp self', 'Lovable', 'Web', 'n8n', 'Captura rápida'];
export const REVIEW_MAX_DAYS = { 'Diária': 1, 'Semanal': 7, 'Mensal': 31, 'Trimestral': 92 };
// Chaves livres (documentos JSON) que a UI e as integrações podem ler/gravar.
export const STATE_KEYS = ['areas', 'tensions', 'health', 'meds', 'meds_list', 'links', 'reviews', 'cadences', 'webhooks', 'hub_map'];

const TZ = process.env.GTD_TZ || 'America/Sao_Paulo';

export class GtdError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const nowIso = () => new Date().toISOString();
export function today(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
export function addDays(date, n) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function daysBetween(a, b) {
  return Math.round((Date.parse(b.slice(0, 10) + 'T12:00:00Z') - Date.parse(a.slice(0, 10) + 'T12:00:00Z')) / 86400000);
}
const J = v => (v === undefined || v === null ? null : JSON.stringify(v));
const P = (s, d = null) => { if (s == null) return d; try { return JSON.parse(s); } catch { return d; } };
const newId = p => `${p}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
const clean = v => (v === undefined ? null : v);
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, text TEXT NOT NULL, notes TEXT, source TEXT NOT NULL, source_ref TEXT,
  url TEXT, hub TEXT, bucket TEXT NOT NULL DEFAULT 'inbox', destination TEXT,
  created_at TEXT NOT NULL, processed_at TEXT, meta TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS items_source_ref ON items(source, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS items_bucket ON items(bucket);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, lane TEXT NOT NULL, mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'backlog', priority INTEGER, progress INTEGER, next_step TEXT,
  github TEXT, lovable_url TEXT, hub TEXT, notes TEXT, post_mortem TEXT,
  steps TEXT, current_step INTEGER NOT NULL DEFAULT 0, kanban TEXT, todos TEXT,
  status_changed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, text TEXT NOT NULL, period TEXT NOT NULL, lane TEXT, project_id TEXT,
  date TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, done_at TEXT, carry INTEGER NOT NULL DEFAULT 0,
  item_id TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS tasks_date ON tasks(date);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, type TEXT NOT NULL,
  entity_id TEXT, summary TEXT, data TEXT);
`;

const PROJECT_FIELDS = ['name', 'lane', 'mode', 'status', 'priority', 'progress', 'next_step', 'github', 'lovable_url',
  'hub', 'notes', 'post_mortem', 'steps', 'current_step', 'kanban', 'todos', 'sort'];
const JSON_FIELDS = new Set(['steps', 'kanban', 'todos', 'meta']);

export class Store extends EventEmitter {
  constructor(file, { seed = true } = {}) {
    super();
    this.setMaxListeners(100);
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    this.txDepth = 0;
    this.alertProviders = [];
    this.link = null; // serviço de ligação (server/link.mjs), quando anexado
    if (seed && !this.getState('seeded')) this.seed();
  }

  // ---------- infraestrutura ----------
  tx(fn) {
    if (this.txDepth++ > 0) { try { return fn(); } finally { this.txDepth--; } }
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
    finally { this.txDepth--; }
  }
  insert(table, obj) {
    const keys = Object.keys(obj);
    const vals = keys.map(k => (JSON_FIELDS.has(k) && typeof obj[k] !== 'string' ? J(obj[k]) : clean(obj[k])));
    this.db.prepare(`INSERT OR REPLACE INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...vals);
  }
  patch(table, id, obj) {
    const keys = Object.keys(obj);
    if (!keys.length) return;
    const vals = keys.map(k => (JSON_FIELDS.has(k) ? J(obj[k]) : clean(obj[k])));
    this.db.prepare(`UPDATE ${table} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...vals, id);
  }
  log(type, entityId, summary, data) {
    const ev = { ts: nowIso(), type, entity_id: entityId ?? null, summary: summary ?? null, data: J(data) };
    const r = this.db.prepare('INSERT INTO events (ts, type, entity_id, summary, data) VALUES (?, ?, ?, ?, ?)')
      .run(ev.ts, ev.type, ev.entity_id, ev.summary, ev.data);
    const out = { id: Number(r.lastInsertRowid), ...ev, data: data ?? null };
    queueMicrotask(() => this.emit('event', out));
    return out;
  }
  events({ limit = 50, since, type } = {}) {
    const where = []; const args = [];
    if (since) { where.push('ts > ?'); args.push(since); }
    if (type) { where.push('type LIKE ?'); args.push(type + '%'); }
    return this.db.prepare(`SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`)
      .all(...args, Math.min(+limit || 50, 500)).map(e => ({ ...e, data: P(e.data) }));
  }

  // ---------- estado livre (kv) ----------
  getState(key, def = null) {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    return r ? P(r.value, def) : def;
  }
  setState(key, value, { silent = false } = {}) {
    this.db.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(key, JSON.stringify(value), nowIso());
    if (!silent) this.log('state.updated', key, `Estado "${key}" atualizado`);
    return value;
  }

  // ---------- inbox / itens ----------
  rowItem(r) { return r ? { ...r, meta: P(r.meta, {}) } : null; }
  getItem(id) {
    const r = this.db.prepare('SELECT * FROM items WHERE id = ?').get(id);
    if (!r) throw new GtdError(404, `Item ${id} não encontrado`);
    return this.rowItem(r);
  }
  listItems({ bucket = 'inbox', hub, source, q, limit = 200 } = {}) {
    const where = []; const args = [];
    if (bucket && bucket !== 'all') { where.push('bucket = ?'); args.push(bucket); }
    if (hub) { where.push('hub = ?'); args.push(hub); }
    if (source) { where.push('source = ?'); args.push(source); }
    if (q) { where.push('(text LIKE ? OR notes LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
    return this.db.prepare(`SELECT * FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY COALESCE(processed_at, created_at) DESC LIMIT ?`).all(...args, Math.min(+limit || 200, 2000)).map(r => this.rowItem(r));
  }
  counts() {
    const out = Object.fromEntries(BUCKETS.map(b => [b, 0]));
    for (const r of this.db.prepare('SELECT bucket, COUNT(*) n FROM items GROUP BY bucket').all()) out[r.bucket] = r.n;
    const t = today();
    out.processed_today = this.db.prepare(`SELECT processed_at FROM items WHERE bucket != 'inbox' AND processed_at >= ?`)
      .all(addDays(t, -1)).filter(r => today(new Date(r.processed_at)) === t).length;
    return out;
  }
  capture(input = {}) {
    const text = String(input.text ?? '').trim();
    if (!text) throw new GtdError(400, 'Campo "text" é obrigatório');
    const source = String(input.source || 'Captura manual').slice(0, 60);
    const ref = input.source_ref != null && input.source_ref !== '' ? String(input.source_ref).slice(0, 300) : null;
    if (ref) {
      const ex = this.db.prepare('SELECT * FROM items WHERE source = ? AND source_ref = ?').get(source, ref);
      if (ex) return { item: this.rowItem(ex), duplicate: true };
    }
    const hub = input.hub && HUBS[input.hub] ? input.hub : null;
    const item = {
      id: newId('i'), text: text.slice(0, 2000), notes: input.notes ? String(input.notes).slice(0, 20000) : null,
      source, source_ref: ref, url: input.url ? String(input.url).slice(0, 2000) : null, hub,
      bucket: 'inbox', destination: null, created_at: input.created_at || nowIso(), processed_at: null, meta: input.meta || {},
    };
    this.insert('items', item);
    this.log('item.captured', item.id, `${source}: ${item.text.slice(0, 100)}`, { source, hub });
    return { item: this.rowItem({ ...item, meta: J(item.meta) }), duplicate: false };
  }
  captureMany(list) {
    return this.tx(() => list.map(x => this.capture(x)));
  }
  updateItem(id, p = {}) {
    const item = this.getItem(id);
    const up = {};
    if (p.text !== undefined) up.text = String(p.text).trim().slice(0, 2000) || item.text;
    if (p.notes !== undefined) up.notes = p.notes ? String(p.notes) : null;
    if (p.hub !== undefined) up.hub = p.hub && HUBS[p.hub] ? p.hub : null;
    if (p.url !== undefined) up.url = p.url || null;
    this.patch('items', id, up);
    this.log('item.updated', id, `Item editado: ${(up.text || item.text).slice(0, 80)}`);
    return this.getItem(id);
  }
  processItem(id, opts = {}) {
    return this.tx(() => {
      const item = this.getItem(id);
      const action = String(opts.action || '');
      let bucket, destination = null, task = null, project = null;
      switch (action) {
        case 'projeto': {
          project = this.findProject(opts.project ?? opts.project_id);
          this.addToProject(project.id, opts.text || item.text, opts.column, { silent: true });
          project = this.getProject(project.id);
          destination = `Projeto: ${project.name}`; bucket = 'processed'; break;
        }
        case 'tarefa': {
          const proj = opts.project || opts.project_id ? this.findProject(opts.project ?? opts.project_id) : null;
          task = this.addTask({ text: opts.text || item.text, period: opts.period, date: opts.date,
            lane: opts.lane || proj?.lane, project_id: proj?.id, item_id: item.id }, { silent: true });
          destination = `Tarefa: ${task.period} · ${task.date}`; bucket = 'processed'; break;
        }
        case 'feito': destination = 'Feito na hora (regra dos 2 min)'; bucket = 'processed'; break;
        case 'diario': destination = 'Enviado ao Diário do Doutorado'; bucket = 'processed'; break;
        case 'waiting': destination = opts.who ? `Aguardando: ${String(opts.who).slice(0, 80)}` : 'Aguardando terceiros'; bucket = 'waiting'; break;
        case 'someday': case 'reference': case 'trash': bucket = action; break;
        case 'inbox': bucket = 'inbox'; break;
        default: throw new GtdError(400, `Ação inválida "${action}". Use: projeto | tarefa | feito | waiting | diario | someday | reference | trash | inbox`);
      }
      this.patch('items', id, { bucket, destination, processed_at: bucket === 'inbox' ? null : nowIso() });
      if (action === 'feito') this.emit('item.done', this.getItem(id), opts);
      if (action === 'diario') this.emit('item.to_diario', this.getItem(id), opts);
      const labels = { someday: 'Algum Dia', reference: 'Referência', trash: 'Lixo', inbox: 'Inbox', waiting: 'Aguardando' };
      this.log('item.processed', id, `${item.text.slice(0, 80)} → ${destination || labels[bucket]}`, { action, bucket, task_id: task?.id, project_id: project?.id });
      return { item: this.getItem(id), task, project };
    });
  }
  deleteItem(id) {
    const item = this.getItem(id);
    if (item.bucket !== 'trash') throw new GtdError(409, 'Só é possível apagar itens que estão no Lixo');
    this.db.prepare('DELETE FROM items WHERE id = ?').run(id);
    this.log('item.deleted', id, `Apagado: ${item.text.slice(0, 80)}`);
    return { deleted: id };
  }

  // ---------- projetos ----------
  rowProject(r) {
    if (!r) return null;
    const p = { ...r, steps: P(r.steps, null), kanban: P(r.kanban, null), todos: P(r.todos, null) };
    if (p.status === 'pausado' && p.status_changed_at) p.paused_days = daysBetween(p.status_changed_at, today());
    return p;
  }
  getProject(id) {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    if (!r) throw new GtdError(404, `Projeto ${id} não encontrado`);
    return this.rowProject(r);
  }
  /** Aceita id exato ou parte do nome (útil para o Claude: "doutorado", "MANGUE"). */
  findProject(ref) {
    if (ref == null || ref === '') throw new GtdError(400, 'Informe o projeto (id ou nome)');
    const byId = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(String(ref));
    if (byId) return this.rowProject(byId);
    const q = String(ref).toLowerCase();
    const all = this.listProjects();
    const exact = all.filter(p => p.name.toLowerCase() === q);
    if (exact.length === 1) return exact[0];
    const hits = all.filter(p => p.name.toLowerCase().includes(q));
    if (hits.length === 1) return hits[0];
    if (!hits.length) throw new GtdError(404, `Nenhum projeto corresponde a "${ref}"`);
    throw new GtdError(409, `"${ref}" é ambíguo: ${hits.map(p => `${p.name} (${p.id})`).join('; ')}`);
  }
  listProjects({ status, lane, hub } = {}) {
    const where = []; const args = [];
    if (status) { where.push('status = ?'); args.push(status); }
    if (lane) { where.push('lane = ?'); args.push(lane); }
    if (hub) { where.push('hub = ?'); args.push(hub); }
    return this.db.prepare(`SELECT * FROM projects ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY CASE status WHEN 'ativo' THEN 0 WHEN 'pausado' THEN 1 WHEN 'backlog' THEN 2 ELSE 3 END,
      COALESCE(priority, 99), sort`).all(...args).map(r => this.rowProject(r));
  }
  wipCheck(lane, excludeId) {
    const laneActive = this.db.prepare(`SELECT COUNT(*) n FROM projects WHERE status = 'ativo' AND lane = ? AND id != ?`).get(lane, excludeId || '').n;
    const global = this.db.prepare(`SELECT COUNT(*) n FROM projects WHERE status = 'ativo' AND id != ?`).get(excludeId || '').n;
    if (laneActive >= LANES[lane].wip) throw new GtdError(409, `WIP cheio na lane ${LANES[lane].name} (${laneActive}/${LANES[lane].wip}). Pause ou conclua um projeto antes, ou use force.`);
    if (global >= WIP_GLOBAL) throw new GtdError(409, `WIP global cheio (${global}/${WIP_GLOBAL}). Use force para ignorar.`);
  }
  validateProject(p) {
    if (p.lane !== undefined && !LANES[p.lane]) throw new GtdError(400, `lane inválida: ${p.lane} (${Object.keys(LANES).join(', ')})`);
    if (p.mode !== undefined && !MODES.includes(p.mode)) throw new GtdError(400, `mode inválido: ${p.mode} (${MODES.join(', ')})`);
    if (p.status !== undefined && !STATUSES.includes(p.status)) throw new GtdError(400, `status inválido: ${p.status} (${STATUSES.join(', ')})`);
    if (p.hub !== undefined && p.hub !== null && p.hub !== '' && !HUBS[p.hub]) throw new GtdError(400, `hub inválido: ${p.hub} (${Object.keys(HUBS).join(', ')})`);
    if (p.priority !== undefined && p.priority !== null && ![1, 2, 3].includes(+p.priority)) throw new GtdError(400, 'priority deve ser 1, 2 ou 3');
  }
  createProject(input = {}, { force = false } = {}) {
    const name = String(input.name || '').trim();
    if (!name) throw new GtdError(400, 'Campo "name" é obrigatório');
    const p = { lane: input.lane || 'sandbox', mode: input.mode || 'projeto', status: input.status || 'backlog', ...input };
    this.validateProject(p);
    return this.tx(() => {
      if (p.status === 'ativo' && !force) this.wipCheck(p.lane);
      const ts = nowIso();
      const steps = p.mode === 'projeto' ? (Array.isArray(p.steps) ? p.steps.map(String) : []) : null;
      const row = {
        id: newId('p'), name, lane: p.lane, mode: p.mode, status: p.status, priority: p.priority ? +p.priority : null,
        progress: p.progress ?? (p.mode === 'projeto' ? 0 : null), next_step: p.next_step || null,
        github: p.github || null, lovable_url: p.lovable_url || null, hub: p.hub || null, notes: p.notes || null, post_mortem: null,
        steps, current_step: +p.current_step || 0,
        kanban: p.mode === 'kanban' ? { todo: [], doing: [], done: [], ...(p.kanban || {}) } : null,
        todos: p.mode === 'todo' ? (p.todos || []).map(t => (typeof t === 'string' ? { text: t, done: false } : t)) : null,
        status_changed_at: ts, created_at: ts, updated_at: ts,
        sort: p.sort ?? (this.db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 n FROM projects').get().n),
      };
      this.insert('projects', row);
      this.log('project.created', row.id, `Projeto criado: ${name} (${row.lane}, ${row.status})`);
      return this.getProject(row.id);
    });
  }
  updateProject(ref, input = {}, { force = false } = {}) {
    return this.tx(() => {
      const cur = this.findProject(ref);
      const up = {};
      for (const k of PROJECT_FIELDS) if (input[k] !== undefined) up[k] = input[k];
      this.validateProject(up);
      if (up.priority !== undefined) up.priority = up.priority === null ? null : +up.priority;
      if (up.hub === '') up.hub = null;
      if (up.progress !== undefined && up.progress !== null) up.progress = Math.max(0, Math.min(100, Math.round(+up.progress)));
      const changes = [];
      if (up.status && up.status !== cur.status) {
        if (up.status === 'ativo' && !force) this.wipCheck(up.lane || cur.lane, cur.id);
        up.status_changed_at = nowIso();
        changes.push(`${cur.status} → ${up.status}`);
        if (up.status === 'concluido' && cur.mode === 'projeto') up.progress = 100;
      } else if (up.lane && up.lane !== cur.lane && cur.status === 'ativo' && !force) {
        this.wipCheck(up.lane, cur.id);
      }
      // operações de conteúdo
      if (input.add_item) this.addToProject(cur.id, input.add_item, input.column, { silent: true });
      const fresh = input.add_item ? this.getProject(cur.id) : cur;
      if (input.advance_step && fresh.mode === 'projeto' && fresh.steps?.length) {
        const n = Math.min(fresh.steps.length, (up.current_step ?? fresh.current_step) + 1);
        up.current_step = n;
        up.progress = Math.round((n / fresh.steps.length) * 100);
        changes.push(`etapa ${n}/${fresh.steps.length}`);
        if (!input.next_step && fresh.steps[n]) up.next_step = fresh.steps[n];
      }
      if (input.kanban_move && fresh.mode === 'kanban') {
        up.kanban = moveKanban(fresh.kanban, input.kanban_move);
        changes.push(`kanban: "${input.kanban_move.card}" → ${input.kanban_move.to}`);
      }
      if (input.todo_toggle !== undefined && fresh.mode === 'todo') {
        const todos = [...(fresh.todos || [])];
        const i = resolveIndex(todos.map(t => t.text), input.todo_toggle);
        todos[i] = { ...todos[i], done: !todos[i].done };
        up.todos = todos;
        changes.push(`to-do "${todos[i].text}" ${todos[i].done ? 'feito' : 'reaberto'}`);
      }
      if (input.remove_item !== undefined) {
        up[fresh.mode === 'projeto' ? 'steps' : fresh.mode === 'todo' ? 'todos' : 'kanban'] = removeFromProject(fresh, input.remove_item, input.column);
      }
      up.updated_at = nowIso();
      this.patch('projects', cur.id, up);
      const keys = Object.keys(input).filter(k => !['updated_at'].includes(k));
      if (input.add_item) changes.push(`+ "${String(input.add_item).slice(0, 60)}"`);
      this.log('project.updated', cur.id, `${cur.name}: ${changes.join(', ') || keys.join(', ')}`, { fields: keys });
      return this.getProject(cur.id);
    });
  }
  addToProject(ref, text, column, { silent = false } = {}) {
    const p = this.findProject(ref);
    text = String(text || '').trim();
    if (!text) throw new GtdError(400, 'Texto vazio');
    const up = { updated_at: nowIso() };
    if (p.mode === 'kanban') {
      const k = { todo: [], doing: [], done: [], ...(p.kanban || {}) };
      const col = ['todo', 'doing', 'done'].includes(column) ? column : 'todo';
      k[col] = [...k[col], text]; up.kanban = k;
    } else if (p.mode === 'todo') {
      up.todos = [...(p.todos || []), { text, done: false }];
    } else {
      up.steps = [...(p.steps || []), text];
      if (p.progress != null && up.steps.length) up.progress = Math.round((p.current_step / up.steps.length) * 100);
    }
    this.patch('projects', p.id, up);
    if (!silent) this.log('project.updated', p.id, `${p.name}: + "${text.slice(0, 60)}"`);
    return this.getProject(p.id);
  }
  deleteProject(ref) {
    const p = this.findProject(ref);
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
    this.log('project.deleted', p.id, `Projeto removido: ${p.name}`);
    return { deleted: p.id };
  }

  // ---------- tarefas do dia ----------
  rowTask(r) { return r ? { ...r, done: !!r.done } : null; }
  getTask(id) {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!r) throw new GtdError(404, `Tarefa ${id} não encontrada`);
    return this.rowTask(r);
  }
  /** Tarefas não concluídas de dias anteriores viram carry-over de hoje (regra dos 3 dias). */
  rollover() {
    const t = today();
    const rows = this.db.prepare('SELECT id, date FROM tasks WHERE done = 0 AND date < ?').all(t);
    if (!rows.length) return 0;
    this.tx(() => {
      const st = this.db.prepare('UPDATE tasks SET date = ?, carry = carry + ? WHERE id = ?');
      for (const r of rows) st.run(t, Math.max(1, daysBetween(r.date, t)), r.id);
    });
    this.log('task.rollover', null, `${rows.length} tarefa(s) pendente(s) carregada(s) para ${t}`);
    return rows.length;
  }
  listTasks({ date, from, to, project } = {}) {
    this.rollover();
    const where = []; const args = [];
    if (from || to) { where.push('date >= ? AND date <= ?'); args.push(from || '0000-00-00', to || '9999-99-99'); }
    else { where.push('date = ?'); args.push(date || today()); }
    if (project) { where.push('project_id = ?'); args.push(this.findProject(project).id); }
    return this.db.prepare(`SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY date, done, created_at`).all(...args).map(r => this.rowTask(r));
  }
  dayView(date = today()) {
    const tasks = this.listTasks({ date });
    const projects = Object.fromEntries(this.listProjects().map(p => [p.id, p]));
    const enrich = t => ({ ...t, project_name: t.project_id ? projects[t.project_id]?.name || null : null });
    return {
      date, total: tasks.length, done: tasks.filter(t => t.done).length,
      periods: PERIODS.map(p => ({ ...p, tasks: tasks.filter(t => t.period === p.period).map(enrich) })),
    };
  }
  addTask(input = {}, { silent = false } = {}) {
    const text = String(input.text || '').trim();
    if (!text) throw new GtdError(400, 'Campo "text" é obrigatório');
    const period = PERIODS.some(p => p.period === input.period) ? input.period : normalizePeriod(input.period);
    let date = input.date === 'amanha' || input.date === 'amanhã' ? addDays(today(), 1) : input.date;
    if (!date || date === 'hoje') date = today();
    if (!isDate(date)) throw new GtdError(400, 'date deve ser YYYY-MM-DD, "hoje" ou "amanhã"');
    let projectId = input.project_id || null, lane = input.lane || null;
    if (input.project && !projectId) { const p = this.findProject(input.project); projectId = p.id; lane = lane || p.lane; }
    if (lane && !LANES[lane]) throw new GtdError(400, `lane inválida: ${lane}`);
    const row = { id: newId('t'), text: text.slice(0, 500), period, lane, project_id: projectId, date, done: 0, done_at: null,
      carry: +input.carry || 0, item_id: input.item_id || null, created_at: nowIso() };
    this.insert('tasks', row);
    if (!silent) this.log('task.created', row.id, `Tarefa (${period}, ${date}): ${row.text.slice(0, 80)}`);
    return this.getTask(row.id);
  }
  updateTask(id, input = {}) {
    const cur = this.getTask(id);
    const up = {};
    if (input.text !== undefined) up.text = String(input.text).trim() || cur.text;
    if (input.period !== undefined) up.period = normalizePeriod(input.period);
    if (input.lane !== undefined) up.lane = input.lane && LANES[input.lane] ? input.lane : null;
    if (input.date !== undefined) {
      let d = input.date === 'amanha' || input.date === 'amanhã' ? addDays(today(), 1) : input.date === 'hoje' ? today() : input.date;
      if (!isDate(d)) throw new GtdError(400, 'date deve ser YYYY-MM-DD');
      up.date = d;
    }
    if (input.done !== undefined) { up.done = input.done ? 1 : 0; up.done_at = input.done ? nowIso() : null; }
    this.patch('tasks', id, up);
    if (input.done && !cur.done) this.emit('task.done', this.getTask(id), { origin: input._origin });
    const what = input.done !== undefined ? (input.done ? '✓ concluída' : 'reaberta') : Object.keys(up).join(', ');
    this.log('task.updated', id, `${cur.text.slice(0, 80)} — ${what}`);
    return this.getTask(id);
  }
  deleteTask(id) {
    const t = this.getTask(id);
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    this.log('task.deleted', id, `Tarefa removida: ${t.text.slice(0, 80)}`);
    return { deleted: id };
  }

  // ---------- revisões ----------
  reviews() {
    const done = this.getState('reviews', {});
    return (this.getState('cadences', []) || []).map(c => {
      const last = done[c.freq] || null;
      const age = last ? daysBetween(last, today()) : null;
      return { ...c, last_done: last, days_since: age, overdue: age === null || age > (REVIEW_MAX_DAYS[c.freq] ?? 7) };
    });
  }
  markReview(cadence, notes) {
    const c = (this.getState('cadences', []) || []).find(x => x.freq.toLowerCase() === String(cadence).toLowerCase()
      || x.freq.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase() === String(cadence).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase());
    if (!c) throw new GtdError(404, `Cadência "${cadence}" não existe (Diária, Semanal, Mensal, Trimestral)`);
    const done = this.getState('reviews', {});
    done[c.freq] = nowIso();
    this.setState('reviews', done, { silent: true });
    this.log('review.done', c.freq, `Revisão ${c.freq} concluída${notes ? ': ' + String(notes).slice(0, 200) : ''}`, { notes: notes || null });
    return this.reviews().find(r => r.freq === c.freq);
  }

  // ---------- visão consolidada ----------
  alerts() {
    const out = [];
    const projects = this.listProjects();
    const active = projects.filter(p => p.status === 'ativo');
    for (const [key, l] of Object.entries(LANES)) {
      const n = active.filter(p => p.lane === key).length;
      if (n > l.wip) out.push({ level: 'danger', code: 'wip_lane', text: `WIP estourado em ${l.name}: ${n}/${l.wip}` });
    }
    if (active.length > WIP_GLOBAL) out.push({ level: 'danger', code: 'wip_global', text: `WIP global estourado: ${active.length}/${WIP_GLOBAL}` });
    for (const p of projects) {
      if (p.status === 'pausado' && p.paused_days > 60) out.push({ level: 'warning', code: 'paused_60', entity_id: p.id, text: `${p.name} pausado há ${p.paused_days} dias — revisar (retomar, backlog ou abandonar)` });
      if (p.status === 'abandonado' && !p.post_mortem) out.push({ level: 'warning', code: 'post_mortem', entity_id: p.id, text: `${p.name} abandonado sem post-mortem` });
      if (p.status === 'ativo' && !p.next_step) out.push({ level: 'info', code: 'no_next_step', entity_id: p.id, text: `${p.name} ativo sem próximo passo definido` });
    }
    const day = this.listTasks({ date: today() });
    for (const t of day.filter(t => !t.done && t.carry >= 3)) out.push({ level: 'danger', code: 'carry_3', entity_id: t.id, text: `"${t.text.slice(0, 60)}" — ${t.carry} dias de carry-over: quebrar, delegar ou descartar` });
    if (day.length > DAILY_MAX) out.push({ level: 'warning', code: 'daily_max', text: `${day.length} tarefas hoje (máx. ${DAILY_MAX})` });
    const inbox = this.db.prepare(`SELECT COUNT(*) n, MIN(created_at) oldest FROM items WHERE bucket = 'inbox'`).get();
    if (inbox.n > 0 && inbox.oldest && daysBetween(inbox.oldest, today()) > 7) out.push({ level: 'warning', code: 'inbox_stale', text: `Inbox com ${inbox.n} itens; o mais antigo tem ${daysBetween(inbox.oldest, today())} dias` });
    for (const fn of this.alertProviders) out.push(...fn());
    for (const r of this.reviews()) {
      if (r.overdue && r.freq !== 'Diária') out.push({ level: 'info', code: 'review_due', text: r.last_done ? `Revisão ${r.freq} atrasada (${r.days_since} dias)` : `Revisão ${r.freq} ainda não registrada` });
    }
    return out;
  }
  context({ hub } = {}) {
    const projects = this.listProjects(hub ? { hub } : {});
    const pIds = new Set(projects.map(p => p.id));
    const day = this.dayView();
    const filterTask = t => !hub || (t.project_id && pIds.has(t.project_id));
    const inbox = this.listItems({ bucket: 'inbox', hub, limit: 30 });
    const counts = this.counts();
    return {
      date: today(), hub: hub || null,
      alerts: this.alerts().filter(a => !hub || !a.entity_id || pIds.has(a.entity_id)),
      projects: {
        active: projects.filter(p => p.status === 'ativo'),
        paused: projects.filter(p => p.status === 'pausado'),
        backlog: projects.filter(p => p.status === 'backlog').map(p => ({ id: p.id, name: p.name, lane: p.lane, hub: p.hub, priority: p.priority })),
      },
      today: { ...day, periods: day.periods.map(p => ({ ...p, tasks: p.tasks.filter(filterTask) })) },
      inbox: { count: hub ? inbox.length : counts.inbox, items: inbox },
      reviews: this.reviews().map(({ items, ...r }) => r),
      recent: this.events({ limit: 15 }),
    };
  }
  contextMarkdown(opts = {}) {
    const c = this.context(opts);
    const weekday = new Date(c.date + 'T12:00:00Z').toLocaleDateString('pt-BR', { weekday: 'long', timeZone: 'UTC' });
    const L = [`# GTD — contexto de ${c.date} (${weekday})${c.hub ? ` · hub **${c.hub}**` : ''}`, ''];
    L.push('## Alertas');
    L.push(...(c.alerts.length ? c.alerts.map(a => `- ${a.level === 'danger' ? '🔴' : a.level === 'warning' ? '🟡' : 'ℹ️'} ${a.text}`) : ['- Nenhum alerta.']), '');
    L.push('## Projetos ativos');
    for (const [key, l] of Object.entries(LANES)) {
      const ps = c.projects.active.filter(p => p.lane === key);
      if (!ps.length && c.hub) continue;
      L.push(`### ${l.name} (${ps.length}/${l.wip})`);
      for (const p of ps) {
        const extra = p.mode === 'projeto' && p.steps?.length ? ` · etapa ${Math.min(p.current_step + 1, p.steps.length)}/${p.steps.length}` : '';
        L.push(`- **${p.name}** \`${p.id}\` [${p.mode}${p.priority ? ` · P${p.priority}` : ''}${p.hub ? ` · ${p.hub}` : ''}${p.progress != null ? ` · ${p.progress}%` : ''}${extra}]`);
        if (p.next_step) L.push(`  - ▸ Próximo passo: ${p.next_step}`);
        if (p.mode === 'kanban' && p.kanban) L.push(`  - Fazendo: ${p.kanban.doing.join('; ') || '—'} · A fazer: ${p.kanban.todo.length}`);
        for (const m of this.link?.mirrorFor(p.id) || []) L.push(`  - No Diário (${m.ref}): ${m.dados ? `${m.dados.titulo}${m.dados.progresso != null ? ` · ${m.dados.progresso}%` : ''}${m.dados.decisao ? ` · decisão ${m.dados.decisao}` : ''}${m.dados.pendencias ? ` · pendências: ${m.dados.pendencias}` : ''}` : 'aguardando primeira sincronização'}`);
      }
    }
    if (c.projects.paused.length) {
      L.push('', '## Pausados');
      for (const p of c.projects.paused) L.push(`- ${p.name} \`${p.id}\` (${p.paused_days ?? '?'} dias)`);
    }
    L.push('', `## Hoje — ${c.today.done}/${c.today.total} concluídas`);
    for (const per of c.today.periods) {
      if (!per.tasks.length) continue;
      L.push(`### ${per.emoji} ${per.period} · ${per.label}`);
      for (const t of per.tasks) L.push(`- [${t.done ? 'x' : ' '}] ${t.text} \`${t.id}\`${t.carry ? ` ↻${t.carry}d` : ''}${t.project_name ? ` · ${t.project_name}` : ''}`);
    }
    L.push('', `## Inbox (${c.inbox.count} para processar)`);
    for (const i of c.inbox.items.slice(0, 15)) L.push(`- \`${i.id}\` (${i.source}) ${i.text}`);
    if (c.inbox.count > 15) L.push(`- … e mais ${c.inbox.count - 15}`);
    L.push('', '## Revisões');
    for (const r of c.reviews) L.push(`- ${r.freq}: ${r.last_done ? `última há ${r.days_since} dia(s)` : 'nunca registrada'}${r.overdue ? ' ⚠' : ''}`);
    L.push('', '## Atividade recente');
    for (const e of c.recent.slice(0, 10)) L.push(`- ${e.ts.slice(0, 16).replace('T', ' ')} · ${e.summary || e.type}`);
    return L.join('\n');
  }

  // ---------- export / import ----------
  exportAll() {
    return {
      _meta: { app: 'GTD Server', version: 1, exported: nowIso() },
      items: this.db.prepare('SELECT * FROM items').all().map(r => this.rowItem(r)),
      projects: this.db.prepare('SELECT * FROM projects').all().map(r => this.rowProject(r)),
      tasks: this.db.prepare('SELECT * FROM tasks').all().map(r => this.rowTask(r)),
      kv: Object.fromEntries(this.db.prepare('SELECT key, value FROM kv').all().map(r => [r.key, P(r.value)])),
      link: this.link?.exportData(),
    };
  }
  importAll(data, { mode = 'merge' } = {}) {
    if (!data || typeof data !== 'object' || !data._meta) throw new GtdError(400, 'Arquivo sem _meta: não parece um backup do GTD');
    if (data._meta.app === 'GTD Framework') return this.importLegacy(data);
    if (data._meta.app !== 'GTD Server') throw new GtdError(400, `Backup de app desconhecido: ${data._meta.app}`);
    const safeId = v => typeof v === 'string' && /^[\w-]{1,40}$/.test(v);
    const res = this.tx(() => {
      if (mode === 'replace') for (const t of ['items', 'projects', 'tasks']) this.db.exec(`DELETE FROM ${t}`);
      let n = 0;
      for (const it of data.items || []) if (safeId(it.id)) { const { paused_days, ...row } = it; this.insert('items', pick(row, ITEM_COLS)); n++; }
      for (const p of data.projects || []) if (safeId(p.id)) { this.insert('projects', pick(p, PROJECT_COLS)); n++; }
      for (const t of data.tasks || []) if (safeId(t.id)) { this.insert('tasks', { ...pick(t, TASK_COLS), done: t.done ? 1 : 0 }); n++; }
      for (const [k, v] of Object.entries(data.kv || {})) { this.setState(k, v, { silent: true }); n++; }
      if (data.link && this.link) n += this.link.importData(data.link, { replace: mode === 'replace' });
      return n;
    });
    this.log('import.done', null, `Backup importado (${mode}): ${res} registros`);
    return { imported: res, mode };
  }
  /** Migra o backup JSON do artifact original (localStorage, chaves gtd-*). */
  importLegacy(data) {
    const res = this.tx(() => {
      let n = 0;
      const inbox = data['gtd-inbox'];
      if (inbox) {
        for (const b of ['inbox', 'someday', 'reference', 'trash']) {
          for (const it of inbox[b] || []) {
            const { item } = this.capture({ text: it.text, source: it.source || 'Captura manual' });
            if (b !== 'inbox') {
              const bucket = b === 'trash' && it.destination ? 'processed' : b;
              this.patch('items', item.id, { bucket, destination: it.destination || null, processed_at: it.date ? it.date + 'T12:00:00.000Z' : nowIso() });
            }
            n++;
          }
        }
      }
      const map = { 'gtd-areas': 'areas', 'gtd-health': 'health', 'gtd-meds': 'meds', 'gtd-links': 'links' };
      for (const [k, v] of Object.entries(map)) if (data[k] !== undefined) { this.setState(v, data[k], { silent: true }); n++; }
      const bySort = this.db.prepare('SELECT id, sort FROM projects ORDER BY sort').all();
      const apply = (arr, field) => Array.isArray(arr) && arr.forEach((v, i) => {
        const p = bySort.find(x => x.sort === i + 1);
        if (p && v != null) { this.patch('projects', p.id, { [field]: v }); n++; }
      });
      apply(data['gtd-statuses'], 'status');
      apply(data['gtd-priorities'], 'priority');
      return n;
    });
    this.log('import.done', null, `Backup do artifact original migrado: ${res} registros`);
    return { imported: res, mode: 'legacy' };
  }

  // ---------- semente ----------
  seed() {
    const s = buildSeed(today());
    this.tx(() => {
      s.projects.forEach((p, i) => this.createProject({ ...p, sort: i + 1 }, { force: true }));
      s.inbox.forEach(it => this.capture(it));
      s.tasks.forEach(t => this.addTask(t, { silent: true }));
      for (const [k, v] of Object.entries(s.state)) this.setState(k, v, { silent: true });
      this.setState('seeded', nowIso(), { silent: true });
    });
    this.db.exec('DELETE FROM events');
    this.log('system.seeded', null, 'Base inicial criada a partir do GTD Framework original');
  }
}

const ITEM_COLS = ['id', 'text', 'notes', 'source', 'source_ref', 'url', 'hub', 'bucket', 'destination', 'created_at', 'processed_at', 'meta'];
const PROJECT_COLS = ['id', ...PROJECT_FIELDS, 'status_changed_at', 'created_at', 'updated_at'];
const TASK_COLS = ['id', 'text', 'period', 'lane', 'project_id', 'date', 'done', 'done_at', 'carry', 'item_id', 'created_at'];
function pick(o, cols) { const r = {}; for (const c of cols) if (o[c] !== undefined) r[c] = JSON_FIELDS.has(c) && o[c] !== null && typeof o[c] !== 'string' ? JSON.stringify(o[c]) : o[c]; return r; }

function normalizePeriod(p) {
  const s = String(p || '').toLowerCase();
  if (s.startsWith('man') || s === '1') return 'manhã';
  if (s.startsWith('noi') || s === '3') return 'noite';
  return 'tarde';
}
function resolveIndex(list, ref) {
  if (Number.isInteger(+ref) && +ref >= 0 && +ref < list.length && String(ref).trim() !== '') return +ref;
  const q = String(ref).toLowerCase();
  const i = list.findIndex(t => t.toLowerCase().includes(q));
  if (i < 0) throw new GtdError(404, `Item "${ref}" não encontrado`);
  return i;
}
function moveKanban(k, { card, from, to }) {
  const cols = ['todo', 'doing', 'done'];
  if (!cols.includes(to)) throw new GtdError(400, `Coluna destino inválida: ${to} (todo, doing, done)`);
  const kb = { todo: [], doing: [], done: [], ...(k || {}) };
  for (const c of from ? [from] : cols) {
    try {
      const i = resolveIndex(kb[c], card);
      const [txt] = kb[c].splice(i, 1);
      kb[to].push(txt);
      return kb;
    } catch { /* tenta a próxima coluna */ }
  }
  throw new GtdError(404, `Cartão "${card}" não encontrado no kanban`);
}
function removeFromProject(p, ref, column) {
  if (p.mode === 'projeto') { const s = [...(p.steps || [])]; s.splice(resolveIndex(s, ref), 1); return s; }
  if (p.mode === 'todo') { const t = [...(p.todos || [])]; t.splice(resolveIndex(t.map(x => x.text), ref), 1); return t; }
  const kb = { todo: [], doing: [], done: [], ...(p.kanban || {}) };
  for (const c of column ? [column] : ['todo', 'doing', 'done']) {
    try { kb[c].splice(resolveIndex(kb[c], ref), 1); return kb; } catch { /* próxima */ }
  }
  throw new GtdError(404, `Cartão "${ref}" não encontrado`);
}
