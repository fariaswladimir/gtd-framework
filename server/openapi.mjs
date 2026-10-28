// Especificação OpenAPI 3.1 — para Lovable, GPT Actions, n8n, Postman etc.
export function openapi(baseUrl) {
  const ref = n => ({ $ref: `#/components/schemas/${n}` });
  const json = schema => ({ content: { 'application/json': { schema } } });
  const ok = (schema, description = 'OK') => ({ 200: { description, ...json(schema) } });
  const q = (name, description, schema = { type: 'string' }) => ({ name, in: 'query', required: false, description, schema });
  const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
  return {
    openapi: '3.1.0',
    info: { title: 'GTD Framework API', version: '1.0.0', description: 'API do GTD pessoal: captura (inbox), clarificação, projetos em 3 lanes com WIP, tarefas do dia, revisões e contexto consolidado. Autenticação: header `Authorization: Bearer <token>` (ou `?token=` para webhooks).' },
    servers: [{ url: baseUrl }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      schemas: {
        Item: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, notes: { type: ['string', 'null'] }, source: { type: 'string' }, source_ref: { type: ['string', 'null'] }, url: { type: ['string', 'null'] }, hub: { type: ['string', 'null'] }, bucket: { type: 'string', enum: ['inbox', 'someday', 'reference', 'trash', 'processed'] }, destination: { type: ['string', 'null'] }, created_at: { type: 'string' }, processed_at: { type: ['string', 'null'] } } },
        CaptureInput: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, notes: { type: 'string' }, source: { type: 'string', examples: ['Lovable', 'Gmail', 'Claude'] }, source_ref: { type: 'string', description: 'ID externo para deduplicar' }, url: { type: 'string' }, hub: { type: 'string', enum: ['edge', 'doutorado', 'side-projects', 'consultoria-dados', 'consultoria-n8n', 'pessoal'] } } },
        ProcessInput: { type: 'object', required: ['action'], properties: { action: { type: 'string', enum: ['projeto', 'tarefa', 'feito', 'someday', 'reference', 'trash', 'inbox'] }, project: { type: 'string', description: 'id ou parte do nome' }, column: { type: 'string', enum: ['todo', 'doing', 'done'] }, period: { type: 'string', enum: ['manhã', 'tarde', 'noite'] }, date: { type: 'string' }, text: { type: 'string' } } },
        Project: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, lane: { type: 'string', enum: ['sustento', 'paralelos', 'sandbox'] }, mode: { type: 'string', enum: ['projeto', 'kanban', 'todo'] }, status: { type: 'string', enum: ['backlog', 'ativo', 'pausado', 'concluido', 'abandonado'] }, priority: { type: ['integer', 'null'] }, progress: { type: ['integer', 'null'] }, next_step: { type: ['string', 'null'] }, hub: { type: ['string', 'null'] }, github: { type: ['string', 'null'] }, lovable_url: { type: ['string', 'null'] }, steps: { type: ['array', 'null'], items: { type: 'string' } }, current_step: { type: 'integer' }, kanban: { type: ['object', 'null'] }, todos: { type: ['array', 'null'] }, notes: { type: ['string', 'null'] }, post_mortem: { type: ['string', 'null'] } } },
        ProjectPatch: { type: 'object', description: 'Campos do projeto + operações: add_item, column, advance_step, kanban_move {card,from?,to}, todo_toggle, remove_item' },
        Task: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, period: { type: 'string', enum: ['manhã', 'tarde', 'noite'] }, lane: { type: ['string', 'null'] }, project_id: { type: ['string', 'null'] }, date: { type: 'string' }, done: { type: 'boolean' }, carry: { type: 'integer' } } },
        TaskInput: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, period: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD, hoje, amanhã' }, project: { type: 'string' }, lane: { type: 'string' } } },
        Error: { type: 'object', properties: { error: { type: 'string' } } },
      },
    },
    paths: {
      '/api/context': { get: { operationId: 'getContext', summary: 'Contexto consolidado (alertas, projetos ativos, hoje, inbox)', parameters: [q('hub', 'Filtra por hub'), q('format', 'md ou json')], responses: ok({ type: 'object' }) } },
      '/api/items': {
        get: { operationId: 'listItems', summary: 'Lista itens por balde', parameters: [q('bucket', 'inbox|someday|reference|trash|processed|all'), q('hub', 'hub'), q('source', 'origem'), q('q', 'busca'), q('limit', 'máximo', { type: 'integer' })], responses: ok({ type: 'array', items: ref('Item') }) },
        post: { operationId: 'captureItem', summary: 'Captura item(ns) na inbox', requestBody: json({ oneOf: [ref('CaptureInput'), { type: 'array', items: ref('CaptureInput') }] }), responses: { 201: { description: 'Criado', ...json({ type: 'object' }) } } },
      },
      '/api/items/{id}': {
        patch: { operationId: 'updateItem', parameters: [idParam], requestBody: json({ type: 'object' }), responses: ok(ref('Item')) },
        delete: { operationId: 'deleteItem', summary: 'Apaga (só itens no lixo)', parameters: [idParam], responses: ok({ type: 'object' }) },
      },
      '/api/items/{id}/process': { post: { operationId: 'processItem', summary: 'Clarifica item da inbox', parameters: [idParam], requestBody: json(ref('ProcessInput')), responses: ok({ type: 'object' }) } },
      '/api/projects': {
        get: { operationId: 'listProjects', parameters: [q('status', 'status'), q('lane', 'lane'), q('hub', 'hub')], responses: ok({ type: 'array', items: ref('Project') }) },
        post: { operationId: 'createProject', parameters: [q('force', '1 ignora WIP')], requestBody: json(ref('Project')), responses: { 201: { description: 'Criado', ...json(ref('Project')) } } },
      },
      '/api/projects/{id}': {
        get: { operationId: 'getProject', parameters: [idParam], responses: ok(ref('Project')) },
        patch: { operationId: 'updateProject', parameters: [idParam, q('force', '1 ignora WIP')], requestBody: json(ref('ProjectPatch')), responses: ok(ref('Project')) },
        delete: { operationId: 'deleteProject', parameters: [idParam], responses: ok({ type: 'object' }) },
      },
      '/api/tasks': {
        get: { operationId: 'listTasks', parameters: [q('date', 'YYYY-MM-DD'), q('from', 'início'), q('to', 'fim')], responses: ok({ type: 'array', items: ref('Task') }) },
        post: { operationId: 'addTask', requestBody: json(ref('TaskInput')), responses: { 201: { description: 'Criado', ...json(ref('Task')) } } },
      },
      '/api/tasks/{id}': {
        patch: { operationId: 'updateTask', parameters: [idParam], requestBody: json({ type: 'object' }), responses: ok(ref('Task')) },
        delete: { operationId: 'deleteTask', parameters: [idParam], responses: ok({ type: 'object' }) },
      },
      '/api/today': { get: { operationId: 'getToday', summary: 'Tarefas do dia por período', parameters: [q('date', 'YYYY-MM-DD')], responses: ok({ type: 'object' }) } },
      '/api/reviews': { get: { operationId: 'listReviews', responses: ok({ type: 'array' }) } },
      '/api/reviews/{cadence}': { post: { operationId: 'markReview', parameters: [{ name: 'cadence', in: 'path', required: true, schema: { type: 'string' } }], requestBody: json({ type: 'object', properties: { notes: { type: 'string' } } }), responses: ok({ type: 'object' }) } },
      '/api/ingest/{kind}': { post: { operationId: 'ingest', summary: 'Ingestão por fonte (generic, email, gmail, github, text, keep, whatsapp, lovable, n8n, claude, web, drive)', parameters: [{ name: 'kind', in: 'path', required: true, schema: { type: 'string' } }, q('source', 'sobrescreve a origem'), q('hub', 'hub padrão')], requestBody: { content: { 'application/json': { schema: { type: 'object' } }, 'text/plain': { schema: { type: 'string' } } } }, responses: ok({ type: 'object' }) } },
      '/api/events': { get: { operationId: 'listEvents', summary: 'Log de atividade', parameters: [q('since', 'ISO'), q('limit', 'máx', { type: 'integer' }), q('type', 'prefixo')], responses: ok({ type: 'array' }) } },
      '/api/state/{key}': {
        get: { operationId: 'getState', parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }], responses: ok({}) },
        put: { operationId: 'setState', parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }], requestBody: json({}), responses: ok({}) },
      },
      '/api/link/sync': { post: { operationId: 'linkSync', summary: 'Sincronização pelo contrato gtd-link/1 (docs/contrato-ligacao.md)', requestBody: json({ type: 'object', properties: { sistema: { type: 'string', enum: ['diario'] }, mensagens: { type: 'array', items: { type: 'object' } }, confirmados: { type: 'array', items: { type: 'integer' } } } }), responses: ok({ type: 'object' }) } },
      '/api/link/status': { get: { operationId: 'linkStatus', responses: ok({ type: 'object' }) } },
      '/api/link/outbox': { get: { operationId: 'linkOutbox', summary: 'Mensagens do GTD ainda não confirmadas', responses: ok({ type: 'array' }) } },
      '/api/link/log': { get: { operationId: 'linkLog', parameters: [q('limit', 'máx', { type: 'integer' })], responses: ok({ type: 'array' }) } },
      '/api/links': {
        get: { operationId: 'listLinks', parameters: [q('project', 'projeto')], responses: ok({ type: 'array' }) },
        post: { operationId: 'createLink', requestBody: json({ type: 'object', required: ['project', 'ref'], properties: { project: { type: 'string' }, ref: { type: 'string', examples: ['dd:eap:bib:4', 'dd:gate:G3'] } } }), responses: { 201: { description: 'Criado', ...json({ type: 'object' }) } } },
      },
      '/api/links/{id}': { delete: { operationId: 'deleteLink', parameters: [idParam], responses: ok({ type: 'object' }) } },
      '/api/export': { get: { operationId: 'exportAll', responses: ok({ type: 'object' }) } },
      '/api/import': { post: { operationId: 'importAll', parameters: [q('mode', 'merge|replace')], requestBody: json({ type: 'object' }), responses: ok({ type: 'object' }) } },
    },
  };
}
