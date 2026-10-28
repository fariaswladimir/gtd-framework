// Ponta do GTD no contrato gtd-link/1 (docs/contrato-ligacao.md).
// O GTD não lê o banco do sistema externo: só aplica as mensagens de que o outro é dono
// e devolve, em cada sincronização, as mensagens de que o GTD é dono (caixa de saída).
import { randomUUID } from 'node:crypto';
import { CONTRACT, TYPES, validate, refCovers } from './link-contract.mjs';
import { GtdError, nowIso } from './store.mjs';

export const SYSTEMS = { diario: { nome: 'Diário do Doutorado', hub: 'doutorado' } };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY, sistema TEXT NOT NULL, project_id TEXT NOT NULL, ref TEXT NOT NULL, titulo TEXT,
  created_at TEXT NOT NULL, UNIQUE (sistema, project_id, ref));
CREATE TABLE IF NOT EXISTS link_keys (
  sistema TEXT NOT NULL, chave TEXT NOT NULL, tipo TEXT NOT NULL, alterado_em TEXT NOT NULL,
  ligado_a TEXT, estado TEXT, dados TEXT, gtd_id TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (sistema, chave));
CREATE TABLE IF NOT EXISTS link_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sistema TEXT NOT NULL, tipo TEXT NOT NULL, chave TEXT NOT NULL,
  alterado_em TEXT NOT NULL, ligado_a TEXT, dados TEXT NOT NULL, created_at TEXT NOT NULL, confirmed_at TEXT);
CREATE TABLE IF NOT EXISTS link_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, sistema TEXT NOT NULL, direcao TEXT NOT NULL,
  tipo TEXT, chave TEXT, resultado TEXT NOT NULL, motivo TEXT);
`;
const P = (s, d = null) => { if (s == null) return d; try { return JSON.parse(s); } catch { return d; } };
const fmtBr = d => d ? d.split('-').reverse().join('/') : '';
const isMine = resp => !resp || /^(eu|me|mim|wlad(imir)?)$/i.test(String(resp).trim());

export class LinkService {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(SCHEMA);
    store.link = this;
    store.alertProviders.push(() => this.alerts());
    store.on('task.done', (task, opts) => { if (opts?.origin !== 'link' && task.item_id) this.onItemDone(task.item_id); });
    store.on('item.done', item => this.onItemDone(item.id));
    store.on('item.to_diario', (item, opts) => this.onToDiario(item, opts));
  }

  sys(s = 'diario') {
    if (!SYSTEMS[s]) throw new GtdError(400, `Sistema desconhecido: ${s} (${Object.keys(SYSTEMS).join(', ')})`);
    return s;
  }

  // ---------- ligações projeto ↔ referência externa ----------
  listLinks({ project } = {}) {
    const pid = project ? this.store.findProject(project).id : null;
    const rows = this.db.prepare(`SELECT * FROM links ${pid ? 'WHERE project_id = ?' : ''} ORDER BY created_at`).all(...(pid ? [pid] : []));
    const names = Object.fromEntries(this.store.listProjects().map(p => [p.id, p.name]));
    return rows.map(r => ({ ...r, project_name: names[r.project_id] || null, mirror: this.mirror(r.sistema, r.ref) }));
  }
  createLink({ project, ref, titulo, sistema = 'diario' } = {}) {
    sistema = this.sys(sistema);
    const p = this.store.findProject(project);
    ref = String(ref || '').trim();
    if (!TYPES['marco.status'].chave.test(ref)) throw new GtdError(400, `Referência inválida: "${ref}". Use dd:eap:<árvore>:<código com _> (ex.: dd:eap:bib:4_2) ou dd:gate:<id> (ex.: dd:gate:G3)`);
    const dup = this.db.prepare('SELECT id FROM links WHERE sistema = ? AND project_id = ? AND ref = ?').get(sistema, p.id, ref);
    if (dup) throw new GtdError(409, `${p.name} já está ligado a ${ref}`);
    const row = { id: 'l_' + randomUUID().replace(/-/g, '').slice(0, 8), sistema, project_id: p.id, ref, titulo: titulo || null, created_at: nowIso() };
    this.db.prepare('INSERT INTO links (id, sistema, project_id, ref, titulo, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.id, row.sistema, row.project_id, row.ref, row.titulo, row.created_at);
    this.store.log('link.created', p.id, `${p.name} ligado a ${ref} (${SYSTEMS[sistema].nome})`);
    return this.listLinks().find(l => l.id === row.id);
  }
  deleteLink(id) {
    const l = this.db.prepare('SELECT * FROM links WHERE id = ?').get(id);
    if (!l) throw new GtdError(404, `Ligação ${id} não encontrada`);
    this.db.prepare('DELETE FROM links WHERE id = ?').run(id);
    this.store.log('link.deleted', l.project_id, `Ligação desfeita: ${l.ref}`);
    return { deleted: id };
  }
  mirror(sistema, ref) {
    const k = this.db.prepare(`SELECT dados, alterado_em FROM link_keys WHERE sistema = ? AND chave = ? AND tipo = 'marco.status'`).get(sistema, ref);
    return k ? { dados: P(k.dados), alterado_em: k.alterado_em } : null;
  }
  mirrorFor(projectId) {
    return this.db.prepare('SELECT sistema, ref FROM links WHERE project_id = ?').all(projectId)
      .map(l => ({ ref: l.ref, ...(this.mirror(l.sistema, l.ref) || { dados: null }) }));
  }
  /** Projeto da ligação mais específica que cobre a referência. */
  projectFor(sistema, ligadoA) {
    if (!ligadoA) return null;
    const best = this.db.prepare('SELECT project_id, ref FROM links WHERE sistema = ?').all(sistema)
      .filter(l => refCovers(l.ref, ligadoA)).sort((a, b) => b.ref.length - a.ref.length)[0];
    if (!best) return null;
    try { return this.store.getProject(best.project_id); } catch { return null; }
  }

  // ---------- entrada: mensagens de que o outro sistema é dono ----------
  key(sistema, chave) {
    const r = this.db.prepare('SELECT * FROM link_keys WHERE sistema = ? AND chave = ?').get(sistema, chave);
    return r ? { ...r, dados: P(r.dados) } : null;
  }
  saveKey(sistema, msg, extra = {}) {
    this.db.prepare(`INSERT OR REPLACE INTO link_keys (sistema, chave, tipo, alterado_em, ligado_a, estado, dados, gtd_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sistema, msg.chave, msg.tipo, new Date(msg.alterado_em).toISOString(),
      msg.ligado_a || null, extra.estado ?? null, JSON.stringify(msg.dados || {}), extra.gtd_id ?? null, nowIso());
  }
  apply(sistema, msg) {
    const errs = validate(msg, { from: sistema });
    if (errs.length) return { resultado: 'recusado', motivo: errs.join('; ') };
    const at = new Date(msg.alterado_em).toISOString();
    const prev = this.key(sistema, msg.chave);
    if (prev && prev.alterado_em >= at) return { resultado: 'ignorado', motivo: 'mensagem repetida ou mais antiga que a última aplicada', gtd_id: prev.gtd_id || undefined };
    return this.store.tx(() => {
      switch (msg.tipo) {
        case 'acao.upsert': return this.applyAcao(sistema, msg, prev);
        case 'marco.status': {
          this.saveKey(sistema, msg, { estado: msg.dados.status || null });
          const n = this.db.prepare('SELECT COUNT(*) n FROM links WHERE sistema = ? AND ref = ?').get(sistema, msg.chave).n;
          this.store.log('link.mirror', msg.chave, `Diário: ${msg.dados.titulo}${msg.dados.progresso != null ? ` (${msg.dados.progresso}%)` : ''}`);
          return { resultado: prev ? 'atualizado' : 'criado', motivo: n ? undefined : 'nenhum projeto ligado a esta referência ainda; status guardado' };
        }
        case 'bloqueio.aberto': case 'bloqueio.fechado': {
          const aberto = msg.tipo === 'bloqueio.aberto';
          const dados = aberto ? msg.dados : { ...(prev?.dados || {}), ...msg.dados };
          this.saveKey(sistema, { ...msg, ligado_a: msg.ligado_a || prev?.ligado_a, dados }, { estado: aberto ? 'aberto' : 'fechado' });
          this.store.log(aberto ? 'link.blocker_opened' : 'link.blocker_closed', msg.chave, `${aberto ? 'Bloqueio aberto' : 'Bloqueio encerrado'} no Diário: ${(dados.texto || msg.chave).slice(0, 100)}`);
          return { resultado: prev ? 'atualizado' : 'criado' };
        }
        default: return { resultado: 'recusado', motivo: `o GTD não recebe ${msg.tipo}` };
      }
    });
  }
  applyAcao(sistema, msg, prev) {
    const s = this.store, d = msg.dados, estado = d.estado || 'aberta';
    const proj = this.projectFor(sistema, msg.ligado_a);
    const mine = isMine(d.responsavel);
    const notes = [d.prazo ? `Prazo: ${fmtBr(d.prazo)}` : null, !mine ? `Responsável: ${d.responsavel}` : null,
      `Origem: ${SYSTEMS[sistema].nome}`, msg.ligado_a ? `Ligado a: ${msg.ligado_a}` : null].filter(Boolean).join(' · ');
    let item = null;
    if (prev?.gtd_id) { try { item = s.getItem(prev.gtd_id); } catch { item = null; } }

    if (!item) {
      if (estado !== 'aberta') { this.saveKey(sistema, msg, { estado }); return { resultado: 'ignorado', motivo: `ação já ${estado} no Diário; nada criado` }; }
      ({ item } = s.capture({ text: d.texto, notes, source: 'Diário', source_ref: msg.chave, hub: proj?.hub || SYSTEMS[sistema].hub,
        meta: { link_key: msg.chave, sistema, prazo: d.prazo || null, responsavel: d.responsavel || null, project_id: proj?.id || null } }));
      if (!mine) s.patch('items', item.id, { bucket: 'waiting', destination: `Aguardando: ${d.responsavel}`, processed_at: nowIso() });
      this.saveKey(sistema, msg, { estado, gtd_id: item.id });
      return { resultado: 'criado', gtd_id: item.id };
    }

    const meta = { ...(item.meta || {}), prazo: d.prazo || null, responsavel: d.responsavel || null, project_id: proj?.id || item.meta?.project_id || null };
    const up = { notes, meta };
    if (['inbox', 'waiting'].includes(item.bucket)) {
      up.text = d.texto;
      if (estado === 'aberta') Object.assign(up, mine ? { bucket: 'inbox', destination: null, processed_at: null }
        : { bucket: 'waiting', destination: `Aguardando: ${d.responsavel}`, processed_at: item.processed_at || nowIso() });
    }
    if (estado !== 'aberta') {
      const label = estado === 'feita' ? 'Concluída no Diário' : 'Cancelada no Diário';
      if (['inbox', 'waiting'].includes(item.bucket)) Object.assign(up, { bucket: estado === 'feita' ? 'processed' : 'trash', destination: label, processed_at: nowIso() });
      for (const t of s.db.prepare('SELECT id FROM tasks WHERE item_id = ? AND done = 0').all(item.id)) {
        if (estado === 'feita') s.updateTask(t.id, { done: true, _origin: 'link' }); else s.deleteTask(t.id);
      }
    }
    s.patch('items', item.id, up);
    s.log('item.updated', item.id, `Diário atualizou: ${d.texto.slice(0, 80)}${estado !== 'aberta' ? ` (${estado})` : ''}`);
    this.saveKey(sistema, msg, { estado, gtd_id: item.id });
    return { resultado: 'atualizado', gtd_id: item.id };
  }

  // ---------- saída: mensagens de que o GTD é dono ----------
  enqueue(sistema, tipo, chave, dados, ligadoA) {
    const msg = { contrato: CONTRACT, tipo, chave, alterado_em: nowIso(), ligado_a: ligadoA || undefined, dados };
    const errs = validate(msg, { from: 'gtd' });
    if (errs.length) throw new GtdError(500, `Mensagem de saída inválida: ${errs.join('; ')}`);
    const dup = this.db.prepare('SELECT id FROM link_outbox WHERE sistema = ? AND tipo = ? AND chave = ? AND confirmed_at IS NULL').get(sistema, tipo, chave);
    if (dup) this.db.prepare('UPDATE link_outbox SET alterado_em = ?, dados = ?, ligado_a = ? WHERE id = ?').run(msg.alterado_em, JSON.stringify(dados), ligadoA || null, dup.id);
    else this.db.prepare('INSERT INTO link_outbox (sistema, tipo, chave, alterado_em, ligado_a, dados, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sistema, tipo, chave, msg.alterado_em, ligadoA || null, JSON.stringify(dados), nowIso());
    this.logRow(sistema, 'saida', tipo, chave, 'enfileirado');
  }
  onItemDone(itemId) {
    let item;
    try { item = this.store.getItem(itemId); } catch { return; }
    const key = item.meta?.link_key, sistema = item.meta?.sistema || 'diario';
    if (!key || !SYSTEMS[sistema]) return;
    const k = this.key(sistema, key);
    if (k && k.estado !== 'aberta') return; // o Diário já fechou: sem eco
    this.enqueue(sistema, 'acao.concluida', key, { concluida_em: nowIso() }, k?.ligado_a);
    this.store.log('link.queued', item.id, `Conclusão enviada ao Diário: ${item.text.slice(0, 80)}`);
  }
  onToDiario(item, opts = {}) {
    let ref = opts.ref || null;
    const pid = opts.project || item.meta?.project_id;
    if (!ref && pid) { try { const p = this.store.findProject(pid); ref = this.db.prepare('SELECT ref FROM links WHERE project_id = ? ORDER BY created_at').get(p.id)?.ref || null; } catch { /* sem projeto */ } }
    this.enqueue('diario', 'captura.enviada', `gtd:item:${item.id}`, { texto: item.text, notas: item.notes || '', url: item.url || '' }, ref);
  }
  pending(sistema = 'diario') {
    return this.db.prepare('SELECT * FROM link_outbox WHERE sistema = ? AND confirmed_at IS NULL ORDER BY id').all(sistema)
      .map(r => ({ id: r.id, contrato: CONTRACT, tipo: r.tipo, chave: r.chave, alterado_em: r.alterado_em, ...(r.ligado_a ? { ligado_a: r.ligado_a } : {}), dados: P(r.dados, {}) }));
  }

  // ---------- sincronização ----------
  sync({ sistema = 'diario', mensagens = [], confirmados = [] } = {}) {
    sistema = this.sys(sistema);
    if (!Array.isArray(mensagens) || !Array.isArray(confirmados)) throw new GtdError(400, '"mensagens" e "confirmados" devem ser listas');
    if (mensagens.length > 500) throw new GtdError(413, 'Máximo de 500 mensagens por sincronização');
    let conf = 0;
    for (const id of confirmados) {
      const r = this.db.prepare('UPDATE link_outbox SET confirmed_at = ? WHERE id = ? AND sistema = ? AND confirmed_at IS NULL').run(nowIso(), +id, sistema);
      if (r.changes) { conf++; const o = this.db.prepare('SELECT tipo, chave FROM link_outbox WHERE id = ?').get(+id); this.logRow(sistema, 'saida', o.tipo, o.chave, 'confirmado'); }
    }
    const aplicadas = mensagens.map(m => {
      let r;
      try { r = this.apply(sistema, m); }
      catch (e) { r = { resultado: 'recusado', motivo: e.message }; }
      this.logRow(sistema, 'entrada', m?.tipo, m?.chave, r.resultado, r.motivo);
      return { chave: m?.chave ?? null, tipo: m?.tipo ?? null, ...r };
    });
    const pendentes = this.pending(sistema);
    const n = t => aplicadas.filter(a => a.resultado === t).length;
    this.store.setState('link_last_sync', { ...(this.store.getState('link_last_sync', {}) || {}), [sistema]: nowIso() }, { silent: true });
    this.store.log('link.sync', null, `Sincronização com ${SYSTEMS[sistema].nome}: ${n('criado') + n('atualizado')} aplicada(s), ${n('ignorado')} ignorada(s), ${n('recusado')} recusada(s), ${conf} confirmada(s), ${pendentes.length} pendente(s)`);
    return { contrato: CONTRACT, aplicadas, pendentes, servidor_em: nowIso() };
  }

  logRow(sistema, direcao, tipo, chave, resultado, motivo) {
    this.db.prepare('INSERT INTO link_log (ts, sistema, direcao, tipo, chave, resultado, motivo) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(nowIso(), sistema, direcao, tipo ?? null, chave ?? null, resultado, motivo ?? null);
  }
  log({ limit = 50, sistema } = {}) {
    return this.db.prepare(`SELECT * FROM link_log ${sistema ? 'WHERE sistema = ?' : ''} ORDER BY id DESC LIMIT ?`)
      .all(...(sistema ? [sistema] : []), Math.min(+limit || 50, 500));
  }
  blockers(sistema = 'diario') {
    return this.db.prepare(`SELECT * FROM link_keys WHERE sistema = ? AND tipo LIKE 'bloqueio.%' AND estado = 'aberto' ORDER BY alterado_em DESC`).all(sistema)
      .map(r => ({ chave: r.chave, ligado_a: r.ligado_a, texto: P(r.dados, {}).texto || r.chave, desde: r.alterado_em, project: this.projectFor(sistema, r.ligado_a) }));
  }
  alerts() {
    return Object.keys(SYSTEMS).flatMap(s => this.blockers(s).map(b => ({ level: 'danger', code: 'bloqueio_externo', entity_id: b.project?.id,
      text: `Bloqueio no ${SYSTEMS[s].nome}${b.project ? ` (${b.project.name})` : ''}: ${b.texto}` })));
  }
  status() {
    const last = this.store.getState('link_last_sync', {}) || {};
    return Object.fromEntries(Object.entries(SYSTEMS).map(([s, def]) => [s, {
      nome: def.nome, ultima_sync: last[s] || null, pendentes: this.pending(s).length,
      bloqueios: this.blockers(s).length, ligacoes: this.db.prepare('SELECT COUNT(*) n FROM links WHERE sistema = ?').get(s).n,
    }]));
  }

  // ---------- backup ----------
  exportData() {
    return {
      links: this.db.prepare('SELECT * FROM links').all(),
      keys: this.db.prepare('SELECT * FROM link_keys').all(),
      outbox: this.db.prepare('SELECT * FROM link_outbox').all(),
    };
  }
  importData(data, { replace = false } = {}) {
    if (replace) for (const t of ['links', 'link_keys', 'link_outbox']) this.db.exec(`DELETE FROM ${t}`);
    let n = 0;
    const ins = (table, cols, row) => { this.db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map(c => row[c] ?? null)); n++; };
    for (const r of data.links || []) ins('links', ['id', 'sistema', 'project_id', 'ref', 'titulo', 'created_at'], r);
    for (const r of data.keys || []) ins('link_keys', ['sistema', 'chave', 'tipo', 'alterado_em', 'ligado_a', 'estado', 'dados', 'gtd_id', 'updated_at'], r);
    for (const r of data.outbox || []) ins('link_outbox', ['id', 'sistema', 'tipo', 'chave', 'alterado_em', 'ligado_a', 'dados', 'created_at', 'confirmed_at'], r);
    return n;
  }
}
