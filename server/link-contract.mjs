// Contrato de ligação gtd-link/1 — formato das mensagens trocadas entre o GTD e
// sistemas externos (hoje: o Diário do Doutorado). Cada tipo tem um dono e um sentido.
// Documentação: docs/contrato-ligacao.md · Esquema: docs/contrato-ligacao.schema.json

export const CONTRACT = 'gtd-link/1';

const KEY = {
  acao: /^dd:acao:[\w-]{1,80}$/,
  marco: /^dd:(?:eap:[a-z0-9-]{1,20}:\d+(?:_\d+)*|gate:[A-Za-z0-9-]{1,20})$/,
  bloqueio: /^dd:bloqueio:[\w-]{1,80}$/,
  captura: /^gtd:item:i_[0-9a-f]{8}$/,
};
const REF = KEY.marco;

/** Tipos de mensagem: quem é dono e em que sentido viajam. */
export const TYPES = {
  'acao.upsert': { de: 'diario', dono: 'diario', chave: KEY.acao,
    campos: { texto: 'string!', responsavel: 'string', prazo: 'date', estado: ['aberta', 'feita', 'cancelada'] } },
  'acao.concluida': { de: 'gtd', dono: 'gtd', chave: KEY.acao, campos: { concluida_em: 'iso!' } },
  'marco.status': { de: 'diario', dono: 'diario', chave: KEY.marco,
    campos: { titulo: 'string!', status: ['pendente', 'em_andamento', 'concluido', 'bloqueado'], progresso: 'pct',
      decisao: ['', 'go', 'iterar', 'pivotar', 'parar'], gate_em_foco: 'string', proximo_marco: 'string', pendencias: 'string' } },
  'bloqueio.aberto': { de: 'diario', dono: 'diario', chave: KEY.bloqueio, campos: { texto: 'string!' } },
  'bloqueio.fechado': { de: 'diario', dono: 'diario', chave: KEY.bloqueio, campos: {} },
  'captura.enviada': { de: 'gtd', dono: 'diario', chave: KEY.captura, campos: { texto: 'string!', notas: 'string', url: 'string' } },
};

const isIso = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s) && !isNaN(Date.parse(s));
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T12:00:00Z'));

/** Valida uma mensagem. Retorna a lista de erros (vazia = válida). */
export function validate(msg, { from } = {}) {
  const e = [];
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return ['mensagem deve ser um objeto'];
  if (msg.contrato !== CONTRACT) e.push(`contrato deve ser "${CONTRACT}"`);
  const t = TYPES[msg.tipo];
  if (!t) return [...e, `tipo desconhecido: ${msg.tipo} (${Object.keys(TYPES).join(', ')})`];
  if (from && t.de !== from) e.push(`o tipo ${msg.tipo} só pode ser enviado por "${t.de}"`);
  if (typeof msg.chave !== 'string' || !t.chave.test(msg.chave)) e.push(`chave inválida para ${msg.tipo}: ${msg.chave}`);
  if (!isIso(msg.alterado_em)) e.push('alterado_em deve ser data-hora ISO 8601 com fuso (ex.: 2026-10-17T14:20:00Z)');
  if (msg.ligado_a != null && (typeof msg.ligado_a !== 'string' || !REF.test(msg.ligado_a))) e.push(`ligado_a inválido: ${msg.ligado_a}`);
  const d = msg.dados;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return [...e, 'dados deve ser um objeto'];
  for (const [k, rule] of Object.entries(t.campos)) {
    const v = d[k];
    const required = typeof rule === 'string' && rule.endsWith('!');
    if (v === undefined || v === null || v === '') { if (required) e.push(`dados.${k} é obrigatório`); continue; }
    const r = typeof rule === 'string' ? rule.replace('!', '') : rule;
    if (Array.isArray(r)) { if (!r.includes(v)) e.push(`dados.${k} deve ser um de: ${r.filter(Boolean).join(', ')}`); }
    else if (r === 'string' && (typeof v !== 'string' || v.length > 2000)) e.push(`dados.${k} deve ser texto (até 2000 caracteres)`);
    else if (r === 'date' && !isDate(v)) e.push(`dados.${k} deve ser data AAAA-MM-DD`);
    else if (r === 'iso' && !isIso(v)) e.push(`dados.${k} deve ser data-hora ISO 8601`);
    else if (r === 'pct' && !(typeof v === 'number' && v >= 0 && v <= 100)) e.push(`dados.${k} deve ser número de 0 a 100`);
  }
  return e;
}

/** Mensagens de exemplo (usadas na documentação e nos testes). */
export const EXAMPLES = [
  { contrato: CONTRACT, tipo: 'acao.upsert', chave: 'dd:acao:7f3a', alterado_em: '2026-10-17T14:20:00Z', ligado_a: 'dd:eap:bib:4_2_3',
    dados: { texto: 'Enviar planilha de Kappa para a orientadora', responsavel: 'eu', prazo: '2026-10-24', estado: 'aberta' } },
  { contrato: CONTRACT, tipo: 'acao.upsert', chave: 'dd:acao:8b21', alterado_em: '2026-10-17T14:20:00Z', ligado_a: 'dd:gate:G3',
    dados: { texto: 'Revisar extração da amostra', responsavel: 'Orientadora', prazo: '2026-10-31', estado: 'aberta' } },
  { contrato: CONTRACT, tipo: 'marco.status', chave: 'dd:gate:G3', alterado_em: '2026-10-17T14:25:00Z',
    dados: { titulo: 'Gate G3 · RSL → DSR', status: 'em_andamento', progresso: 33, decisao: '', pendencias: 'Kappa da leitura completa' } },
  { contrato: CONTRACT, tipo: 'marco.status', chave: 'dd:eap:bib:4', alterado_em: '2026-10-17T14:25:00Z',
    dados: { titulo: '4. Revisão sistemática da literatura', status: 'em_andamento', progresso: 40, gate_em_foco: 'G3', proximo_marco: 'M3' } },
  { contrato: CONTRACT, tipo: 'bloqueio.aberto', chave: 'dd:bloqueio:e91c', alterado_em: '2026-10-17T14:30:00Z', ligado_a: 'dd:eap:bib:4_3',
    dados: { texto: 'Segundo revisor indisponível até novembro' } },
  { contrato: CONTRACT, tipo: 'acao.concluida', chave: 'dd:acao:7f3a', alterado_em: '2026-10-18T09:00:00Z',
    dados: { concluida_em: '2026-10-18T09:00:00Z' } },
  { contrato: CONTRACT, tipo: 'captura.enviada', chave: 'gtd:item:i_1a2b3c4d', alterado_em: '2026-10-18T09:05:00Z', ligado_a: 'dd:eap:bib:4',
    dados: { texto: 'Ideia: usar Kappa ponderado na leitura completa', notas: 'Ver Landis & Koch', url: '' } },
];

/** Uma referência do Diário (ligado_a) pertence à ligação `ref`? Ex.: dd:eap:bib:4_2_3 ⊂ dd:eap:bib:4 */
export function refCovers(ref, target) {
  if (!ref || !target) return false;
  return target === ref || target.startsWith(ref + '_');
}
