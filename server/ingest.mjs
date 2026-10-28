// Normalizadores de ingestão: transformam o payload de cada fonte em itens de inbox.
// Todas as fontes terminam em store.capture(), que deduplica por (source, source_ref).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { GtdError, HUBS } from './store.mjs';

const HUB_KEYS = Object.keys(HUBS);

const first = (...v) => v.find(x => x !== undefined && x !== null && String(x).trim() !== '');

/** Campos aceitos no formato genérico (n8n, Zapier, Lovable, Apps Script, curl…). */
function generic(o, defaults) {
  if (typeof o === 'string') return { ...defaults, text: o };
  return {
    text: first(o.text, o.title, o.subject, o.message, o.content, o.name),
    notes: first(o.notes, o.body, o.description, o.details, o.snippet),
    url: first(o.url, o.link, o.html_url),
    source: first(o.source, defaults.source),
    source_ref: first(o.source_ref, o.external_id, o.messageId, o.message_id, o.id),
    hub: first(o.hub, defaults.hub),
    meta: o.meta,
  };
}

function asList(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.items)) return body.items;
  return [body];
}

/** Texto livre: uma linha = um item. Aceita listas markdown, checkboxes, numeração. */
export function parseLines(text) {
  return parseBulk(text).map(e => e.text);
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/i;
const BULLET_RE = /^(?:[-*•+]\s+(?:\[ \]\s+)?|\d+[.)]\s+|\[ \]\s+)/;
const fold = s => String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Tira pontuação colada no fim do link e parâmetros de rastreio, para deduplicar o mesmo endereço. */
export function normalizeUrl(u) {
  let s = String(u).replace(/[).,;:!?\]]+$/, '');
  try {
    const x = new URL(s);
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|mc_|igshid$|si$)/i.test(k)) x.searchParams.delete(k);
    x.hash = '';
    s = x.href.replace(/\/$/, '');
  } catch { /* deixa como veio */ }
  return s;
}
function urlLabel(u) {
  try { const x = new URL(u); const p = decodeURIComponent(x.pathname).replace(/\/$/, ''); return (x.host.replace(/^www\./, '') + (p.length > 1 ? p : '')).slice(0, 140); }
  catch { return u.slice(0, 140); }
}

/**
 * Ingestão geral: texto colado com itens, links, listas e anotações misturados.
 *  - modo "linhas": cada linha é um item; modo "blocos": linhas seguidas formam um item
 *    (1ª linha = título, demais = notas) e uma linha em branco separa os itens.
 *  - Títulos markdown (# …) com o nome de um hub viram o hub dos itens abaixo; outros títulos são ignorados.
 *  - #hub dentro do texto define o hub do item; o primeiro link vira o campo url.
 *  - "- [x]" (já feito) é ignorado.
 * @returns {{text, notes, url, hub, source_ref, sem_titulo}[]}
 */
export function parseBulk(text, { mode = 'linhas', hub = null, hubs = HUB_KEYS } = {}) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const squash = s => fold(s).replace(/[^a-z0-9]/g, '');
  const hubOf = s => { const k = squash(s); return k ? hubs.find(h => squash(h) === k) || null : null; };
  const items = [];
  let curHub = hub || null;
  let block = null;
  const flush = () => { if (block?.length) items.push(build(block, curHub)); block = null; };
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) { if (mode === 'blocos') flush(); continue; }
    const h = l.match(/^#{1,6}\s+(.*)$/);
    if (h) { flush(); const hh = hubOf(h[1]); curHub = hh || hub || null; continue; }
    if (/^[-*]\s+\[[xX]\]/.test(l)) continue;
    if (mode === 'blocos') (block ||= []).push(l);
    else items.push(build([l], curHub));
  }
  flush();
  return items.filter(Boolean);

  function build(ls, blockHub) {
    let [head, ...rest] = ls.map(x => x.replace(BULLET_RE, '').trim());
    let itemHub = blockHub;
    const tagRe = /(^|\s)#([\p{L}\p{N}_-]+)/gu;
    const takeTags = s => s.replace(tagRe, (m, sp, tag) => { const k = hubOf(tag); if (k) { itemHub = k; return sp; } return m; }).replace(/\s{2,}/g, ' ').trim();
    head = takeTags(head);
    rest = rest.map(takeTags).filter(Boolean);
    let url = null;
    const m = head.match(URL_RE) || rest.join('\n').match(URL_RE);
    if (m) url = normalizeUrl(m[0]);
    if (m && head.includes(m[0])) head = head.replace(m[0], ' ').replace(/\s{2,}/g, ' ').replace(/^[\s\-–—:|·•>]+|[\s\-–—:|·•<(]+$/g, '').trim();
    let semTitulo = false;
    if (!head) { head = rest.length && !URL_RE.test(rest[0]) ? rest.shift() : (url ? urlLabel(url) : ''); semTitulo = !!url && !ls.some(x => x.replace(URL_RE, '').replace(BULLET_RE, '').trim()); }
    if (!head) return null;
    return { text: head.slice(0, 2000), notes: rest.length ? rest.join('\n').slice(0, 20000) : null, url, hub: itemHub,
      source_ref: url ? 'url:' + url : null, sem_titulo: semTitulo };
  }
}

/** Busca o <title> de páginas para links colados sem texto (até 20 links, 4 s cada). */
export async function fillTitles(entries, { max = 20, timeoutMs = 4000 } = {}) {
  const todo = entries.filter(e => e.sem_titulo && e.url).slice(0, max);
  await Promise.all(todo.map(async e => {
    try {
      const res = await fetch(e.url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'GTD-Framework/1.0', Accept: 'text/html' } });
      if (!res.ok || !(res.headers.get('content-type') || '').includes('html')) return;
      const reader = res.body.getReader(); let html = ''; const dec = new TextDecoder();
      while (html.length < 65536) { const { value, done } = await reader.read(); if (done) break; html += dec.decode(value, { stream: true }); if (/<\/title>/i.test(html)) break; }
      reader.cancel().catch(() => {});
      const t = (html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) || html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1];
      if (t) { e.text = decodeEntities(t).replace(/\s+/g, ' ').trim().slice(0, 300) || e.text; e.sem_titulo = false; e.titulo_buscado = true; }
    } catch { /* fica com o endereço como título */ }
  }));
  return entries;
}
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (m, c) => {
    const k = c.toLowerCase();
    if (k[0] === '#') { const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[k] || m;
  });
}

function email(o, d) {
  const from = first(o.from, o.sender, o.de);
  return {
    text: first(o.subject, o.assunto, o.title, '(sem assunto)'),
    notes: [from ? `De: ${from}` : null, first(o.snippet, o.body, o.text, o.plain)].filter(Boolean).join('\n\n').slice(0, 5000),
    url: first(o.url, o.threadUrl, o.permalink),
    source: first(o.source, d.source, 'Gmail'),
    source_ref: first(o.messageId, o.message_id, o.id, o.threadId),
    hub: first(o.hub, d.hub),
  };
}

function github(body, headers, d, store) {
  const ev = headers['x-github-event'] || body.event || '';
  const repo = body.repository?.full_name || '';
  const ref = headers['x-github-delivery'] || null;
  const base = { source: 'GitHub', source_ref: ref, hub: d.hub };
  // vincula ao projeto pelo campo github (ex.: usuario/rsl-xai-mas)
  const proj = repo ? store.listProjects().find(p => p.github && p.github.toLowerCase() === repo.toLowerCase()) : null;
  if (proj) { base.hub = base.hub || proj.hub; base.meta = { project_id: proj.id, repo }; }
  const r = repo.split('/')[1] || repo;
  switch (ev) {
    case 'ping': return null;
    case 'issues': {
      if (!['opened', 'assigned', 'reopened', 'labeled'].includes(body.action)) return null;
      return { ...base, text: `${r}: issue #${body.issue.number} ${body.action} — ${body.issue.title}`, url: body.issue.html_url, notes: body.issue.body?.slice(0, 3000) };
    }
    case 'pull_request': {
      if (!['opened', 'review_requested', 'ready_for_review', 'reopened'].includes(body.action)) return null;
      return { ...base, text: `${r}: PR #${body.pull_request.number} ${body.action} — ${body.pull_request.title}`, url: body.pull_request.html_url, notes: body.pull_request.body?.slice(0, 3000) };
    }
    case 'issue_comment':
      return { ...base, text: `${r}: comentário em #${body.issue.number} — ${body.issue.title}`, url: body.comment?.html_url, notes: body.comment?.body?.slice(0, 3000) };
    case 'pull_request_review':
      return { ...base, text: `${r}: review ${body.review?.state} em PR #${body.pull_request.number} — ${body.pull_request.title}`, url: body.review?.html_url };
    case 'push': {
      const commits = body.commits || [];
      if (!commits.length) return null;
      return { ...base, text: `${r}: ${commits.length} commit(s) em ${String(body.ref || '').replace('refs/heads/', '')} — ${commits.at(-1).message.split('\n')[0]}`,
        url: body.compare, notes: commits.map(c => `- ${c.message.split('\n')[0]} (${c.author?.name || ''})`).join('\n') };
    }
    case 'release':
      return body.action === 'published' ? { ...base, text: `${r}: release ${body.release.tag_name} publicada`, url: body.release.html_url } : null;
    case 'workflow_run':
      return body.workflow_run?.conclusion === 'failure' ? { ...base, text: `${r}: CI falhou — ${body.workflow_run.name} (${body.workflow_run.head_branch})`, url: body.workflow_run.html_url } : null;
    default:
      return ev ? { ...base, text: `${r || 'GitHub'}: evento ${ev}${body.action ? ` (${body.action})` : ''}` } : null;
  }
}

export function verifyGithubSignature(raw, header, secret) {
  if (!secret) return true;
  if (!header) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(String(header));
  return a.length === b.length && timingSafeEqual(a, b);
}

const DEFAULT_SOURCE = { email: 'Gmail', gmail: 'Gmail', github: 'GitHub', keep: 'Google Keep', whatsapp: 'WhatsApp self',
  lovable: 'Lovable', n8n: 'n8n', claude: 'Claude', web: 'Web', drive: 'Google Drive', text: 'Captura manual', geral: 'Captura manual', generic: 'Captura manual' };
const FREE_TEXT = new Set(['text', 'keep', 'geral']);

/**
 * @param kind  generic | email | gmail | github | text | keep | whatsapp | lovable | n8n | claude | web | drive
 * @returns {{captured: object[], duplicates: number, skipped: number}}
 */
export async function ingest(store, kind, { body, raw, headers = {}, query = {} }) {
  if (!DEFAULT_SOURCE[kind]) throw new GtdError(404, `Fonte de ingestão desconhecida: ${kind}. Use: ${Object.keys(DEFAULT_SOURCE).join(', ')}`);
  const o = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const opt = (k, ...alias) => first(query[k], ...alias.map(a => query[a]), o[k], ...alias.map(a => o[a]));
  const hubOpt = opt('hub');
  const d = { source: opt('source', 'fonte') || DEFAULT_SOURCE[kind], hub: hubOpt && HUBS[hubOpt] ? hubOpt : undefined };
  const dry = ['1', 'true', true].includes(opt('dry', 'previa'));
  let entries = [];
  if (kind === 'github') {
    if (!verifyGithubSignature(raw || '', headers['x-hub-signature-256'], process.env.GTD_GITHUB_SECRET)) throw new GtdError(401, 'Assinatura do GitHub inválida');
    entries = [github(body || {}, headers, d, store)];
  } else if (typeof body === 'string' || FREE_TEXT.has(kind)) {
    const text = typeof body === 'string' ? body : first(o.text, o.texto, o.content, '');
    const mode = opt('mode', 'modo') === 'blocos' ? 'blocos' : 'linhas';
    entries = parseBulk(text, { mode, hub: d.hub }).map(e => ({ ...e, source: d.source, hub: e.hub || d.hub }));
    if (['1', 'true', true].includes(opt('titulos', 'titles'))) await fillTitles(entries);
  } else if (kind === 'email' || kind === 'gmail') {
    entries = asList(body).map(o => email(o || {}, d));
  } else {
    entries = asList(body).map(o => generic(o ?? '', d));
  }
  const valid = entries.filter(e => e && e.text);
  if (dry) {
    const exists = e => e.source_ref && store.db.prepare('SELECT id FROM items WHERE source = ? AND source_ref = ?').get(e.source, String(e.source_ref));
    const preview = valid.map(({ text, notes, url, hub, source, source_ref, titulo_buscado }) => ({ text, notes, url, hub: hub || null, source, titulo_buscado: !!titulo_buscado, ja_existe: !!exists({ source, source_ref }) }));
    return { previa: true, total: preview.length, novos: preview.filter(p => !p.ja_existe).length, itens: preview, skipped: entries.length - valid.length };
  }
  const results = valid.length ? store.captureMany(valid.map(({ sem_titulo, titulo_buscado, ...e }) => e)) : [];
  return {
    captured: results.filter(r => !r.duplicate).map(r => r.item),
    duplicates: results.filter(r => r.duplicate).length,
    skipped: entries.length - valid.length,
  };
}
