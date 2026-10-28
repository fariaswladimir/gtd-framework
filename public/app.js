// GTD Framework — cliente web. Todo o estado vive no servidor (API REST);
// a página recarrega o snapshot (/api/bootstrap) a cada mudança recebida via SSE.
'use strict';

// ===== utilitários =====
const $ = id => document.getElementById(id);
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = u => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : '#'; } catch { return '#'; } };
const host = u => { try { return new URL(u).hostname; } catch { return ''; } };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const fmtDate = iso => iso ? new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }) : '';
const fmtDateTime = iso => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

function toast(msg, err = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), err ? 4500 : 2200);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copiado'); }
  catch { prompt('Copie:', text); }
}

// ===== API e login =====
// A interface entra com e-mail + senha (cookie de sessão HttpOnly). O token existe só para integrações;
// ele é recebido da sessão e mostrado na tela Conectar, nunca guardado no navegador.
const API = '';
let TOKEN = '';
try { localStorage.removeItem('gtd-token'); } catch {}
if (/token=/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
let started = false;
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  if (res.status === 401 && !path.startsWith('/api/login') && !path.startsWith('/api/setup') && !path.startsWith('/api/password')) {
    setConn(false); showLogin(data); throw new Error('Sessão encerrada. Entre de novo.');
  }
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data;
}
function showLogin(st = {}) {
  if (stream) { stream.close(); stream = null; }
  const setup = !!st.setup;
  $('loginScreen').hidden = false;
  document.body.classList.add('locked');
  $('loginTitle').textContent = setup ? 'Criar senha' : 'Entrar';
  $('loginLead').textContent = setup ? 'Primeiro acesso: use o e-mail do dono deste GTD e crie uma senha de pelo menos 10 caracteres.'
    : st.setup_remote ? 'A senha ainda não foi criada. Abra o GTD no computador onde ele está instalado para criá-la.'
    : 'Acesso restrito ao dono deste GTD.';
  $('loginConfirmWrap').hidden = !setup;
  $('loginConfirm').required = setup;
  $('loginPassword').autocomplete = setup ? 'new-password' : 'current-password';
  $('loginBtn').textContent = setup ? 'Criar senha e entrar' : 'Entrar';
  $('loginBtn').disabled = !!st.setup_remote;
  $('loginForm').dataset.mode = setup ? 'setup' : 'login';
  $('loginError').textContent = '';
  setTimeout(() => $('loginEmail').focus(), 0);
}
function hideLogin() { $('loginScreen').hidden = true; document.body.classList.remove('locked'); $('loginPassword').value = ''; $('loginConfirm').value = ''; }
$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const mode = $('loginForm').dataset.mode;
  const email = $('loginEmail').value.trim(), password = $('loginPassword').value;
  if (mode === 'setup' && password !== $('loginConfirm').value) { $('loginError').textContent = 'As duas senhas não são iguais.'; return; }
  $('loginBtn').disabled = true; $('loginError').textContent = '';
  try {
    const r = await api(mode === 'setup' ? '/api/setup' : '/api/login', { method: 'POST', body: { email, password } });
    TOKEN = r.token || '';
    hideLogin();
    await start();
  } catch (err) { $('loginError').textContent = err.message; $('loginPassword').select(); }
  finally { $('loginBtn').disabled = false; }
});
/** Executa uma mutação, mostra erro amigável e recarrega o estado. */
async function act(promise, okMsg) {
  try { const r = await promise; if (okMsg) toast(okMsg); await refresh(); return r; }
  catch (e) { toast(e.message, true); return null; }
}

let S = null;
function setConn(ok) {
  const d = $('connDot');
  d.className = 'conn-dot ' + (ok ? 'on' : 'off');
  d.title = ok ? 'Conectado ao servidor' : 'Sem conexão com o servidor';
}
async function refresh() {
  try { S = await api('/api/bootstrap'); setConn(true); renderAll(); }
  catch (e) { setConn(false); if (!S) $('dailyTasks').innerHTML = `<div class="card" style="color:var(--danger)">Não foi possível conectar ao servidor GTD: ${esc(e.message)}<br><small style="color:var(--fg-secondary)">Rode <code>npm start</code> na pasta do projeto.</small></div>`; }
}
const refreshSoon = debounce(refresh, 250);
let stream;
function connectStream() {
  if (stream) stream.close();
  if (typeof EventSource === 'undefined') return;
  stream = new EventSource(API + '/api/stream');
  stream.addEventListener('change', refreshSoon);
  stream.onopen = () => setConn(true);
  stream.onerror = () => setConn(false);
}
async function saveState(key, value) {
  try { await api('/api/state/' + key, { method: 'PUT', body: value }); }
  catch (e) { toast(e.message, true); }
}

// ===== diálogo genérico =====
function dialog({ title, fields = [], submit = 'Salvar', danger = false, text }) {
  const dlg = $('dlg'), form = $('dlgForm');
  form.innerHTML = `<h3 style="margin-bottom:12px;">${esc(title)}</h3>${text ? `<p style="font-size:0.85rem;color:var(--fg-secondary);margin-bottom:12px;">${esc(text)}</p>` : ''}
    ${fields.map(f => `<div class="field"><label for="f_${f.name}">${esc(f.label)}</label>${
      f.type === 'select' ? `<select id="f_${f.name}" name="${f.name}">${f.options.map(o => `<option value="${esc(o.value)}" ${String(o.value) === String(f.value ?? '') ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`
      : f.type === 'textarea' ? `<textarea id="f_${f.name}" name="${f.name}" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea>`
      : `<input id="f_${f.name}" name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}" ${f.required ? 'required' : ''}>`
    }</div>`).join('')}
    <div class="dlg-actions"><button value="cancel" formnovalidate class="btn btn-outline btn-sm">Cancelar</button><button value="ok" class="btn btn-sm" ${danger ? 'style="background:var(--danger)"' : ''}>${esc(submit)}</button></div>`;
  return new Promise(resolve => {
    dlg.onclose = () => {
      if (dlg.returnValue !== 'ok') return resolve(null);
      resolve(Object.fromEntries(new FormData(form)));
    };
    dlg.returnValue = '';
    dlg.showModal();
    form.querySelector('input,select,textarea')?.focus();
  });
}
const laneOptions = () => Object.entries(S.meta.lanes).map(([value, l]) => ({ value, label: l.name }));
const hubOptions = (empty = '— sem hub —') => [{ value: '', label: empty }, ...Object.keys(S.meta.hubs).map(h => ({ value: h, label: h }))];
const periodOptions = [{ value: 'manhã', label: '🌅 Manhã' }, { value: 'tarde', label: '☀️ Tarde' }, { value: 'noite', label: '🌙 Noite' }];
const projectOptions = (filter = () => true) => S.projects.filter(filter).map(p => ({ value: p.id, label: `${p.name} · ${p.status}` }));

// ===== navegação =====
document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => showScreen(btn.dataset.screen)));
function showScreen(id) {
  if (!$(id)) return;
  document.querySelectorAll('.tab-btn').forEach(t => t.classList.toggle('active', t.dataset.screen === id));
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  lsSet('gtd-tab', id);
  if (id === 'screen-roda' && rodaChart) rodaChart.resize();
}
showScreen(lsGet('gtd-tab') || 'screen-tarefas');

// ===== ações delegadas (data-act) =====
const ACTIONS = {};
ACTIONS['logout'] = async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  TOKEN = ''; S = null; showLogin({});
};
ACTIONS['change-password'] = async () => {
  const v = await dialog({ title: 'Trocar senha', submit: 'Trocar', text: 'As outras sessões abertas (outros navegadores ou o celular) serão encerradas.', fields: [
    { name: 'current', label: 'Senha atual', type: 'password', required: true },
    { name: 'password', label: 'Nova senha (mín. 10 caracteres)', type: 'password', required: true },
    { name: 'confirm', label: 'Repita a nova senha', type: 'password', required: true },
  ] });
  if (!v) return;
  if (v.password !== v.confirm) { toast('As duas senhas novas não são iguais.', true); return; }
  try { await api('/api/password', { method: 'POST', body: { current: v.current, password: v.password } }); toast('Senha trocada'); }
  catch (e) { toast(e.message, true); }
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || !ACTIONS[el.dataset.act]) return;
  e.preventDefault();
  ACTIONS[el.dataset.act](el.dataset, el, e);
});
document.addEventListener('keydown', e => {
  if (e.key === 'c' && !e.ctrlKey && !e.metaKey && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !$('dlg').open) {
    e.preventDefault(); ACTIONS['quick-capture']();
  }
});

function renderAll() {
  renderMetaSelects();
  renderInbox(); renderLanes(); renderProjects(); renderDay(); renderCadences(); renderActivity();
  renderIntegrations(); renderHubs(); renderRoda(); renderHealth(); renderMeds(); renderLinks();
}

// ===== selects dependentes de meta =====
let metaRendered = false;
function renderMetaSelects() {
  if (metaRendered) return;
  metaRendered = true;
  $('captureSource').innerHTML = S.meta.sources.map(s => `<option value="${esc(s)}">${getSourceIcon(s)} ${esc(s)}</option>`).join('');
  $('captureHub').innerHTML = hubOptions('hub…').map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
  $('inboxHubFilter').innerHTML = hubOptions('Todos os hubs').map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
  $('bulkSource').innerHTML = S.meta.sources.map(x => `<option value="${esc(x)}">${getSourceIcon(x)} ${esc(x)}</option>`).join('');
  $('bulkHub').innerHTML = hubOptions('Hub: pelo texto').map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
}

// ===== INBOX =====
const SRC_COLORS = { 'Gmail': '#ea4335', 'Google Keep': '#fbbc04', 'Google Drive': '#4285f4', 'GitHub': '#8b5cf6', 'Claude': 'var(--accent)', 'Claude Edge': '#059669', 'WhatsApp self': '#25d366', 'Lovable': '#ff6b6b', 'Web': '#0ea5e9', 'n8n': '#ea4b71', 'Diário': 'var(--lane-paralelos)' };
const SRC_ICONS = { 'Gmail': '✉', 'Google Keep': '📌', 'Google Drive': '📁', 'GitHub': '⟨/⟩', 'Claude': '◈', 'Claude Edge': '◈', 'WhatsApp self': '💬', 'Captura manual': '✎', 'Captura rápida': '⚡', 'Lovable': '♥', 'Web': '🌐', 'n8n': '⚙', 'Diário': '📓' };
const getSourceColor = s => SRC_COLORS[s] || 'var(--fg-secondary)';
const getSourceIcon = s => SRC_ICONS[s] || '•';
let inboxFilter = 'inbox';

$('captureForm').addEventListener('submit', async e => {
  e.preventDefault();
  const text = $('captureInput').value.trim();
  if (!text) return;
  $('captureInput').value = '';
  await act(api('/api/items', { method: 'POST', body: { text, source: $('captureSource').value, hub: $('captureHub').value || undefined } }));
  if (inboxFilter !== 'inbox') ACTIONS['inbox-filter']({ filter: 'inbox' });
  $('captureInput').focus();
});
$('inboxSearch').addEventListener('input', debounce(() => renderInbox(), 150));
$('inboxHubFilter').addEventListener('change', () => renderInbox());

ACTIONS['inbox-filter'] = d => {
  inboxFilter = d.filter;
  document.querySelectorAll('.inbox-filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === inboxFilter));
  renderInbox();
};
// ===== INGESTÃO GERAL =====
let bulkPreviewOf = null; // texto + opções da última pré-visualização; capturar exige pré-visualização atual
const bulkBody = (extra = {}) => ({ text: $('bulkText').value, mode: $('bulkMode').value, source: $('bulkSource').value,
  hub: $('bulkHub').value || undefined, titulos: $('bulkTitles').checked, ...extra });
function bulkInvalidate() {
  bulkPreviewOf = null;
  $('bulkCaptureBtn').disabled = true;
  $('bulkCaptureBtn').textContent = 'Capturar';
  if ($('bulkPreview').innerHTML) $('bulkStatus').textContent = 'O texto mudou: pré-visualize de novo.';
}
['bulkText', 'bulkMode', 'bulkSource', 'bulkHub', 'bulkTitles'].forEach(id => $(id).addEventListener(id === 'bulkText' ? 'input' : 'change', bulkInvalidate));
$('bulkFiles').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const parts = [];
  for (const f of files) {
    if (f.size > 2 * 1024 * 1024) { toast(`${f.name} tem mais de 2 MB e foi ignorado`, true); continue; }
    let t = await f.text();
    if (/\.json$/i.test(f.name)) {
      try { const j = JSON.parse(t); t = (Array.isArray(j) ? j : j.items || [j]).map(x => typeof x === 'string' ? x : [x.text || x.title || x.name, x.url || x.link].filter(Boolean).join(' ')).join('\n'); }
      catch { /* usa o texto cru */ }
    } else if (/\.(csv|tsv)$/i.test(f.name)) {
      t = t.split(/\r?\n/).map(l => l.split(/[;\t,](?=(?:[^"]*"[^"]*")*[^"]*$)/).map(c => c.replace(/^"|"$/g, '').trim()).filter(Boolean).join(' — ')).join('\n');
    }
    parts.push(t.trim());
  }
  const cur = $('bulkText').value.trim();
  $('bulkText').value = [cur, ...parts].filter(Boolean).join('\n\n');
  bulkInvalidate();
  toast(`${files.length} arquivo(s) carregado(s)`);
});
ACTIONS['bulk-preview'] = async () => {
  if (!$('bulkText').value.trim()) { $('bulkStatus').textContent = 'Cole algum texto ou carregue um arquivo primeiro.'; return; }
  $('bulkStatus').textContent = $('bulkTitles').checked ? 'Lendo os itens e buscando títulos dos links…' : 'Lendo os itens…';
  try {
    const body = bulkBody({ dry: true });
    const r = await api('/api/ingest/geral', { method: 'POST', body });
    bulkPreviewOf = JSON.stringify(bulkBody());
    $('bulkPreview').innerHTML = r.total ? `<div class="bulk-list">${r.itens.map((it, i) => `<div class="bulk-row ${it.ja_existe ? 'dup' : ''}">
        <span class="bn">${i + 1}</span>
        <span class="bt">${esc(it.text)}${it.url ? `<a class="bu" href="${esc(safeUrl(it.url))}" target="_blank" rel="noopener">${esc(it.url)}</a>` : ''}${it.notes ? `<span class="bnotes">${esc(it.notes)}</span>` : ''}</span>
        <span class="btags">${it.hub ? `<span class="chip">${esc(it.hub)}</span>` : ''}${it.titulo_buscado ? '<span class="chip" title="Título lido da página">título da página</span>' : ''}${it.ja_existe ? '<span class="chip">já está no GTD</span>' : ''}</span>
      </div>`).join('')}</div>` : '';
    $('bulkStatus').textContent = r.total ? `${r.total} item(ns) encontrado(s) · ${r.novos} novo(s)${r.total - r.novos ? ` · ${r.total - r.novos} já existia(m) e será(ão) ignorado(s)` : ''}` : 'Nenhum item encontrado no texto.';
    $('bulkCaptureBtn').disabled = !r.novos;
    $('bulkCaptureBtn').textContent = r.novos ? `Capturar ${r.novos} item(ns)` : 'Capturar';
  } catch (e) { $('bulkStatus').textContent = 'Erro: ' + e.message; }
};
ACTIONS['bulk-capture'] = async () => {
  if (bulkPreviewOf !== JSON.stringify(bulkBody())) { bulkInvalidate(); return; }
  $('bulkCaptureBtn').disabled = true;
  $('bulkStatus').textContent = 'Capturando…';
  const r = await act(api('/api/ingest/geral', { method: 'POST', body: bulkBody() }));
  if (!r) { $('bulkCaptureBtn').disabled = false; $('bulkStatus').textContent = 'Não foi possível capturar. Tente de novo.'; return; }
  $('bulkText').value = ''; $('bulkPreview').innerHTML = ''; bulkPreviewOf = null;
  $('bulkCaptureBtn').textContent = 'Capturar';
  $('bulkStatus').textContent = `✓ ${r.captured.length} item(ns) na inbox${r.duplicates ? ` · ${r.duplicates} já existia(m)` : ''}`;
  toast(`✓ ${r.captured.length} item(ns) na inbox`);
  if (inboxFilter !== 'inbox') ACTIONS['inbox-filter']({ filter: 'inbox' });
};

// ===== DITADO POR VOZ =====
// Usa o reconhecimento de fala do próprio navegador (Chrome/Edge). Sem suporte, indica o ditado do Windows (Win + H).
const SpeechRec = window.isSecureContext ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
/** Comandos falados: "próximo item"/"nova linha" → nova linha; "hashtag doutorado" → #doutorado. */
function applyVoiceCommands(t) {
  return String(t)
    .replace(/\s*\b(pr[óo]ximo item|novo item|nova linha)\b[.,;]?\s*/giu, '\n')
    .replace(/\b(?:hashtag|hub)\s+([\p{L}\p{N}-]+(?:\s+projects?)?)/giu,
      (m, w) => '#' + w.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, '-'))
    .replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{2,}/g, '\n');
}
const joinSpoken = (base, spoken, multi) => !base.trim() ? spoken : base.replace(/\s+$/, '') + (multi ? '\n' : ' ') + spoken;
let micRec = null, micBtn = null;
document.querySelectorAll('[data-act="mic"]').forEach(b => { b.hidden = !SpeechRec; b.dataset.label = b.textContent; });
$('micHelp').hidden = !SpeechRec;
$('micFallback').hidden = !!SpeechRec;
ACTIONS['mic'] = (d, btn) => {
  if (!SpeechRec) { toast('Use o ditado do Windows: clique no campo e aperte Win + H', true); return; }
  if (micRec) { const same = micBtn === btn; try { micRec.stop(); } catch {} if (same) return; }
  const el = $(d.target), multi = el.tagName === 'TEXTAREA';
  const r = new SpeechRec();
  r.lang = 'pt-BR'; r.interimResults = true; r.continuous = multi; r.maxAlternatives = 1;
  const base = el.value;
  r.onresult = ev => {
    // ev.results traz tudo o que foi dito nesta sessão: remonta o texto inteiro a cada evento (sem duplicar trechos)
    let spoken = '';
    for (let i = 0; i < ev.results.length; i++) spoken += ev.results[i][0].transcript + (ev.results[i].isFinal ? ' ' : '');
    el.value = joinSpoken(base, applyVoiceCommands(spoken.trim()), multi);
    el.dispatchEvent(new Event('input'));
  };
  r.onerror = e => {
    const msg = { 'not-allowed': 'Permita o microfone para este site (cadeado na barra de endereço) ou use Win + H.',
      'service-not-allowed': 'O ditado do navegador está bloqueado aqui. Use Win + H.',
      network: 'O ditado do navegador precisa de internet. Sem conexão, use Win + H.',
      'audio-capture': 'Nenhum microfone encontrado.', 'no-speech': 'Não ouvi nada. Clique no microfone e fale de novo.' }[e.error];
    if (msg) toast(msg, e.error !== 'no-speech');
  };
  r.onend = () => {
    btn.setAttribute('aria-pressed', 'false'); btn.textContent = btn.dataset.label;
    if (micRec === r) { micRec = null; micBtn = null; }
    el.focus();
  };
  try { r.start(); } catch (e) { toast('Não foi possível iniciar o ditado: ' + e.message, true); return; }
  micRec = r; micBtn = btn;
  btn.setAttribute('aria-pressed', 'true'); btn.textContent = multi ? '■ Parar' : '■';
};

ACTIONS['quick-capture'] = async () => {
  const v = await dialog({ title: 'Captura rápida', submit: 'Capturar', fields: [
    { name: 'text', label: 'O que está na sua cabeça?', required: true },
    { name: 'notes', label: 'Detalhes (opcional)', type: 'textarea' },
    { name: 'hub', label: 'Hub', type: 'select', options: hubOptions() },
  ] });
  if (v?.text) act(api('/api/items', { method: 'POST', body: { text: v.text, notes: v.notes || undefined, hub: v.hub || undefined, source: 'Captura rápida' } }), '✓ Na inbox');
};
ACTIONS['process'] = async d => {
  const id = d.id, action = d.action;
  const item = S.items.inbox.find(i => i.id === id);
  let body = { action };
  if (action === 'projeto') {
    const opts = projectOptions(p => !['concluido', 'abandonado'].includes(p.status));
    const v = await dialog({ title: 'Enviar para projeto', submit: 'Enviar', fields: [
      { name: 'project', label: 'Projeto', type: 'select', options: opts, value: suggestProject(item)?.id },
      { name: 'text', label: 'Como etapa/cartão/to-do', value: item?.text },
    ] });
    if (!v) return;
    body = { ...body, ...v };
  } else if (action === 'tarefa') {
    const v = await dialog({ title: 'Virar tarefa do dia', submit: 'Agendar', fields: [
      { name: 'text', label: 'Próxima ação', value: item?.text },
      { name: 'period', label: 'Período', type: 'select', options: periodOptions, value: 'tarde' },
      { name: 'date', label: 'Dia', type: 'select', options: [{ value: 'hoje', label: 'Hoje' }, { value: 'amanhã', label: 'Amanhã' }] },
      { name: 'project', label: 'Projeto (opcional)', type: 'select', options: [{ value: '', label: '—' }, ...projectOptions(p => p.status === 'ativo')], value: suggestProject(item)?.status === 'ativo' ? suggestProject(item).id : '' },
    ] });
    if (!v) return;
    body = { ...body, ...v, project: v.project || undefined };
  } else if (action === 'waiting') {
    const v = await dialog({ title: 'Aguardando terceiros', submit: 'Mover', fields: [{ name: 'who', label: 'De quem você está aguardando?', placeholder: 'ex.: orientadora, time do cliente' }] });
    if (!v) return;
    body.who = v.who || undefined;
  } else if (action === 'diario') {
    const linked = S.projects.filter(p => S.link.links.some(l => l.project_id === p.id));
    const v = await dialog({ title: 'Enviar ao Diário do Doutorado', submit: 'Enviar', text: 'O item vira um rascunho de entrada no Diário. Ele só é registrado quando você confirma lá, na próxima sincronização.',
      fields: [{ name: 'project', label: 'Projeto ligado (define o ponto da EAP)', type: 'select', options: [{ value: '', label: '— sem ligação —' }, ...linked.map(p => ({ value: p.id, label: p.name }))], value: suggestProject(item)?.id }] });
    if (!v) return;
    body.project = v.project || undefined;
  }
  act(api(`/api/items/${id}/process`, { method: 'POST', body }));
};
ACTIONS['restore'] = d => act(api(`/api/items/${d.id}/process`, { method: 'POST', body: { action: 'inbox' } }));
ACTIONS['to-trash'] = d => act(api(`/api/items/${d.id}/process`, { method: 'POST', body: { action: 'trash' } }));
ACTIONS['delete-item'] = d => { if (confirm('Apagar permanentemente?')) act(api(`/api/items/${d.id}`, { method: 'DELETE' })); };
ACTIONS['edit-item'] = async d => {
  const it = Object.values(S.items).flat().find(i => i.id === d.id);
  const v = await dialog({ title: 'Editar item', fields: [
    { name: 'text', label: 'Texto', value: it.text, required: true },
    { name: 'notes', label: 'Notas', type: 'textarea', value: it.notes },
    { name: 'url', label: 'Link', value: it.url },
    { name: 'hub', label: 'Hub', type: 'select', options: hubOptions(), value: it.hub || '' },
  ] });
  if (v) act(api(`/api/items/${d.id}`, { method: 'PATCH', body: { ...v, hub: v.hub || null } }));
};
/** Sugere projeto pelo hub do item ou por palavras em comum com o nome. */
function suggestProject(item) {
  if (!item) return null;
  const words = item.text.toLowerCase().split(/\W+/).filter(w => w.length > 3);
  const scored = S.projects.filter(p => !['concluido', 'abandonado'].includes(p.status)).map(p => ({
    p, s: words.filter(w => p.name.toLowerCase().includes(w)).length * 2 + (item.hub && p.hub === item.hub ? 1 : 0) + (p.status === 'ativo' ? 0.5 : 0),
  })).sort((a, b) => b.s - a.s);
  return scored[0]?.s > 0.5 ? scored[0].p : null;
}

function renderInbox() {
  const c = S.counts;
  $('inboxCount').textContent = c.inbox;
  $('processedToday').textContent = c.processed_today;
  $('somedayCount').textContent = c.someday;
  $('refCount').textContent = c.reference;
  const titles = { inbox: 'Itens para processar', waiting: 'Aguardando terceiros', someday: 'Algum Dia / Talvez', reference: 'Referências', trash: 'Lixo', processed: 'Processados' };
  $('inboxSectionTitle').textContent = titles[inboxFilter];
  const q = $('inboxSearch').value.trim().toLowerCase();
  const hub = $('inboxHubFilter').value;
  const items = (S.items[inboxFilter] || []).filter(i => (!q || (i.text + ' ' + (i.notes || '')).toLowerCase().includes(q)) && (!hub || i.hub === hub));
  const el = $('inboxItems');
  if (!items.length) {
    el.innerHTML = '';
    $('inboxEmpty').style.display = 'block';
    const msgs = { inbox: ['🎉', 'Inbox vazia! Tudo processado.'], waiting: ['⌛', 'Nada aguardando terceiros.'], someday: ['💭', 'Nenhum item em "Algum Dia".'], reference: ['📁', 'Nenhuma referência salva.'], trash: ['🗑', 'Lixo vazio.'], processed: ['✓', 'Nada processado ainda.'] };
    const [icon, msg] = q || hub ? ['🔍', 'Nada encontrado com esse filtro.'] : msgs[inboxFilter];
    $('inboxEmptyIcon').textContent = icon; $('inboxEmptyMsg').textContent = msg;
    return;
  }
  $('inboxEmpty').style.display = 'none';
  const dot = { waiting: 'var(--lane-paralelos)', trash: 'var(--danger)', someday: 'var(--warning)', reference: 'var(--fg-secondary)', processed: 'var(--success)' }[inboxFilter] || 'var(--accent)';
  el.innerHTML = items.map(item => {
    const actions = inboxFilter === 'inbox' ? `
        <button class="btn-projeto" data-act="process" data-id="${item.id}" data-action="projeto">→ Projeto</button>
        <button class="btn-tarefa" data-act="process" data-id="${item.id}" data-action="tarefa">→ Tarefa</button>
        <button class="btn-restore" data-act="process" data-id="${item.id}" data-action="feito" title="Resolvido em menos de 2 minutos">✓ Feito</button>
        <button class="btn-someday" data-act="process" data-id="${item.id}" data-action="waiting" title="Delegado ou dependendo de alguém">⌛ Aguardando</button>
        <button class="btn-someday" data-act="process" data-id="${item.id}" data-action="someday">⏳ Algum Dia</button>
        ${item.hub === 'doutorado' || item.source === 'Diário' ? `<button class="btn-ref" data-act="process" data-id="${item.id}" data-action="diario" title="Enviar ao Diário do Doutorado como rascunho de entrada">📓 → Diário</button>` : ''}
        <button class="btn-ref" data-act="process" data-id="${item.id}" data-action="reference">📁 Referência</button>
        <button class="btn-trash" data-act="process" data-id="${item.id}" data-action="trash">🗑 Lixo</button>`
      : `<button class="btn-restore" data-act="restore" data-id="${item.id}">↩ Inbox</button>
        ${inboxFilter === 'waiting' ? `<button class="btn-tarefa" data-act="process" data-id="${item.id}" data-action="feito" title="Já recebi / foi resolvido">✓ Resolvido</button>` : ''}
        ${inboxFilter === 'trash' ? `<button class="btn-trash" data-act="delete-item" data-id="${item.id}">✕ Apagar</button>` : `<button class="btn-trash" data-act="to-trash" data-id="${item.id}">🗑 Lixo</button>`}`;
    const when = inboxFilter === 'inbox' ? fmtDate(item.created_at) : fmtDate(item.processed_at);
    return `<div class="inbox-item">
      <div class="inbox-dot" style="background:${dot}"></div>
      <div class="inbox-content">
        <div class="inbox-source" style="color:${getSourceColor(item.source)}">${getSourceIcon(item.source)} ${esc(item.source)}
          <span style="font-size:0.68rem;color:var(--fg-secondary);margin-left:8px;">${when}</span>
          ${item.hub ? `<span class="chip" style="margin-left:6px;text-transform:none;letter-spacing:0;">${esc(item.hub)}</span>` : ''}
          ${item.meta?.prazo ? `<span class="chip" style="margin-left:6px;text-transform:none;letter-spacing:0;${item.meta.prazo < S.meta.today ? 'color:var(--danger);border-color:var(--danger);' : ''}">prazo ${esc(item.meta.prazo.split('-').reverse().join('/'))}</span>` : ''}</div>
        <div style="margin-top:2px;display:flex;gap:6px;align-items:flex-start;">
          <span style="flex:1;min-width:0;">${esc(item.text)}${item.url ? ` <a href="${esc(safeUrl(item.url))}" target="_blank" rel="noopener" style="color:var(--accent-text);font-size:0.8rem;">↗</a>` : ''}</span>
          <button class="mini-btn" data-act="edit-item" data-id="${item.id}" title="Editar">✎</button>
        </div>
        ${item.notes ? `<div class="inbox-notes">${esc(item.notes)}</div>` : ''}
        ${item.destination ? `<div style="font-size:0.72rem;color:var(--success);margin-top:4px;">✓ ${esc(item.destination)}</div>` : ''}
        <div class="inbox-actions">${actions}</div>
      </div>
    </div>`;
  }).join('');
}

// ===== LANES =====
const priorityLabel = p => ({ 1: '🔴', 2: '🟡', 3: '🟢' })[p] || '⚪';
const priorityText = p => ({ 1: 'Alta', 2: 'Média', 3: 'Baixa' })[p] || 'Sem';
const laneColor = k => `var(--lane-${k})`;
const STATUS_LABEL = { backlog: 'Backlog', ativo: 'Ativo', pausado: 'Pausado', concluido: 'Concluído', abandonado: 'Abandonado' };

ACTIONS['priority'] = d => {
  const p = S.projects.find(x => x.id === d.id);
  act(api(`/api/projects/${p.id}`, { method: 'PATCH', body: { priority: p.priority >= 3 ? 1 : (p.priority || 0) + 1 } }));
};
ACTIONS['status'] = async d => {
  const p = S.projects.find(x => x.id === d.id);
  const body = { status: d.status };
  if (d.status === 'abandonado') {
    const v = await dialog({ title: `Abandonar "${p.name}"`, submit: 'Abandonar', danger: true, text: 'Post-mortem obrigatório: o que aprendeu e por que parar?',
      fields: [{ name: 'post_mortem', label: 'Post-mortem', type: 'textarea', value: p.post_mortem }] });
    if (!v) return;
    body.post_mortem = v.post_mortem;
  }
  const res = await act(api(`/api/projects/${p.id}`, { method: 'PATCH', body }));
  if (res === null && d.status === 'ativo' && confirm('WIP cheio. Ativar mesmo assim (ignorar limite)?')) act(api(`/api/projects/${p.id}?force=1`, { method: 'PATCH', body }));
};
ACTIONS['open-project'] = d => { currentProject = d.id; showScreen('screen-projetos'); renderProjects(); };

function renderLanes() {
  const active = S.projects.filter(p => p.status === 'ativo');
  let html = `<div class="stat-box"><div class="stat-num" style="color:var(--accent);">${active.length}<span style="font-size:0.9rem;color:var(--fg-secondary);">/${S.meta.wip_global}</span></div><div class="stat-label">WIP Global</div></div>`;
  for (const [k, l] of Object.entries(S.meta.lanes)) {
    const used = active.filter(p => p.lane === k).length;
    html += `<div class="stat-box"><div class="stat-num" style="color:${laneColor(k)};">${used}<span style="font-size:0.9rem;color:var(--fg-secondary);">/${l.wip}</span></div><div class="stat-label">${esc(l.name.substring(0, 8))}</div></div>`;
  }
  html += `<div class="stat-box"><div class="stat-num" style="color:var(--fg-secondary);">${S.projects.filter(p => p.status === 'backlog').length}</div><div class="stat-label">Backlog</div></div>`;
  $('laneStats').innerHTML = html;

  const item = (p, wipFull) => {
    const isActive = p.status === 'ativo';
    const btn = isActive
      ? `<button class="lane-action-btn btn-backlog" data-act="status" data-id="${p.id}" data-status="pausado" title="Pausar">⏸</button><button class="lane-action-btn btn-backlog" data-act="status" data-id="${p.id}" data-status="backlog" title="Mover para Backlog">▼ Backlog</button>`
      : wipFull ? `<span class="lane-action-btn btn-wip-full" title="WIP cheio">🔒 WIP</span>`
      : `<button class="lane-action-btn btn-ativar" data-act="status" data-id="${p.id}" data-status="ativo">▲ ${p.status === 'pausado' ? 'Retomar' : 'Ativar'}</button>`;
    return `<div class="lane-item" style="flex-direction:column;align-items:stretch;gap:4px;${isActive ? '' : 'opacity:0.65;'}">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
        <a href="#" class="lane-item-name" data-act="open-project" data-id="${p.id}" style="color:inherit;text-decoration:none;">${esc(p.name)}${p.status === 'pausado' ? ` <span class="badge badge-paused" style="font-size:0.6rem;">⏸ ${p.paused_days ?? 0}d</span>` : ''}</a>
        <span style="display:flex;align-items:center;gap:4px;flex-shrink:0;">
          <button data-act="priority" data-id="${p.id}" style="background:none;border:none;cursor:pointer;font-size:0.8rem;padding:0;" title="Prioridade: ${priorityText(p.priority)} — clique para alterar">${priorityLabel(p.priority)}</button>
          <span class="lane-item-mode">${esc(p.mode)}${p.github ? ' · GH' : ''}${p.lovable_url ? ' · <span style="color:#ff6b6b;">♥</span>' : ''}</span>
          ${btn}
        </span>
      </div>
      ${p.next_step ? `<div style="font-size:0.72rem;color:${isActive ? 'var(--accent)' : 'var(--fg-secondary)'};padding:2px 0 0 12px;border-left:2px solid ${isActive ? 'var(--accent)' : 'var(--border)'};margin-left:2px;">▸ ${esc(p.next_step)}</div>` : ''}
      ${isActive && p.progress != null ? `<div style="display:flex;align-items:center;gap:6px;margin-top:2px;"><div style="flex:1;height:4px;background:var(--surface-alt);border-radius:2px;overflow:hidden;"><div style="height:100%;width:${p.progress}%;background:${laneColor(p.lane)};border-radius:2px;"></div></div><span style="font-size:0.65rem;color:var(--fg-secondary);">${p.progress}%</span></div>` : ''}
    </div>`;
  };
  $('lanesGrid').innerHTML = Object.entries(S.meta.lanes).map(([k, l]) => {
    const act = active.filter(p => p.lane === k);
    const paused = S.projects.filter(p => p.lane === k && p.status === 'pausado');
    const backlog = S.projects.filter(p => p.lane === k && p.status === 'backlog');
    const used = act.length, pct = Math.min(100, (used / l.wip) * 100);
    const bar = pct >= 100 ? 'var(--danger)' : pct >= 66 ? 'var(--warning)' : laneColor(k);
    const wipFull = used >= l.wip || active.length >= S.meta.wip_global;
    const section = (label, list) => list.length ? `<div style="font-size:0.72rem;color:var(--fg-secondary);padding:6px 0 2px;text-transform:uppercase;letter-spacing:0.05em;">${label} (${list.length})</div>` + list.map(p => item(p, wipFull)).join('') : '';
    return `<div class="lane-card">
      <div class="lane-header" style="border-bottom:3px solid ${laneColor(k)};"><h3>${esc(l.name)}</h3><span class="lane-wip" style="color:${bar}">${used}/${l.wip}</span></div>
      <div class="wip-bar"><div class="wip-fill" style="width:${pct}%;background:${bar};"></div></div>
      <div class="lane-items" style="margin-top:8px;">${act.map(p => item(p, wipFull)).join('')}${section('Pausados', paused)}${section('Backlog', backlog)}</div>
    </div>`;
  }).join('');
}

// ===== PROJETOS =====
let currentProject = lsGet('gtd-project');
ACTIONS['select-project'] = d => { currentProject = d.id; lsSet('gtd-project', d.id); renderProjects(); };
ACTIONS['new-project'] = async () => {
  const v = await dialog({ title: 'Novo projeto', submit: 'Criar', fields: [
    { name: 'name', label: 'Nome', required: true },
    { name: 'lane', label: 'Lane', type: 'select', options: laneOptions(), value: 'sandbox' },
    { name: 'mode', label: 'Modo', type: 'select', options: [{ value: 'projeto', label: '📋 Projeto (>5 passos)' }, { value: 'kanban', label: '🔁 Kanban (contínuo)' }, { value: 'todo', label: '✅ To-do (<5 itens)' }] },
    { name: 'hub', label: 'Hub', type: 'select', options: hubOptions() },
    { name: 'next_step', label: 'Próximo passo' },
    { name: 'items', label: 'Etapas / to-dos (uma por linha)', type: 'textarea' },
    { name: 'github', label: 'GitHub (owner/repo)', placeholder: 'usuario/repositorio' },
    { name: 'lovable_url', label: 'URL Lovable', placeholder: 'https://….lovable.app' },
  ] });
  if (!v) return;
  const lines = (v.items || '').split('\n').map(s => s.trim()).filter(Boolean);
  const body = { name: v.name, lane: v.lane, mode: v.mode, hub: v.hub || null, next_step: v.next_step || null, github: v.github || null, lovable_url: v.lovable_url || null,
    ...(v.mode === 'projeto' ? { steps: lines } : v.mode === 'todo' ? { todos: lines } : { kanban: { todo: lines, doing: [], done: [] } }) };
  const p = await act(api('/api/projects', { method: 'POST', body }), 'Projeto criado no backlog');
  if (p) { currentProject = p.id; showScreen('screen-projetos'); renderProjects(); }
};
const patchProject = (id, body) => act(api(`/api/projects/${id}`, { method: 'PATCH', body }));
ACTIONS['set-step'] = d => patchProject(d.id, { current_step: +d.step, progress: Math.round((+d.step / +d.total) * 100) });
ACTIONS['advance-step'] = d => patchProject(d.id, { advance_step: true });
ACTIONS['kanban-move'] = d => patchProject(d.id, { kanban_move: { card: +d.idx, from: d.from, to: d.to } });
ACTIONS['remove-item'] = d => { if (confirm('Remover?')) patchProject(d.id, { remove_item: +d.idx, column: d.col }); };
ACTIONS['todo-toggle'] = d => patchProject(d.id, { todo_toggle: +d.idx });
ACTIONS['delete-project'] = d => {
  const p = S.projects.find(x => x.id === d.id);
  if (confirm(`Excluir o projeto "${p.name}" definitivamente? (Prefira "Abandonado" + post-mortem.)`)) { currentProject = null; act(api(`/api/projects/${d.id}`, { method: 'DELETE' })); }
};
ACTIONS['edit-project'] = async d => {
  const p = S.projects.find(x => x.id === d.id);
  const v = await dialog({ title: `Editar "${p.name}"`, fields: [
    { name: 'name', label: 'Nome', value: p.name, required: true },
    { name: 'lane', label: 'Lane', type: 'select', options: laneOptions(), value: p.lane },
    { name: 'hub', label: 'Hub', type: 'select', options: hubOptions(), value: p.hub || '' },
    { name: 'priority', label: 'Prioridade', type: 'select', options: [{ value: '', label: 'Sem' }, { value: 1, label: '🔴 Alta' }, { value: 2, label: '🟡 Média' }, { value: 3, label: '🟢 Baixa' }], value: p.priority || '' },
    { name: 'progress', label: 'Progresso (%)', type: 'number', value: p.progress ?? '' },
    { name: 'github', label: 'GitHub (owner/repo)', value: p.github },
    { name: 'lovable_url', label: 'URL Lovable', value: p.lovable_url },
    { name: 'notes', label: 'Notas', type: 'textarea', value: p.notes },
    ...(p.status === 'abandonado' || p.post_mortem ? [{ name: 'post_mortem', label: 'Post-mortem', type: 'textarea', value: p.post_mortem }] : []),
  ] });
  if (!v) return;
  patchProject(p.id, { ...v, hub: v.hub || null, priority: v.priority ? +v.priority : null, progress: v.progress === '' ? null : +v.progress, github: v.github || null, lovable_url: v.lovable_url || null });
};

const DD_STATUS = { pendente: 'Pendente', em_andamento: 'Em andamento', concluido: 'Concluído', bloqueado: 'Bloqueado' };
/** Painel somente leitura com o que o Diário do Doutorado informou sobre as referências ligadas. */
function diaryPanel(p) {
  const links = S.link.links.filter(l => l.project_id === p.id);
  const blockers = S.link.blockers.filter(b => b.project?.id === p.id);
  if (!links.length && p.hub !== 'doutorado') return '';
  const row = l => {
    const d = l.mirror?.dados;
    return `<div class="step-row" style="align-items:flex-start;">
      <div style="flex:1;min-width:0;">
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;"><code class="chip" style="text-transform:none;letter-spacing:0;">${esc(l.ref)}</code>
          ${d ? `<b style="font-size:0.88rem;">${esc(d.titulo)}</b>` : '<span style="font-size:0.82rem;color:var(--fg-secondary);">aguardando a primeira sincronização</span>'}</div>
        ${d ? `<div style="font-size:0.78rem;color:var(--fg-secondary);margin-top:3px;">${[d.status ? DD_STATUS[d.status] : null, d.progresso != null ? d.progresso + '%' : null, d.gate_em_foco ? 'gate em foco ' + esc(d.gate_em_foco) : null, d.decisao ? 'decisão ' + esc(d.decisao) : null, d.proximo_marco ? 'próximo marco ' + esc(d.proximo_marco) : null].filter(Boolean).join(' · ')}</div>
          ${d.progresso != null ? `<div class="wip-bar" style="max-width:260px;"><div class="wip-fill" style="width:${d.progresso}%;background:var(--lane-paralelos);"></div></div>` : ''}
          ${d.pendencias ? `<div style="font-size:0.78rem;margin-top:3px;">Pendências: ${esc(d.pendencias)}</div>` : ''}
          <div style="font-size:0.7rem;color:var(--fg-secondary);margin-top:3px;">atualizado no Diário em ${fmtDateTime(l.mirror.alterado_em)}</div>` : ''}
      </div>
      <button class="mini-btn danger" data-act="link-remove" data-id="${l.id}" title="Desfazer ligação">✕</button>
    </div>`;
  };
  return `<div class="card" style="margin-bottom:12px;">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;"><h3>📓 No Diário do Doutorado</h3><button class="mini-btn" data-act="link-add" data-id="${p.id}">＋ Ligar referência</button></div>
    <p style="font-size:0.76rem;color:var(--fg-secondary);margin-bottom:6px;">Somente leitura: quem atualiza é o Diário, a cada sincronização.</p>
    ${blockers.map(b => `<div class="alert-row alert-danger"><span>🔴</span><span>Bloqueio: ${esc(b.texto)}</span></div>`).join('')}
    ${links.map(row).join('') || '<p style="font-size:0.84rem;">Nenhuma referência ligada. Ligue um nó da EAP (ex.: <code>dd:eap:bib:4</code>) ou um gate (ex.: <code>dd:gate:G3</code>).</p>'}
  </div>`;
}
ACTIONS['link-add'] = async d => {
  const p = S.projects.find(x => x.id === d.id);
  const v = await dialog({ title: `Ligar "${p.name}" ao Diário`, submit: 'Ligar', text: 'Use o código da EAP com _ no lugar dos pontos (4.2.3 → 4_2_3). Árvores: bib (pesquisa bibliográfica) e dsr (Design Science).',
    fields: [{ name: 'ref', label: 'Referência', required: true, placeholder: 'dd:eap:bib:4 ou dd:gate:G3' }] });
  if (v) act(api('/api/links', { method: 'POST', body: { project: p.id, ref: v.ref.trim() } }), 'Ligação criada');
};
ACTIONS['link-remove'] = d => { if (confirm('Desfazer esta ligação? Os dados no Diário não mudam.')) act(api(`/api/links/${d.id}`, { method: 'DELETE' })); };

function renderProjects() {
  if (!S.projects.length) { $('projTabs').innerHTML = ''; $('projDetail').innerHTML = '<div class="card">Nenhum projeto.</div>'; return; }
  if (!S.projects.some(p => p.id === currentProject)) currentProject = S.projects[0].id;
  $('projTabs').innerHTML = S.projects.map(p => `<button class="proj-tab ${p.id === currentProject ? 'active' : ''}" data-act="select-project" data-id="${p.id}" title="${esc(p.name)}" style="${p.status === 'ativo' ? '' : 'opacity:0.6;'}">${p.status === 'ativo' ? '' : p.status === 'pausado' ? '⏸ ' : p.status === 'concluido' ? '✓ ' : p.status === 'abandonado' ? '✗ ' : ''}${esc(p.name.length > 18 ? p.name.substring(0, 16) + '…' : p.name)}</button>`).join('');
  const p = S.projects.find(x => x.id === currentProject);
  const statusClass = { ativo: 'badge-active', pausado: 'badge-paused', concluido: 'badge-done', abandonado: 'badge-dropped' }[p.status] || 'badge-backlog';

  let modeHTML = '';
  if (p.mode === 'projeto') {
    const steps = p.steps || [];
    modeHTML = `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><h3>Etapas do Projeto</h3>
      ${p.current_step < steps.length ? `<button class="btn btn-sm" data-act="advance-step" data-id="${p.id}">✓ Concluir etapa atual</button>` : '<span class="badge badge-done">Todas concluídas</span>'}</div>
      ${steps.map((s, i) => `<div class="step-row">
        <button class="step-num" data-act="set-step" data-id="${p.id}" data-step="${i < p.current_step ? i : i + 1}" data-total="${steps.length}" title="${i < p.current_step ? 'Reabrir a partir desta' : 'Concluir até esta'}" style="${i < p.current_step ? 'background:var(--success);color:#fff;' : i === p.current_step ? 'background:var(--accent);color:#fff;' : 'background:var(--surface-alt);color:var(--fg-secondary);'}">${i + 1}</button>
        <span style="flex:1;font-size:0.88rem;${i < p.current_step ? 'color:var(--fg-secondary);text-decoration:line-through;' : ''}">${esc(s)}</span>
        <button class="mini-btn danger" data-act="remove-item" data-id="${p.id}" data-idx="${i}" title="Remover">✕</button>
      </div>`).join('') || '<p style="font-size:0.85rem;color:var(--fg-secondary);">Sem etapas ainda.</p>'}
    </div>`;
  } else if (p.mode === 'kanban') {
    const k = p.kanban || { todo: [], doing: [], done: [] };
    const cols = [['todo', 'A fazer'], ['doing', 'Fazendo'], ['done', 'Feito']];
    modeHTML = `<div class="card"><h3 style="margin-bottom:8px;">Kanban (WIP 3/coluna)</h3><div class="kanban">
      ${cols.map(([c, label], ci) => `<div class="kanban-col"><div class="kanban-col-title"><span>${label}</span><span style="${c === 'doing' && k[c].length > 3 ? 'color:var(--danger)' : ''}">${k[c].length}</span></div>
        ${k[c].map((t, i) => `<div class="kanban-card"><span>${esc(t)}</span><span class="kc-actions">
          ${ci > 0 ? `<button class="mini-btn" data-act="kanban-move" data-id="${p.id}" data-idx="${i}" data-from="${c}" data-to="${cols[ci - 1][0]}" title="Voltar">←</button>` : ''}
          ${ci < 2 ? `<button class="mini-btn" data-act="kanban-move" data-id="${p.id}" data-idx="${i}" data-from="${c}" data-to="${cols[ci + 1][0]}" title="Avançar">→</button>` : ''}
          <button class="mini-btn danger" data-act="remove-item" data-id="${p.id}" data-idx="${i}" data-col="${c}" title="Remover">✕</button></span></div>`).join('')}
      </div>`).join('')}</div></div>`;
  } else {
    modeHTML = `<div class="card"><h3 style="margin-bottom:8px;">To-do list</h3>
      ${(p.todos || []).map((t, i) => `<div class="step-row">
        <div class="task-item ${t.done ? 'done' : ''}" style="border:none;padding:0;margin:0;background:none;flex:1;" data-act="todo-toggle" data-id="${p.id}" data-idx="${i}"><div class="task-check"></div><span class="task-text">${esc(t.text)}</span></div>
        <button class="mini-btn danger" data-act="remove-item" data-id="${p.id}" data-idx="${i}">✕</button></div>`).join('') || '<p style="font-size:0.85rem;color:var(--fg-secondary);">Lista vazia.</p>'}
    </div>`;
  }
  const states = ['backlog', 'ativo', 'pausado', 'concluido', 'abandonado'];
  const tasks = [...S.today.periods.flatMap(x => x.tasks), ...S.tomorrow].filter(t => t.project_id === p.id);
  $('projDetail').innerHTML = `
    <div class="project-meta">
      <div class="meta-item"><span class="meta-label">Lane</span><span class="badge badge-${p.lane}">${esc(S.meta.lanes[p.lane].name)}</span></div>
      <div class="meta-item"><span class="meta-label">Modo</span><span class="meta-value">${esc(p.mode.charAt(0).toUpperCase() + p.mode.slice(1))}</span></div>
      <div class="meta-item"><span class="meta-label">Status</span><span class="badge ${statusClass}">${STATUS_LABEL[p.status]}${p.paused_days != null ? ` · ${p.paused_days}d` : ''}</span></div>
      <div class="meta-item"><span class="meta-label">Prioridade</span><span class="meta-value">${priorityLabel(p.priority)} ${priorityText(p.priority)}</span></div>
      ${p.progress != null ? `<div class="meta-item"><span class="meta-label">Progresso</span><span class="meta-value">${p.progress}%</span></div>` : ''}
      <div class="meta-item"><span class="meta-label">Hub</span><span class="meta-value">${esc(p.hub || '—')}</span></div>
    </div>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px;align-items:center;">
      ${p.github ? `<a href="https://github.com/${esc(p.github)}" target="_blank" rel="noopener" style="font-size:0.82rem;color:var(--accent-text);text-decoration:none;">⟨/⟩ ${esc(p.github)}</a>` : ''}
      ${p.lovable_url ? `<a href="${esc(safeUrl(p.lovable_url))}" target="_blank" rel="noopener" style="font-size:0.82rem;color:#ff6b6b;text-decoration:none;">♥ ${esc(host(p.lovable_url))}</a>` : ''}
      <span style="flex:1"></span>
      <button class="mini-btn" data-act="edit-project" data-id="${p.id}">✎ Editar</button>
      <button class="mini-btn danger" data-act="delete-project" data-id="${p.id}">Excluir</button>
    </div>
    <div class="card" style="margin-bottom:12px;">
      <h3 style="margin-bottom:6px;">Próximo passo</h3>
      <input class="inline-edit" id="nextStepInput" value="${esc(p.next_step || '')}" placeholder="Qual é a próxima ação concreta?">
    </div>
    <div class="card" style="margin-bottom:12px;">
      <h3 style="margin-bottom:8px;">Ciclo de Vida</h3>
      <div class="lifecycle-flow">${states.map((s, i) => `${i > 0 ? '<span class="lifecycle-arrow">→</span>' : ''}<button class="lifecycle-node ${s === p.status ? 'current' : ''}" data-act="status" data-id="${p.id}" data-status="${s}" ${s === p.status ? 'disabled' : ''}>${STATUS_LABEL[s]}</button>`).join('')}</div>
      ${p.post_mortem ? `<div style="font-size:0.8rem;margin-top:8px;"><b>Post-mortem:</b> ${esc(p.post_mortem)}</div>` : ''}
    </div>
    ${diaryPanel(p)}
    ${p.progress != null ? `<div class="card" style="margin-bottom:12px;"><h3 style="margin-bottom:8px;">Progresso</h3><div class="wip-bar" style="height:10px;"><div class="wip-fill" style="width:${p.progress}%;background:var(--accent);"></div></div><div style="text-align:right;font-size:0.8rem;color:var(--fg-secondary);margin-top:4px;">${p.progress}%</div></div>` : ''}
    ${modeHTML}
    <form class="inbox-input-wrap" id="projAddForm" style="margin-top:12px;">
      <input id="projAddInput" placeholder="${p.mode === 'projeto' ? 'Nova etapa…' : p.mode === 'kanban' ? 'Novo cartão (A fazer)…' : 'Novo to-do…'}" autocomplete="off">
      <button type="submit" class="btn btn-sm">+</button>
    </form>
    ${tasks.length ? `<div class="card" style="margin-top:12px;"><h3 style="margin-bottom:6px;">Tarefas agendadas</h3>${tasks.map(t => `<div style="font-size:0.84rem;padding:3px 0;">${t.done ? '✓' : '○'} ${esc(t.text)} <span class="chip">${t.date === S.meta.today ? 'hoje' : 'amanhã'} · ${esc(t.period)}</span></div>`).join('')}</div>` : ''}
    ${p.notes ? `<div class="card" style="margin-top:12px;"><h3 style="margin-bottom:6px;">Notas</h3><div style="font-size:0.85rem;white-space:pre-wrap;">${esc(p.notes)}</div></div>` : ''}
  `;
  $('nextStepInput').addEventListener('change', e => patchProject(p.id, { next_step: e.target.value.trim() || null }));
  $('projAddForm').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('projAddInput').value.trim();
    if (v) patchProject(p.id, { add_item: v });
  });
}

// ===== DIA =====
ACTIONS['task-toggle'] = (d, el, e) => {
  if (e.target.closest('.task-tools')) return;
  const t = S.today.periods.flatMap(x => x.tasks).find(x => x.id === d.id);
  act(api(`/api/tasks/${d.id}`, { method: 'PATCH', body: { done: !t.done } }));
};
ACTIONS['task-tomorrow'] = d => act(api(`/api/tasks/${d.id}`, { method: 'PATCH', body: { date: 'amanhã' } }), 'Movida para amanhã');
ACTIONS['task-today'] = d => act(api(`/api/tasks/${d.id}`, { method: 'PATCH', body: { date: 'hoje' } }));
ACTIONS['task-delete'] = d => { if (confirm('Descartar esta tarefa?')) act(api(`/api/tasks/${d.id}`, { method: 'DELETE' })); };
ACTIONS['task-edit'] = async d => {
  const t = [...S.today.periods.flatMap(x => x.tasks), ...S.tomorrow].find(x => x.id === d.id);
  const v = await dialog({ title: 'Editar tarefa', fields: [
    { name: 'text', label: 'Texto', value: t.text, required: true },
    { name: 'period', label: 'Período', type: 'select', options: periodOptions, value: t.period },
    { name: 'lane', label: 'Lane', type: 'select', options: [{ value: '', label: '—' }, ...laneOptions()], value: t.lane || '' },
  ] });
  if (v) act(api(`/api/tasks/${d.id}`, { method: 'PATCH', body: { ...v, lane: v.lane || null } }));
};
$('taskForm').addEventListener('submit', async e => {
  e.preventDefault();
  const text = $('taskText').value.trim();
  if (!text) return;
  $('taskText').value = '';
  await act(api('/api/tasks', { method: 'POST', body: { text, period: $('taskPeriod').value, date: $('taskDay').value } }));
});

function renderDay() {
  const d = S.today;
  $('dateLabel').textContent = new Date(d.date + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('tasksDone').textContent = d.done;
  $('tasksTotal').textContent = d.total;
  $('tasksTotal').style.color = d.total > S.meta.daily_max ? 'var(--danger)' : '';
  $('tasksInbox').textContent = S.counts.inbox;
  const h = new Date().getHours();
  $('tasksFocus').textContent = h < 12 ? '🌅' : h < 18 ? '☀️' : '🌙';
  const alerts = S.alerts;
  $('alertsCard').style.display = alerts.length ? 'block' : 'none';
  $('alertsList').innerHTML = alerts.map(a => `<div class="alert-row alert-${a.level}"><span>${a.level === 'danger' ? '🔴' : a.level === 'warning' ? '🟡' : 'ℹ️'}</span><span>${esc(a.text)}</span></div>`).join('');

  const taskHTML = (t, tomorrow = false) => {
    const carry = t.carry >= 3 ? `<div class="carry-alert">⚠ ${t.carry} dias — quebrar, delegar ou descartar</div>` : t.carry > 0 ? `<div style="font-size:0.72rem;color:var(--warning);margin-top:2px;">↻ carry-over dia ${t.carry}</div>` : '';
    return `<div class="task-item ${t.done ? 'done' : ''}" ${tomorrow ? '' : `data-act="task-toggle" data-id="${t.id}"`}>
      ${tomorrow ? '' : '<div class="task-check"></div>'}
      <div style="flex:1;min-width:0;"><div class="task-text">${esc(t.text)}</div>
        ${t.project_name ? `<div style="font-size:0.7rem;color:var(--fg-secondary);">📁 ${esc(t.project_name)}</div>` : ''}${carry}</div>
      ${t.lane ? `<span class="badge badge-${t.lane} task-lane" style="font-size:0.65rem;">${esc(t.lane.substring(0, 4))}</span>` : ''}
      <span class="task-tools">
        ${tomorrow ? `<button class="mini-btn" data-act="task-today" data-id="${t.id}" title="Trazer para hoje">↑ hoje</button>` : t.done ? '' : `<button class="mini-btn" data-act="task-tomorrow" data-id="${t.id}" title="Adiar para amanhã">→</button>`}
        <button class="mini-btn" data-act="task-edit" data-id="${t.id}" title="Editar">✎</button>
        <button class="mini-btn danger" data-act="task-delete" data-id="${t.id}" title="Descartar">✕</button>
      </span>
    </div>`;
  };
  $('dailyTasks').innerHTML = d.periods.map(per => `<div class="period-section">
      <div class="period-label">${per.emoji} ${esc(per.label)} <span style="color:var(--fg-secondary);font-weight:400;text-transform:none;letter-spacing:0;">· ${esc(per.period)}</span></div>
      ${per.tasks.map(t => taskHTML(t)).join('') || '<div style="font-size:0.8rem;color:var(--fg-secondary);padding:4px 0 8px;">—</div>'}
    </div>`).join('');
  $('tomorrowList').innerHTML = S.tomorrow.length ? S.tomorrow.map(t => taskHTML(t, true)).join('') : '<div style="font-size:0.82rem;color:var(--fg-secondary);">Nada planejado ainda.</div>';
}

// ===== REVISÕES =====
const reviewChecks = {};
ACTIONS['review-done'] = async d => {
  const v = await dialog({ title: `Concluir revisão ${d.freq}`, submit: 'Registrar', fields: [{ name: 'notes', label: 'Decisões / resumo (opcional)', type: 'textarea' }] });
  if (!v) return;
  delete reviewChecks[d.freq];
  act(api(`/api/reviews/${encodeURIComponent(d.freq)}`, { method: 'POST', body: { notes: v.notes || undefined } }), `Revisão ${d.freq} registrada`);
};
function renderCadences() {
  $('cadences').innerHTML = S.reviews.map(c => {
    const checks = reviewChecks[c.freq] || (reviewChecks[c.freq] = {});
    return `<div class="cadence-card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <div class="cadence-freq">${esc(c.freq)}</div>
        <span class="badge ${c.overdue ? 'badge-overdue' : 'badge-ok'}">${c.last_done ? `há ${c.days_since}d` : 'nunca'}${c.overdue ? ' · pendente' : ' · em dia'}</span>
      </div>
      <div class="cadence-title">${esc(c.title)}</div>
      <div class="cadence-duration">${esc(c.duration)}${c.last_done ? ` · última: ${fmtDateTime(c.last_done)}` : ''}</div>
      ${c.items.map((it, i) => `<label class="check-row"><input type="checkbox" data-freq="${esc(c.freq)}" data-i="${i}" ${checks[i] ? 'checked' : ''}><span>${esc(it)}</span></label>`).join('')}
      <button class="btn btn-sm" style="margin-top:8px;" data-act="review-done" data-freq="${esc(c.freq)}">✓ Concluir revisão</button>
    </div>`;
  }).join('');
}
$('cadences').addEventListener('change', e => {
  if (e.target.type === 'checkbox') (reviewChecks[e.target.dataset.freq] ||= {})[e.target.dataset.i] = e.target.checked;
});
function renderActivity() {
  $('activityLog').innerHTML = S.events.map(e => `<div class="event-row">${fmtDateTime(e.ts)} · <b>${esc(e.summary || e.type)}</b></div>`).join('') || '<div class="event-row">Sem atividade.</div>';
}

// ===== backup =====
ACTIONS['export'] = async () => {
  try {
    const data = await api('/api/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `gtd-backup-${S?.meta.today || 'dados'}.json` });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Backup baixado');
  } catch (e) { toast(e.message, true); }
};
$('importFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const legacy = data?._meta?.app === 'GTD Framework';
    const mode = !legacy && confirm('Substituir TODOS os dados atuais pelo backup?\nOK = substituir · Cancelar = mesclar') ? 'replace' : 'merge';
    const r = await act(api('/api/import?mode=' + mode, { method: 'POST', body: data }));
    if (r) toast(`Importado: ${r.imported} registros (${r.mode})`);
  } catch (err) { toast('Arquivo inválido: ' + err.message, true); }
});

// ===== INTEGRAÇÕES =====
ACTIONS['copy'] = d => copy(integ[d.key]);
ACTIONS['webhook-add'] = async () => {
  const v = await dialog({ title: 'Webhook de saída', text: 'O GTD fará POST com {event, ts, entity_id, summary, data} para esta URL a cada mudança (n8n, Make, Supabase Edge Function do Lovable…).', submit: 'Adicionar', fields: [
    { name: 'url', label: 'URL', type: 'url', required: true, placeholder: 'https://…' },
    { name: 'events', label: 'Filtrar eventos (prefixos separados por vírgula, vazio = todos)', placeholder: 'item.captured, project., task.updated' },
    { name: 'secret', label: 'Segredo (enviado no header X-GTD-Secret)' },
  ] });
  if (!v) return;
  const list = [...(S.state.webhooks || []), { url: v.url, events: v.events ? v.events.split(',').map(s => s.trim()).filter(Boolean) : [], secret: v.secret || undefined, enabled: true }];
  await saveState('webhooks', list); refresh();
};
ACTIONS['webhook-remove'] = async d => {
  const list = [...(S.state.webhooks || [])]; list.splice(+d.i, 1);
  await saveState('webhooks', list); refresh();
};
let integ = {};
function renderIntegrations() {
  const origin = API || location.origin;
  const T = TOKEN;
  const mask = s => s.split(T).join('•••••');
  const bookmarklet = `javascript:(()=>{window.open('${origin}/capture?token=${encodeURIComponent(T)}&source=Web&text='+encodeURIComponent(document.title)+'&url='+encodeURIComponent(location.href),'gtd','width=420,height=200')})()`;
  const root = S.meta.root.replace(/\\/g, '/');
  integ = {
    token: T,
    claudeCode: `claude mcp add --transport http gtd ${origin}/mcp --header "Authorization: Bearer ${T}"`,
    claudeDesktop: JSON.stringify({ mcpServers: { gtd: { command: 'node', args: [`${root}/mcp/stdio-bridge.mjs`], env: { GTD_URL: origin } } } }, null, 2),
    connector: `${origin}/mcp?token=${T}`,
    curl: `curl -X POST ${origin}/api/items -H "Authorization: Bearer ${T}" -H "Content-Type: application/json" -d '{"text":"Minha ideia","source":"Lovable","hub":"side-projects"}'`,
    github: `${origin}/api/ingest/github?token=${T}`,
    email: `${origin}/api/ingest/email?token=${T}`,
    keep: `${origin}/api/ingest/keep?token=${T}`,
    whatsapp: `${origin}/api/ingest/whatsapp?token=${T}`,
    context: `${origin}/api/context?hub=doutorado&token=${T}`,
    openapi: `${origin}/api/openapi.json`,
    linkSync: `${origin}/api/link/sync`,
    bookmarklet,
  };
  const block = (title, key, desc, raw = false) => `<div class="integ-row"><h4>${title}</h4><button class="mini-btn" data-act="copy" data-key="${key}">Copiar</button></div>
    ${desc ? `<p style="font-size:0.78rem;color:var(--fg-secondary);">${desc}</p>` : ''}<div class="code-box">${esc(raw ? integ[key] : mask(integ[key]))}</div>`;
  $('integrations').innerHTML = `
    <div class="card"><h3>🔑 Acesso</h3>
      <p style="font-size:0.8rem;color:var(--fg-secondary);margin-top:4px;">Servidor: <b>${esc(origin)}</b> · v${esc(S.meta.version)}. Todas as chamadas usam o token (header <code>Authorization: Bearer</code> ou <code>?token=</code> em webhooks).</p>
      <div style="display:flex;gap:6px;margin-top:8px;"><button class="mini-btn" data-act="copy" data-key="token">Copiar token</button><button class="mini-btn" data-act="change-password">Trocar senha</button><button class="mini-btn" data-act="logout">Sair</button></div>
    </div>
    <div class="card"><h3>◈ Claude</h3>
      ${block('Claude Code (terminal)', 'claudeCode', 'Rode uma vez; o GTD fica disponível em qualquer projeto/sessão do Claude Code.')}
      ${block('Claude Desktop (claude_desktop_config.json)', 'claudeDesktop', 'Ponte stdio: sobe o servidor sozinha se ele não estiver rodando. O token é lido de data/config.json.', true)}
      ${block('Conector personalizado no claude.ai', 'connector', 'Exige o servidor publicado com HTTPS (veja README → Publicar). Em Configurações → Conectores → Adicionar conector personalizado.')}
      <p style="font-size:0.78rem;color:var(--fg-secondary);margin-top:6px;">Ferramentas: gtd_context, gtd_capture, gtd_inbox, gtd_process, gtd_projects, gtd_project_update, gtd_project_create, gtd_today, gtd_task_add, gtd_task_update, gtd_review, gtd_activity · Prompts: abertura_diaria, fechamento_diario, processar_inbox, revisao_semanal.</p>
    </div>
    <div class="card"><h3>📥 Fontes de captura</h3>
      <div class="integ-row"><h4>Bookmarklet (qualquer página web)</h4><a class="mini-btn" href="${esc(bookmarklet)}" title="Arraste para a barra de favoritos" onclick="event.preventDefault()">📌 GTD capturar</a></div>
      <p style="font-size:0.78rem;color:var(--fg-secondary);">Arraste o botão para a barra de favoritos. Captura título + URL da página atual.</p>
      ${block('GitHub (webhook do repositório)', 'github', 'Settings → Webhooks → Payload URL, content type application/json. Issues, PRs, reviews, pushes, releases e falhas de CI viram itens — e herdam o hub do projeto com o mesmo repositório.')}
      ${block('Gmail (Apps Script)', 'email', 'Use integrations/gmail-apps-script.gs: envia e-mails com o marcador "GTD" a cada 15 min.')}
      ${block('Google Keep / texto livre', 'keep', 'POST text/plain: uma linha = um item (listas markdown e checkboxes aceitos). Cole notas do Keep via atalho/n8n.')}
      ${block('WhatsApp / n8n / Zapier / Make', 'whatsapp', 'POST JSON {text, notes?, url?, hub?} — ou uma lista. Troque /whatsapp por /n8n, /lovable, /drive, /web para a origem certa.')}
    </div>
    <div class="card"><h3>♥ Lovable e outros apps</h3>
      ${block('Capturar de qualquer app (REST)', 'curl', 'Mesma chamada via fetch() no Lovable. Exemplo pronto em integrations/lovable.md.')}
      ${block('Contexto por hub (markdown)', 'context', 'Leia isto no início de uma sessão em outro projeto/app para saber o que está em andamento.')}
      ${block('OpenAPI 3.1', 'openapi', 'Importe em GPT Actions, Postman, n8n ou peça ao Lovable para gerar o cliente.', true)}
    </div>
    <div class="card"><h3>📓 Ligação com o Diário do Doutorado</h3>
      ${(() => { const st = S.link.status.diario; return `<p style="font-size:0.8rem;color:var(--fg-secondary);margin-top:4px;">Contrato <code>gtd-link/1</code> (docs/contrato-ligacao.md). Os dois sistemas são independentes: o Diário envia ações, status de EAP/gates e bloqueios; o GTD devolve conclusões e capturas.</p>
      <div class="stats-row" style="margin:10px 0;"><div class="stat-box"><div class="stat-num">${st.ligacoes}</div><div class="stat-label">Ligações</div></div><div class="stat-box"><div class="stat-num">${st.pendentes}</div><div class="stat-label">Pendentes p/ Diário</div></div><div class="stat-box"><div class="stat-num" style="${st.bloqueios ? 'color:var(--danger)' : ''}">${st.bloqueios}</div><div class="stat-label">Bloqueios</div></div><div class="stat-box"><div class="stat-num" style="font-size:0.95rem;">${st.ultima_sync ? fmtDateTime(st.ultima_sync) : '—'}</div><div class="stat-label">Última sync</div></div></div>`; })()}
      <div style="font-weight:600;font-size:0.85rem;margin-bottom:4px;">Log da ligação</div>
      ${S.link.log.map(l => `<div class="event-row">${fmtDateTime(l.ts)} · ${l.direcao === 'entrada' ? '⬇' : '⬆'} <b>${esc(l.tipo || '—')}</b> ${esc(l.chave || '')} · <span style="color:${l.resultado === 'recusado' ? 'var(--danger)' : 'inherit'}">${esc(l.resultado)}</span>${l.motivo ? ` — ${esc(l.motivo)}` : ''}</div>`).join('') || '<div class="event-row">Nenhuma sincronização ainda.</div>'}
      ${block('Sincronizar (rota usada pelo Diário)', 'linkSync', 'POST com {sistema:"diario", mensagens:[…], confirmados:[…]}. No Claude, a ferramenta é gtd_link_sync.', true)}
    </div>
    <div class="card"><div class="integ-row" style="margin-top:0;"><h3>📤 Webhooks de saída</h3><button class="mini-btn" data-act="webhook-add">＋ Adicionar</button></div>
      <p style="font-size:0.78rem;color:var(--fg-secondary);">Notifica outros sistemas a cada mudança no GTD.</p>
      ${(S.state.webhooks || []).map((w, i) => `<div class="integ-row"><span style="font-size:0.8rem;word-break:break-all;">${esc(w.url)} ${w.events?.length ? `<span class="chip">${esc(w.events.join(', '))}</span>` : '<span class="chip">todos</span>'}</span><button class="mini-btn danger" data-act="webhook-remove" data-i="${i}">✕</button></div>`).join('') || '<p style="font-size:0.8rem;margin-top:6px;">Nenhum webhook.</p>'}
    </div>`;
}
function renderHubs() {
  $('hubsList').innerHTML = Object.entries(S.meta.hubs).map(([h, d]) => {
    const n = S.projects.filter(p => p.hub === h && p.status === 'ativo').length;
    const i = S.items.inbox.filter(x => x.hub === h).length;
    return `<div style="background:var(--surface-alt);border-radius:6px;padding:6px 10px;font-size:0.8rem;"><strong>${esc(h)}</strong> — ${esc(d)}<div style="font-size:0.7rem;color:var(--fg-secondary);">${n} ativo(s) · ${i} na inbox</div></div>`;
  }).join('');
}

// ===== RODA DA VIDA =====
let rodaChart = null, rodaKey = '';
const miniCharts = [], openStates = [];
const saveAreas = debounce(() => saveState('areas', S.state.areas), 500);
const saveTensions = debounce(() => saveState('tensions', S.state.tensions), 500);
function chartTheme() { return { fg: cssVar('--fg'), fg2: cssVar('--fg-secondary'), border: cssVar('--border') }; }

function renderRoda() {
  const areas = S.state.areas;
  if (!areas?.length || typeof Chart === 'undefined') return;
  const key = JSON.stringify(areas) + JSON.stringify(S.state.tensions);
  if (key === rodaKey) return; // evita redesenhar durante o arraste
  rodaKey = key;
  const tri = S.reviews.find(r => r.freq === 'Trimestral');
  $('rodaSubtitle').textContent = `Diagnóstico trimestral · Última revisão: ${tri?.last_done ? fmtDate(tri.last_done) : 'não registrada'}`;
  const th = chartTheme();
  if (!rodaChart) {
    rodaChart = new Chart($('rodaChart').getContext('2d'), {
      type: 'radar',
      data: { labels: areas.map(a => a.name), datasets: [{ data: areas.map(a => a.score), backgroundColor: 'rgba(37, 99, 235, 0.15)', borderColor: 'rgba(37, 99, 235, 0.8)', borderWidth: 2, pointBackgroundColor: 'rgba(37, 99, 235, 1)', pointRadius: 5 }] },
      options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { display: false } },
        scales: { r: { min: 0, max: 10, ticks: { stepSize: 2, backdropColor: 'transparent', color: th.fg2 }, grid: { color: th.border }, pointLabels: { font: { family: "'DM Sans', sans-serif", size: 11 }, color: th.fg } } } },
    });
  } else { rodaChart.data.labels = areas.map(a => a.name); rodaChart.data.datasets[0].data = areas.map(a => a.score); rodaChart.update('none'); }

  $('sliders').innerHTML = areas.map((a, i) => `<div class="slider-row"><label>${esc(a.name)}</label><input type="range" min="0" max="10" value="${a.score}" data-idx="${i}"><span class="val">${a.score}</span></div>`).join('');
  $('sliders').querySelectorAll('input').forEach(inp => inp.addEventListener('input', e => {
    const i = +e.target.dataset.idx, v = +e.target.value;
    areas[i].score = v; e.target.nextElementSibling.textContent = v;
    rodaChart.data.datasets[0].data = areas.map(a => a.score); rodaChart.update('none');
    rodaKey = JSON.stringify(areas) + JSON.stringify(S.state.tensions);
    renderTensions(); saveAreas();
  }));
  renderAccordion();
  renderTensions();
}
function renderAccordion() {
  const areas = S.state.areas;
  miniCharts.forEach(c => c && c.destroy()); miniCharts.length = 0;
  const el = $('accordion');
  el.innerHTML = '';
  areas.forEach((a, i) => {
    const item = document.createElement('div');
    item.className = 'accordion-item' + (openStates[i] ? ' open' : '');
    const avg = a.subs.length ? (a.subs.reduce((s, x) => s + x.score, 0) / a.subs.length).toFixed(1) : '—';
    item.innerHTML = `<button class="accordion-btn"><span>${esc(a.name)} <span style="font-weight:400;font-size:0.8rem;color:var(--fg-secondary);">(média ${avg})</span></span><span class="arrow">›</span></button>
      <div class="accordion-body"><div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;">
        <div style="width:160px;height:160px;flex-shrink:0;margin:0 auto;"><canvas id="miniRoda-${i}" width="160" height="160"></canvas></div>
        <div style="flex:1;min-width:180px;">
          ${a.subs.map((s, j) => `<div class="slider-row" style="gap:4px;">
            <button class="sub-remove-btn" data-j="${j}" title="Remover">✕</button>
            <input class="sub-label-edit" type="text" value="${esc(s.label)}" data-j="${j}" title="Renomear">
            <input type="range" min="0" max="10" value="${s.score}" data-j="${j}" class="sub-slider" style="flex:0 0 70px;">
            <span class="val" style="min-width:18px;text-align:center;">${s.score}</span></div>`).join('')}
          <div class="sub-action-row"><button class="sub-action-btn" data-sub="add">+ Sub-dimensão</button><button class="sub-action-btn" data-sub="reset" style="font-size:0.65rem;">↻ Padrão</button></div>
        </div></div></div>`;
    item.querySelector('.accordion-btn').addEventListener('click', () => {
      item.classList.toggle('open'); openStates[i] = item.classList.contains('open');
      if (openStates[i] && !miniCharts[i] && a.subs.length >= 3) miniCharts[i] = miniRoda(i);
    });
    if (openStates[i] && a.subs.length >= 3) setTimeout(() => { miniCharts[i] = miniRoda(i); }, 0);
    item.querySelectorAll('.sub-slider').forEach(sl => sl.addEventListener('input', e => {
      a.subs[+e.target.dataset.j].score = +e.target.value; e.target.nextElementSibling.textContent = e.target.value;
      syncArea(i);
    }));
    item.querySelectorAll('.sub-label-edit').forEach(inp => inp.addEventListener('change', e => {
      const v = e.target.value.trim(); if (!v) return;
      a.subs[+e.target.dataset.j].label = v; saveAreas(); rodaKey = ''; renderRoda();
    }));
    item.querySelectorAll('.sub-remove-btn').forEach(b => b.addEventListener('click', e => {
      if (a.subs.length <= 2) return; a.subs.splice(+e.target.dataset.j, 1); syncArea(i, true);
    }));
    item.querySelectorAll('.sub-action-btn').forEach(b => b.addEventListener('click', e => {
      if (e.target.dataset.sub === 'add') { if (a.subs.length >= 8) return; a.subs.push({ label: 'Nova dimensão', score: 5 }); }
      else { const def = S.state.default_subs?.[a.name]; if (def) a.subs = def.map(label => ({ label, score: 5 })); }
      syncArea(i, true);
    }));
    el.appendChild(item);
  });
}
function syncArea(i, rerender = false) {
  const a = S.state.areas[i];
  if (a.subs.length) a.score = Math.round(a.subs.reduce((s, x) => s + x.score, 0) / a.subs.length);
  saveAreas();
  if (rerender) { rodaKey = ''; renderRoda(); return; }
  rodaChart.data.datasets[0].data = S.state.areas.map(x => x.score); rodaChart.update('none');
  const main = $('sliders').querySelectorAll('input')[i];
  if (main) { main.value = a.score; main.nextElementSibling.textContent = a.score; }
  if (miniCharts[i]) { miniCharts[i].data.datasets[0].data = a.subs.map(s => s.score); miniCharts[i].update('none'); }
  rodaKey = JSON.stringify(S.state.areas) + JSON.stringify(S.state.tensions);
  renderTensions();
}
function miniRoda(i) {
  const a = S.state.areas[i], th = chartTheme();
  const c = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#6366f1'][i % 8];
  return new Chart($(`miniRoda-${i}`).getContext('2d'), {
    type: 'radar',
    data: { labels: a.subs.map(s => s.label.length > 12 ? s.label.slice(0, 12) + '…' : s.label), datasets: [{ data: a.subs.map(s => s.score), backgroundColor: c + '22', borderColor: c, borderWidth: 2, pointBackgroundColor: c, pointRadius: 3 }] },
    options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { display: false } },
      scales: { r: { min: 0, max: 10, ticks: { display: false }, grid: { color: th.border }, pointLabels: { font: { family: "'DM Sans', sans-serif", size: 9 }, color: th.fg2 } } } },
  });
}
function tensionValues() {
  const areas = S.state.areas, n = areas.length;
  if (!S.state.tensions) {
    S.state.tensions = {};
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) S.state.tensions[`${i}-${j}`] = Math.abs(areas[i].score - areas[j].score);
  }
  return S.state.tensions;
}
function renderTensions() {
  const areas = S.state.areas, n = areas.length, t = tensionValues();
  const color = v => (v <= 2 ? 'var(--success-soft)' : v <= 4 ? 'var(--warning-soft)' : 'var(--danger-soft)');
  let html = `<div class="tension-grid" style="grid-template-columns:repeat(${n + 1}, minmax(36px, 1fr));"><div class="tension-header"></div>`;
  for (let j = 0; j < n; j++) html += `<div class="tension-header">${esc(areas[j].name.substring(0, 5))}</div>`;
  for (let i = 0; i < n; i++) {
    html += `<div class="tension-header">${esc(areas[i].name.substring(0, 5))}</div>`;
    for (let j = 0; j < n; j++) {
      if (j > i) html += `<button class="tension-cell" data-key="${i}-${j}" style="background:${color(t[`${i}-${j}`] || 0)}">${t[`${i}-${j}`] || 0}</button>`;
      else if (i === j) html += `<div class="tension-cell" style="background:var(--accent-soft);cursor:default;">${areas[i].score}</div>`;
      else html += '<div class="tension-cell" style="background:transparent;cursor:default;"></div>';
    }
  }
  $('tensionMatrix').innerHTML = html + '</div>';
  $('tensionMatrix').querySelectorAll('button.tension-cell').forEach(b => b.addEventListener('click', () => {
    t[b.dataset.key] = ((t[b.dataset.key] || 0) + 1) % 11;
    rodaKey = JSON.stringify(S.state.areas) + JSON.stringify(S.state.tensions);
    renderTensions(); saveTensions();
  }));
  $('topTensions').innerHTML = Object.entries(t).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => {
    const [i, j] = k.split('-').map(Number);
    return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);">
      <span style="font-weight:600;min-width:24px;text-align:center;color:${v > 4 ? 'var(--danger)' : v > 2 ? 'var(--warning)' : 'var(--success)'}">${v}</span>
      <span style="font-size:0.85rem;">${esc(areas[i]?.name)} ↔ ${esc(areas[j]?.name)}</span></div>`;
  }).join('');
}

// ===== SAÚDE =====
const HEALTH_HABITS = [
  { id: 'meditacao', label: 'Meditação', icon: '🧘', unit: 'min', presets: [5, 10, 15, 20, 30] },
  { id: 'academia', label: 'Academia', icon: '🏋️', unit: '' },
  { id: 'cardio', label: 'Cardio', icon: '🏃', unit: 'min', presets: [10, 15, 20, 30, 45] },
  { id: 'sono', label: 'Sono', icon: '😴', unit: 'h', presets: [5, 6, 7, 8, 9] },
];
const DAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
function weekDays() {
  const base = new Date(S.meta.today + 'T12:00:00'), out = [];
  for (let i = 6; i >= 0; i--) { const d = new Date(base); d.setDate(d.getDate() - i); out.push(d.toISOString().slice(0, 10)); }
  return out;
}
ACTIONS['habit'] = async d => {
  const data = S.state.health || (S.state.health = {}), t = S.meta.today;
  data[t] = data[t] || {};
  if (d.habit === 'academia') data[t].academia = data[t].academia === 'sim' ? '' : 'sim';
  else data[t][d.habit] = d.val ? Number(d.val) : '';
  renderHealth(); await saveState('health', data);
};
function renderHealth() {
  const data = S.state.health || {}, t = S.meta.today, week = weekDays();
  $('healthTracker').innerHTML = `<div style="margin-bottom:20px;">
    <div style="font-size:0.82rem;color:var(--fg-secondary);margin-bottom:12px;">Hoje — ${new Date(t + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'short' })}</div>
    ${HEALTH_HABITS.map(h => {
      const val = data[t]?.[h.id] || '';
      const checked = h.id === 'academia' ? val === 'sim' : !!val;
      return `<div class="cadence-card" style="margin-bottom:10px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:${h.presets ? 8 : 0}px;">
          <div style="display:flex;align-items:center;gap:10px;"><span style="font-size:1.3rem;">${h.icon}</span><span style="font-weight:600;">${h.label}</span></div>
          ${checked ? `<span style="font-size:0.82rem;color:var(--success);font-weight:600;">✓ ${h.id === 'academia' ? 'Fui' : esc(val) + h.unit}</span>` : ''}
        </div>
        ${!h.presets
          ? `<button data-act="habit" data-habit="academia" style="width:100%;padding:10px;border-radius:var(--radius-sm);border:1px solid ${checked ? 'var(--success)' : 'var(--border)'};background:${checked ? 'var(--success-soft)' : 'var(--surface)'};color:var(--fg);cursor:pointer;font-size:0.9rem;font-weight:600;">${checked ? '✓ Fui hoje' : 'Marcar presença'}</button>`
          : `<div style="display:flex;gap:6px;flex-wrap:wrap;">${h.presets.map(p => { const on = Number(val) === p; return `<button data-act="habit" data-habit="${h.id}" data-val="${on ? '' : p}" style="flex:1;min-width:44px;padding:8px 4px;border-radius:var(--radius-sm);border:1px solid ${on ? 'var(--success)' : 'var(--border)'};background:${on ? 'var(--success-soft)' : 'var(--surface)'};color:${on ? 'var(--success)' : 'var(--fg)'};cursor:pointer;font-size:0.85rem;font-weight:${on ? 700 : 400};">${p}${h.unit}</button>`; }).join('')}</div>`}
      </div>`;
    }).join('')}</div>
    <div style="font-weight:600;margin-bottom:12px;">Últimos 7 dias</div>
    <div style="display:grid;grid-template-columns:80px repeat(7,1fr);gap:4px;font-size:0.75rem;text-align:center;">
      <div></div>${week.map(d => `<div style="color:var(--fg-secondary);">${DAY_LABELS[new Date(d + 'T12:00').getDay()]}<br>${d.slice(8)}</div>`).join('')}
      ${HEALTH_HABITS.map(h => `<div style="text-align:left;padding:4px 0;">${h.icon} ${h.label}</div>${week.map(d => {
        const v = data[d]?.[h.id], filled = h.id === 'academia' ? v === 'sim' : !!v;
        return `<div style="padding:6px 2px;border-radius:6px;background:${filled ? 'var(--success-soft)' : 'var(--surface-alt)'};color:${filled ? 'var(--success)' : 'var(--fg-secondary)'};">${v ? (h.id === 'academia' ? '✓' : esc(v) + (h.unit ? h.unit.charAt(0) : '')) : '—'}</div>`;
      }).join('')}`).join('')}
    </div>`;
}

// ===== MEDICAÇÃO =====
ACTIONS['med'] = async d => {
  const data = S.state.meds || (S.state.meds = {}), t = S.meta.today;
  data[t] = data[t] || {};
  data[t][d.id] = !data[t][d.id];
  renderMeds(); await saveState('meds', data);
};
function renderMeds() {
  const meds = S.state.meds_list || [], data = S.state.meds || {}, t = S.meta.today, week = weekDays(), td = data[t] || {};
  $('medsTracker').innerHTML = `<div style="margin-bottom:20px;">
    <div style="font-size:0.82rem;color:var(--fg-secondary);margin-bottom:12px;">Hoje — ${new Date(t + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'short' })}</div>
    <div style="display:flex;flex-direction:column;gap:8px;">${meds.map(m => {
      const taken = td[m.id] === true;
      return `<div class="cadence-card" style="margin-bottom:0;cursor:pointer;" data-act="med" data-id="${esc(m.id)}"><div style="display:flex;align-items:center;justify-content:space-between;">
        <div><span style="font-weight:600;">${esc(m.label)}</span>${m.dose ? `<span style="color:var(--fg-secondary);font-size:0.85rem;"> ${esc(m.dose)}</span>` : ''}<div style="font-size:0.75rem;color:var(--fg-secondary);margin-top:2px;">⏰ ${esc(m.time)}</div></div>
        <div style="width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1.1rem;background:${taken ? 'var(--success-soft)' : 'var(--surface-alt)'};color:${taken ? 'var(--success)' : 'var(--fg-secondary)'};">${taken ? '✓' : '○'}</div>
      </div></div>`;
    }).join('')}</div>
    <div style="margin-top:12px;text-align:center;font-size:0.85rem;color:var(--fg-secondary);">${meds.filter(m => td[m.id]).length}/${meds.length} tomados hoje</div></div>
    <div style="font-weight:600;margin-bottom:12px;">Últimos 7 dias</div>
    <div style="display:grid;grid-template-columns:100px repeat(7,1fr);gap:4px;font-size:0.75rem;text-align:center;">
      <div></div>${week.map(d => `<div style="color:var(--fg-secondary);">${DAY_LABELS[new Date(d + 'T12:00').getDay()]}<br>${d.slice(8)}</div>`).join('')}
      ${meds.map(m => `<div style="text-align:left;padding:4px 0;font-size:0.72rem;">${esc(m.label)}</div>${week.map(d => {
        const tk = data[d]?.[m.id] === true;
        return `<div style="padding:6px 2px;border-radius:6px;background:${tk ? 'var(--success-soft)' : 'var(--danger-soft)'};color:${tk ? 'var(--success)' : 'var(--danger)'};">${tk ? '✓' : '✗'}</div>`;
      }).join('')}`).join('')}
    </div>`;
}

// ===== LINKS =====
const linkCats = () => S.state.links || (S.state.links = []);
const saveLinks = async () => { renderLinks(); await saveState('links', S.state.links); };
ACTIONS['link-add'] = async d => {
  const v = await dialog({ title: 'Novo link', fields: [{ name: 'label', label: 'Nome', required: true }, { name: 'url', label: 'URL', required: true, placeholder: 'https://…' }] });
  if (!v) return;
  linkCats()[+d.ci].links.push({ label: v.label.trim(), url: /^https?:/.test(v.url) ? v.url.trim() : 'https://' + v.url.trim() });
  saveLinks();
};
ACTIONS['link-edit'] = async d => {
  const l = linkCats()[+d.ci].links[+d.li];
  const v = await dialog({ title: 'Editar link', fields: [{ name: 'label', label: 'Nome', value: l.label, required: true }, { name: 'url', label: 'URL', value: l.url, required: true }] });
  if (!v) return;
  l.label = v.label.trim(); l.url = /^https?:/.test(v.url) ? v.url.trim() : 'https://' + v.url.trim();
  saveLinks();
};
ACTIONS['link-remove'] = d => { if (confirm('Remover este link?')) { linkCats()[+d.ci].links.splice(+d.li, 1); saveLinks(); } };
ACTIONS['link-cat-add'] = async () => {
  const v = await dialog({ title: 'Nova categoria', fields: [{ name: 'name', label: 'Nome', required: true }, { name: 'icon', label: 'Ícone (emoji)', value: '📁' }] });
  if (v) { linkCats().push({ name: v.name.trim(), icon: v.icon || '📁', links: [] }); saveLinks(); }
};
ACTIONS['link-cat-rename'] = async d => {
  const c = linkCats()[+d.ci];
  const v = await dialog({ title: 'Renomear categoria', fields: [{ name: 'name', label: 'Nome', value: c.name, required: true }, { name: 'icon', label: 'Ícone', value: c.icon }] });
  if (v) { c.name = v.name.trim(); c.icon = v.icon || c.icon; saveLinks(); }
};
ACTIONS['link-cat-remove'] = d => {
  const c = linkCats()[+d.ci];
  if (confirm(`Remover a categoria "${c.name}" e todos os seus links?`)) { linkCats().splice(+d.ci, 1); saveLinks(); }
};
function renderLinks() {
  $('linksHub').innerHTML = linkCats().map((cat, ci) => `<div class="card" style="margin-bottom:12px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <h3 style="font-size:0.95rem;display:flex;align-items:center;gap:6px;cursor:pointer;" data-act="link-cat-rename" data-ci="${ci}" title="Renomear"><span style="font-size:1.1rem;">${esc(cat.icon)}</span>${esc(cat.name)}</h3>
      <button data-act="link-cat-remove" data-ci="${ci}" style="background:none;border:none;color:var(--fg-secondary);cursor:pointer;font-size:0.8rem;" title="Remover categoria">✕</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px;">${cat.links.map((l, li) => `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--surface-alt);border-radius:var(--radius-sm);">
        <a href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener" style="flex:1;min-width:0;display:flex;align-items:center;gap:8px;text-decoration:none;color:var(--accent-text);font-size:0.88rem;overflow:hidden;">
          <img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(host(l.url))}&sz=32" width="16" height="16" style="flex-shrink:0;border-radius:2px;" alt="" onerror="this.style.display='none'">
          <span style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(l.label)}</span>
          <span style="color:var(--fg-secondary);font-size:0.75rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(host(l.url))}</span>
        </a>
        <button data-act="link-edit" data-ci="${ci}" data-li="${li}" style="background:none;border:none;color:var(--fg-secondary);cursor:pointer;font-size:0.75rem;" title="Editar">✎</button>
        <button data-act="link-remove" data-ci="${ci}" data-li="${li}" style="background:none;border:none;color:var(--fg-secondary);cursor:pointer;font-size:0.75rem;" title="Remover">✕</button>
      </div>`).join('')}</div>
    <button data-act="link-add" data-ci="${ci}" style="margin-top:8px;padding:6px 12px;border-radius:var(--radius-sm);border:1px dashed var(--border);background:transparent;color:var(--fg-secondary);cursor:pointer;font-size:0.8rem;width:100%;">＋ Adicionar link</button>
  </div>`).join('');
}

// ===== início =====
// Links "abrir no app" (ex.: ?capture=texto) — útil para atalhos do celular.
const params = new URLSearchParams(location.search);
async function start() {
  await refresh();
  if (!S) return;
  connectStream();
  if (params.get('capture')) {
    await act(api('/api/items', { method: 'POST', body: { text: params.get('capture'), source: params.get('source') || 'Captura rápida', url: params.get('url') || undefined } }), '✓ Capturado');
    history.replaceState(null, '', location.pathname);
  }
}
(async () => {
  try {
    const r = await fetch('/api/session', { credentials: 'same-origin' });
    const st = await r.json();
    if (!st.logged) return showLogin(st);
    TOKEN = st.token || '';
    await start();
  } catch (e) { setConn(false); $('dailyTasks').innerHTML = `<div class="card" style="color:var(--danger)">Não foi possível conectar ao servidor GTD: ${esc(e.message)}<br><small style="color:var(--fg-secondary)">Rode <code>npm start</code> na pasta do projeto.</small></div>`; }
})();
// Virada do dia com a aba aberta: recarrega para aplicar carry-over.
setInterval(() => { if (S && new Date().toLocaleDateString('en-CA') !== S.meta.today) refresh(); }, 60000);
