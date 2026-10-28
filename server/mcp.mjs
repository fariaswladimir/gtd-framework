// Servidor MCP (Model Context Protocol) — JSON-RPC 2.0, sem estado.
// Exposto em POST /mcp (Streamable HTTP) e, via mcp/stdio-bridge.mjs, em stdio.
import { GtdError, HUBS, LANES, STATUSES, MODES } from './store.mjs';
import { parseBulk } from './ingest.mjs';

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const hubEnum = Object.keys(HUBS);
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });

const TOOLS = [
  {
    name: 'gtd_context',
    description: 'Retorna o estado atual do GTD em Markdown: alertas, projetos ativos com próximo passo, tarefas de hoje, inbox, revisões e atividade recente. Chame no início de qualquer conversa para retomar o fluxo de onde parou. Use "hub" para filtrar por um projeto do Claude (edge, doutorado, side-projects, consultoria-dados, consultoria-n8n, pessoal).',
    inputSchema: { type: 'object', properties: { hub: str('Filtra por hub', { enum: hubEnum }) } },
    annotations: { readOnlyHint: true },
    run: (s, a) => s.contextMarkdown({ hub: a.hub }),
  },
  {
    name: 'gtd_capture',
    description: 'Captura um ou mais itens na Inbox do GTD (ideias, pendências, e-mails, notas, links). Não processa: só registra. Para vários itens use "items" (lista estruturada) ou "texto" (bloco livre colado: uma linha por item, ou modo "blocos" com linha em branco entre itens; links viram o campo url; #doutorado, #edge etc. definem o hub; títulos markdown com nome de hub valem para os itens abaixo).',
    inputSchema: {
      type: 'object',
      properties: {
        text: str('Texto curto do item'),
        notes: str('Detalhes opcionais'),
        source: str('Origem (ex.: Claude, Gmail, GitHub, Lovable, WhatsApp self). Padrão: Claude'),
        url: str('Link relacionado'),
        hub: str('Hub/contexto', { enum: hubEnum }),
        items: { type: 'array', description: 'Lote de itens {text, notes?, source?, url?, hub?}', items: { type: 'object' } },
        texto: str('Bloco de texto livre com vários itens, links e anotações misturados'),
        modo: str('Como dividir o texto livre', { enum: ['linhas', 'blocos'] }),
      },
    },
    run: (s, a) => {
      const list = a.texto ? parseBulk(a.texto, { mode: a.modo === 'blocos' ? 'blocos' : 'linhas', hub: a.hub }).map(({ sem_titulo, ...e }) => e)
        : a.items?.length ? a.items : [a];
      if (!list.length) throw new GtdError(400, 'Nenhum item encontrado no texto');
      const res = s.captureMany(list.map(x => ({ ...x, source: x.source || a.source || 'Claude', hub: x.hub || a.hub })));
      return res.map(r => `${r.duplicate ? '= já existia' : '+ capturado'} ${r.item.id}: ${r.item.text}`).join('\n');
    },
  },
  {
    name: 'gtd_inbox',
    description: 'Lista itens de um balde do GTD: inbox (a processar), waiting (aguardando terceiros), someday (algum dia), reference, trash, processed.',
    inputSchema: {
      type: 'object',
      properties: {
        bucket: str('Balde', { enum: ['inbox', 'waiting', 'someday', 'reference', 'trash', 'processed', 'all'] }),
        hub: str('Filtra por hub', { enum: hubEnum }),
        q: str('Busca textual'),
        limit: { type: 'integer', description: 'Máximo de itens (padrão 50)' },
      },
    },
    annotations: { readOnlyHint: true },
    run: (s, a) => s.listItems({ bucket: a.bucket || 'inbox', hub: a.hub, q: a.q, limit: a.limit || 50 }),
  },
  {
    name: 'gtd_process',
    description: 'Clarifica um item da inbox (GTD): projeto → vira etapa/cartão/to-do do projeto; tarefa → vira tarefa do dia; feito → resolvido em <2 min; waiting → aguardando terceiros; diario → envia ao Diário do Doutorado como rascunho de entrada; someday; reference; trash; inbox → devolve à inbox.',
    inputSchema: {
      type: 'object', required: ['id', 'action'],
      properties: {
        id: str('ID do item (i_...)'),
        action: str('Destino', { enum: ['projeto', 'tarefa', 'feito', 'waiting', 'diario', 'someday', 'reference', 'trash', 'inbox'] }),
        who: str('Para action=waiting: de quem você está aguardando'),
        project: str('Projeto (id ou parte do nome) — obrigatório para action=projeto; opcional para tarefa'),
        column: str('Para projetos kanban: todo | doing | done'),
        period: str('Para tarefa: manhã | tarde | noite'),
        date: str('Para tarefa: YYYY-MM-DD, "hoje" ou "amanhã"'),
        text: str('Reescreve o texto ao processar (opcional, ex.: transformar em próxima ação clara)'),
      },
    },
    run: (s, a) => s.processItem(a.id, a),
  },
  {
    name: 'gtd_projects',
    description: 'Lista projetos com lane (sustento/paralelos/sandbox), modo, status, prioridade, progresso, próximo passo e conteúdo (etapas, kanban ou to-dos).',
    inputSchema: {
      type: 'object',
      properties: {
        status: str('Filtra por status', { enum: STATUSES }),
        lane: str('Filtra por lane', { enum: Object.keys(LANES) }),
        hub: str('Filtra por hub', { enum: hubEnum }),
      },
    },
    annotations: { readOnlyHint: true },
    run: (s, a) => s.listProjects(a),
  },
  {
    name: 'gtd_project_update',
    description: 'Atualiza um projeto: status (respeita limites de WIP; use force para ignorar), prioridade, próximo passo, progresso, notas, post-mortem; e operações de conteúdo: add_item, advance_step, kanban_move, todo_toggle, remove_item.',
    inputSchema: {
      type: 'object', required: ['project'],
      properties: {
        project: str('Projeto (id ou parte do nome)'),
        status: str('Novo status', { enum: STATUSES }),
        priority: { type: 'integer', enum: [1, 2, 3], description: '1 alta, 2 média, 3 baixa' },
        next_step: str('Próxima ação concreta'),
        progress: { type: 'integer', description: '0–100' },
        lane: str('Lane', { enum: Object.keys(LANES) }),
        hub: str('Hub', { enum: hubEnum }),
        notes: str('Notas do projeto'),
        post_mortem: str('Post-mortem (obrigatório ao abandonar)'),
        github: str('Repositório owner/nome'),
        lovable_url: str('URL do app Lovable'),
        add_item: str('Adiciona etapa (projeto), cartão (kanban) ou to-do'),
        column: str('Coluna kanban para add_item/remove_item: todo | doing | done'),
        advance_step: { type: 'boolean', description: 'Conclui a etapa atual e avança (modo projeto)' },
        kanban_move: { type: 'object', description: '{card: texto ou índice, from?: coluna, to: todo|doing|done}' },
        todo_toggle: str('Marca/desmarca to-do (texto ou índice)'),
        remove_item: str('Remove etapa/cartão/to-do (texto ou índice)'),
        force: { type: 'boolean', description: 'Ignora o limite de WIP' },
      },
    },
    run: (s, a) => { const { project, force, ...rest } = a; return s.updateProject(project, rest, { force }); },
  },
  {
    name: 'gtd_project_create',
    description: 'Cria projeto. Modo: projeto (>5 passos, etapas), kanban (fluxo contínuo) ou todo (<5 itens). Novos projetos entram no backlog por padrão.',
    inputSchema: {
      type: 'object', required: ['name', 'lane'],
      properties: {
        name: str('Nome'),
        lane: str('Lane', { enum: Object.keys(LANES) }),
        mode: str('Modo', { enum: MODES }),
        status: str('Status inicial', { enum: STATUSES }),
        hub: str('Hub', { enum: hubEnum }),
        priority: { type: 'integer', enum: [1, 2, 3] },
        next_step: str('Próximo passo'),
        steps: { type: 'array', items: { type: 'string' }, description: 'Etapas (modo projeto)' },
        todos: { type: 'array', items: { type: 'string' }, description: 'To-dos (modo todo)' },
        github: str('owner/repo'),
        lovable_url: str('URL Lovable'),
        notes: str('Notas'),
        force: { type: 'boolean', description: 'Ignora WIP se status=ativo' },
      },
    },
    run: (s, a) => { const { force, ...rest } = a; return s.createProject(rest, { force }); },
  },
  {
    name: 'gtd_today',
    description: 'Tarefas do dia agrupadas por período (manhã/tarde/noite), com carry-over. Pendências de dias anteriores são trazidas automaticamente para hoje.',
    inputSchema: { type: 'object', properties: { date: str('YYYY-MM-DD (padrão: hoje)') } },
    annotations: { readOnlyHint: true },
    run: (s, a) => s.dayView(a.date),
  },
  {
    name: 'gtd_task_add',
    description: 'Adiciona tarefa ao dia (máx. recomendado: 7 por dia).',
    inputSchema: {
      type: 'object', required: ['text'],
      properties: {
        text: str('Próxima ação concreta'),
        period: str('Período', { enum: ['manhã', 'tarde', 'noite'] }),
        date: str('YYYY-MM-DD, "hoje" ou "amanhã"'),
        project: str('Projeto relacionado (id ou nome)'),
        lane: str('Lane', { enum: Object.keys(LANES) }),
      },
    },
    run: (s, a) => s.addTask(a),
  },
  {
    name: 'gtd_task_update',
    description: 'Conclui, reabre, reagenda, renomeia ou remove uma tarefa.',
    inputSchema: {
      type: 'object', required: ['id'],
      properties: {
        id: str('ID da tarefa (t_...)'),
        done: { type: 'boolean' },
        text: str('Novo texto'),
        period: str('Período', { enum: ['manhã', 'tarde', 'noite'] }),
        date: str('YYYY-MM-DD, "hoje" ou "amanhã"'),
        delete: { type: 'boolean', description: 'Remove a tarefa' },
      },
    },
    run: (s, a) => (a.delete ? s.deleteTask(a.id) : s.updateTask(a.id, a)),
  },
  {
    name: 'gtd_review',
    description: 'Retorna o checklist e o status de uma cadência de revisão (Diária, Semanal, Mensal, Trimestral). Com mark_done=true registra a revisão como concluída.',
    inputSchema: {
      type: 'object', required: ['cadence'],
      properties: {
        cadence: str('Cadência', { enum: ['Diária', 'Semanal', 'Mensal', 'Trimestral'] }),
        mark_done: { type: 'boolean' },
        notes: str('Resumo/decisões da revisão'),
      },
    },
    run: (s, a) => (a.mark_done ? s.markReview(a.cadence, a.notes)
      : s.reviews().find(r => r.freq.toLowerCase() === a.cadence.toLowerCase()) || (() => { throw new GtdError(404, 'Cadência não encontrada'); })()),
  },
  {
    name: 'gtd_activity',
    description: 'Log de atividade (o que mudou): capturas, processamentos, projetos, tarefas, revisões. Use "since" (ISO) para ver só o que mudou desde a última sessão.',
    inputSchema: {
      type: 'object',
      properties: { since: str('ISO timestamp'), limit: { type: 'integer' }, type: str('Prefixo do tipo, ex.: item, project, task') },
    },
    annotations: { readOnlyHint: true },
    run: (s, a) => s.events(a).map(e => `${e.ts} · ${e.type} · ${e.summary || ''}`).join('\n') || 'Sem atividade.',
  },
  {
    name: 'gtd_link_sync',
    description: 'Sincroniza o GTD com um sistema ligado (hoje: o Diário do Doutorado) pelo contrato gtd-link/1. Envie as mensagens de que o Diário é dono (acao.upsert, marco.status, bloqueio.aberto, bloqueio.fechado) e os ids confirmados das pendências recebidas antes. A resposta traz o resultado de cada mensagem e as pendências do GTD para o Diário (acao.concluida, captura.enviada). Formato completo em docs/contrato-ligacao.md.',
    inputSchema: {
      type: 'object',
      properties: {
        sistema: str('Sistema ligado', { enum: ['diario'] }),
        mensagens: { type: 'array', items: { type: 'object' }, description: 'Mensagens {contrato:"gtd-link/1", tipo, chave, alterado_em, ligado_a?, dados}' },
        confirmados: { type: 'array', items: { type: 'integer' }, description: 'ids de pendências já aplicadas no Diário' },
      },
    },
    run: (s, a) => s.link.sync(a),
  },
  {
    name: 'gtd_links',
    description: 'Lista, cria ou desfaz ligações entre projetos do GTD e referências do Diário (dd:eap:<árvore>:<código com _> ou dd:gate:<id>). Sem "action", lista as ligações com o status espelhado do Diário e os bloqueios abertos.',
    inputSchema: {
      type: 'object',
      properties: {
        action: str('Operação', { enum: ['list', 'create', 'delete'] }),
        project: str('Projeto do GTD (id ou parte do nome) — para create e list'),
        ref: str('Referência no Diário, ex.: dd:eap:bib:4 ou dd:gate:G3 — para create'),
        id: str('ID da ligação (l_...) — para delete'),
      },
    },
    run: (s, a) => (a.action === 'create' ? s.link.createLink(a) : a.action === 'delete' ? s.link.deleteLink(a.id)
      : { status: s.link.status(), links: s.link.listLinks({ project: a.project }), bloqueios: s.link.blockers() }),
  },
];

const PROMPTS = [
  { name: 'abertura_diaria', description: 'Abertura do dia (5 min): contexto, seleção de até 7 tarefas por período.',
    text: 'Faça minha abertura diária do GTD. 1) Chame gtd_context. 2) Mostre os alertas. 3) Proponha até 7 tarefas para hoje distribuídas em manhã/tarde/noite, priorizando próximos passos dos projetos ativos e carry-overs. 4) Depois que eu confirmar, registre com gtd_task_add/gtd_task_update.' },
  { name: 'fechamento_diario', description: 'Fechamento do dia (5 min): marcar concluídas, tratar carry-overs, capturar pendências.',
    text: 'Faça meu fechamento diário do GTD. Chame gtd_today, pergunte o que concluí e marque com gtd_task_update. Para tarefas com carry-over ≥3 dias, sugira quebrar, delegar ou descartar. Capture pendências soltas com gtd_capture e registre a revisão Diária com gtd_review (mark_done).' },
  { name: 'processar_inbox', description: 'Clarificar a inbox item a item (acionável? referência? lixo?).',
    text: 'Vamos processar minha inbox do GTD. Chame gtd_inbox e, para cada item, sugira um destino (projeto, tarefa, feito, someday, reference, trash) com justificativa curta, reescrevendo como próxima ação concreta quando for acionável. Agrupe as sugestões e só execute gtd_process depois da minha confirmação.' },
  { name: 'revisao_semanal', description: 'Revisão semanal (30 min, domingo).',
    text: 'Conduza minha revisão semanal do GTD. Chame gtd_review (Semanal) e gtd_context. Passe pelo checklist: inbox zerada, WIP das 3 lanes, pausados há mais de 60 dias, carry-overs recorrentes, planejamento da semana. Proponha mudanças de status/prioridade e próximos passos; aplique com as ferramentas após minha confirmação e registre com gtd_review mark_done=true e um resumo em notes.' },
];

function text(content) {
  return { content: [{ type: 'text', text: typeof content === 'string' ? content : JSON.stringify(content, null, 2) }] };
}

export function createMcp(store, { name = 'gtd-framework', version = '1.0.0' } = {}) {
  function call(method, params = {}) {
    switch (method) {
      case 'initialize': {
        const v = SUPPORTED.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED[0];
        return {
          protocolVersion: v,
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: { name, version },
          instructions: 'GTD pessoal do Wlad. Comece chamando gtd_context para retomar o fluxo. Capture com gtd_capture, clarifique com gtd_process, mantenha projetos e tarefas atualizados. Respeite os limites de WIP (Sustento 2, Paralelos 3, Sandbox 2; global 7) e o máximo de 7 tarefas/dia.',
        };
      }
      case 'ping': return {};
      case 'tools/list': return { tools: TOOLS.map(({ run, ...t }) => t) };
      case 'tools/call': {
        const tool = TOOLS.find(t => t.name === params.name);
        if (!tool) throw Object.assign(new Error(`Ferramenta desconhecida: ${params.name}`), { code: -32602 });
        try { return text(tool.run(store, params.arguments || {})); }
        catch (e) {
          if (e instanceof GtdError) return { ...text(`Erro: ${e.message}`), isError: true };
          throw e;
        }
      }
      case 'prompts/list': return { prompts: PROMPTS.map(({ text: _t, ...p }) => p) };
      case 'prompts/get': {
        const p = PROMPTS.find(x => x.name === params.name);
        if (!p) throw Object.assign(new Error(`Prompt desconhecido: ${params.name}`), { code: -32602 });
        return { description: p.description, messages: [{ role: 'user', content: { type: 'text', text: p.text } }] };
      }
      case 'resources/list': return { resources: [] };
      case 'resources/templates/list': return { resourceTemplates: [] };
      default: throw Object.assign(new Error(`Método não suportado: ${method}`), { code: -32601 });
    }
  }

  /** Processa uma mensagem JSON-RPC; retorna null para notificações. */
  function handle(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      if (msg && msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) return null; // resposta do cliente
      return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Requisição JSON-RPC inválida' } };
    }
    const isNotification = msg.id === undefined || msg.id === null;
    try {
      const result = call(msg.method, msg.params);
      return isNotification ? null : { jsonrpc: '2.0', id: msg.id, result };
    } catch (e) {
      if (isNotification) return null;
      return { jsonrpc: '2.0', id: msg.id, error: { code: e.code || -32603, message: e.message } };
    }
  }

  return { handle, tools: TOOLS, prompts: PROMPTS };
}
