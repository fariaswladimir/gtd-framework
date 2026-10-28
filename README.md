# ⚙ GTD Framework

Seu GTD pessoal como sistema web: inbox alimentada por várias fontes, 3 lanes com limite de WIP,
tarefas do dia com carry-over automático, cadências de revisão, Roda da Vida, saúde, medicação e links.
Conecta ao **Claude** (MCP) e a outros apps (**Lovable**, n8n, GitHub, Gmail…) via API REST e webhooks.

- **Sem dependências**: só Node.js ≥ 22.13 (usa `node:sqlite` embutido). Nada de `npm install`.
- **Dados**: `data/gtd.db` (SQLite). Configuração (e-mail do dono, senha em hash, token das integrações): `data/config.json`. Os dois ficam fora do git.
- **Projeto isolado**: não depende de nenhuma outra pasta.

## Rodar

```bash
npm start
```

Abra http://127.0.0.1:4317. No primeiro acesso, **neste computador**, a tela pede o e-mail do dono e uma senha nova.

## Acesso e login

- **Só um dono.** Defina o e-mail em `data/config.json` (`"owner_email"`) ou na variável `GTD_OWNER_EMAIL` antes do primeiro acesso. Outro e-mail não entra.
- **Senha** com pelo menos 10 caracteres, guardada como hash scrypt. A criação só é aceita no próprio computador; por túnel ou proxy, não.
- **Sessão** em cookie HttpOnly e SameSite=Strict, válida por 30 dias. Pedidos de outros sites com o cookie são recusados. **Sair** fica no topo.
- **5 tentativas erradas** bloqueiam aquele endereço por 15 minutos.
- **Esqueceu a senha?** Rode `npm run senha` no computador do GTD e reinicie o servidor. Isso também encerra todas as sessões.
- **Integrações** (Claude/MCP, webhooks, Lovable, bookmarklet) continuam usando o **token**, que aparece na tela **Conectar** depois de entrar.
Na primeira execução a base é criada com os dados do artifact original (projetos, inbox, tarefas, cadências, links).
Para começar vazio: `GTD_SEED=0 npm start`.

Para migrar o que estava no artifact: no artifact antigo, clique em **Backup** e depois, aqui, em
**Revisões → Importar JSON**.

```bash
npm test
```

## Como o fluxo funciona

```
Captura ──► Clarificação ──► Organização ──► Reflexão ──► Execução
(fontes)    (inbox: projeto,   (3 lanes, WIP,   (cadências    (tarefas do dia,
             tarefa, feito,     modos, ciclo     D/S/M/T com   3 períodos,
             algum dia, ref,    de vida)         registro)     carry-over)
             lixo)
```

Regras aplicadas pelo servidor (valem para a UI, para o Claude e para qualquer app):
- WIP: Sustento 2 · Paralelos 3 · Sandbox 2 · global 7 (ativar acima disso exige `force`).
- Até 7 tarefas por dia (alerta quando passa).
- Tarefa não concluída vai sozinha para o dia seguinte e acumula dias de carry-over; com 3 ou mais dias, um alerta pede para quebrar, delegar ou descartar.
- Projeto pausado há mais de 60 dias gera alerta; abandonar pede post-mortem.
- Revisões atrasadas aparecem como alerta.

## Arquitetura

```
 Gmail · GitHub · Keep · WhatsApp/n8n · Lovable · bookmarklet · UI · Claude
                 │  REST /api/*   ·   MCP /mcp   ·   /capture
                 ▼
        server/index.mjs ── server/store.mjs ── SQLite (data/gtd.db)
                 │ cada mudança vira um evento (tabela events)
                 ├──► UI web em tempo real (SSE /api/stream)
                 ├──► Claude (gtd_context, gtd_activity…)
                 └──► webhooks de saída (n8n, Lovable/Supabase…)
```

| Pasta | Conteúdo |
|---|---|
| `server/` | HTTP, regras/dados, ingestão, MCP, OpenAPI |
| `public/` | interface web (mesmo visual do artifact) |
| `mcp/stdio-bridge.mjs` | ponte para o Claude Desktop |
| `integrations/` | Gmail Apps Script, Lovable, fontes (n8n, GitHub, WhatsApp) |
| `test/` | testes de ponta a ponta |
| `docs/` | contrato de ligação, esquema JSON e plano de integração (HTML) |
| `EAP.md` | estrutura analítica e status do projeto |

## Conectar ao Claude

**Claude Code** (uma vez; vale para todos os projetos):

```bash
claude mcp add --transport http gtd http://127.0.0.1:4317/mcp --header "Authorization: Bearer SEU_TOKEN"
```

**Claude Desktop**: em `claude_desktop_config.json`:

```json
{ "mcpServers": { "gtd": { "command": "node", "args": ["C:/caminho/para/gtd-framework/mcp/stdio-bridge.mjs"] } } }
```

A ponte lê o token de `data/config.json` e inicia o servidor se ele não estiver rodando.

**claude.ai (conector personalizado)**: depende do servidor publicado com HTTPS. Use a URL
`https://seu-gtd/mcp?token=SEU_TOKEN`.

Ferramentas: `gtd_context` (comece por ela), `gtd_capture`, `gtd_inbox`, `gtd_process`, `gtd_projects`,
`gtd_project_update`, `gtd_project_create`, `gtd_today`, `gtd_task_add`, `gtd_task_update`, `gtd_review`,
`gtd_activity`, `gtd_link_sync`, `gtd_links`. Prompts: `abertura_diaria`, `fechamento_diario`, `processar_inbox`, `revisao_semanal`.

**Hubs**: cada projeto e item pertence a um hub (`edge`, `doutorado`, `side-projects`, `consultoria-dados`,
`consultoria-n8n`, `pessoal`). Nas instruções de cada projeto do Claude, coloque por exemplo:
*"No início da conversa, chame gtd_context com hub=doutorado e capture pendências com gtd_capture."*

## Ingestão geral (vários itens de uma vez)

Na **Inbox → 📥 Ingestão geral**, cole qualquer bloco de texto ou carregue arquivos `.txt`, `.md`, `.csv` ou `.json`.
Clique em **Pré-visualizar**, confira e depois **Capturar**.

- Uma linha = um item (listas `-`, `*`, `1.` e `[ ]` aceitas). No modo **blocos**, uma linha em branco separa os itens: a 1ª linha vira o título e as demais, as notas.
- O primeiro link de cada item vai para o campo de link. Parâmetros de rastreio (`utm_…`) e âncoras são removidos, e o mesmo link não entra duas vezes.
- Link sozinho na linha: com **Buscar o título dos links** marcado, o GTD lê o título da página (até 20 links por vez).
- `#doutorado`, `#edge`, `#pessoal`… definem o hub. Um título `## Doutorado` vale para os itens abaixo dele.
- `- [x]` (já feito) é ignorado.

Pela API: `POST /api/ingest/geral` com `{"text": "...", "mode": "linhas|blocos", "hub": "...", "source": "...", "titulos": true, "dry": true}`
(`dry: true` só mostra a prévia). No Claude: `gtd_capture` com o parâmetro `texto`.

## Entrada por voz

- **No GTD (Chrome ou Edge):** clique em 🎤 ao lado do campo de captura e fale; aperte Enter para capturar.
  Na **Ingestão geral**, clique em **🎤 Ditar** e fale vários itens: diga **"próximo item"** para começar outro
  e **"hashtag doutorado"** (edge, pessoal…) para escolher o hub. Clique de novo para parar e depois em Pré-visualizar.
  O navegador pede permissão do microfone na primeira vez. O reconhecimento é do próprio navegador (o Chrome usa os
  servidores do Google; o Edge, os da Microsoft) e precisa de internet.
- **Em qualquer navegador no Windows:** clique no campo e aperte **Win + H** (ditado do Windows).
- **Celular:** use o microfone do teclado. Com o GTD publicado em HTTPS, atalhos da Siri ou do Google Assistente
  podem abrir `/capture?text=...&token=...` e mandar a fala direto para a inbox.

## Ligação com o Diário do Doutorado

GTD e Diário são sistemas separados, ligados pelo contrato `gtd-link/1` (`docs/contrato-ligacao.md`).
O Diário envia ações, status de EAP/gates e bloqueios; o GTD devolve conclusões e capturas.

- Ligue um projeto a uma referência do Diário: no projeto, **No Diário → Ligar referência** (ex.: `dd:eap:bib:4`, `dd:gate:G3`), ou `POST /api/links`.
- Ações do Diário entram na Inbox (origem Diário, com prazo); as de outras pessoas vão para **Aguardando**.
- Concluir a tarefa gera `acao.concluida`, que fica pendente até o Diário confirmar.
- Itens do hub doutorado podem ser enviados ao Diário (**→ Diário**) como rascunho de entrada.
- Sincronização: `POST /api/link/sync` ou a ferramenta MCP `gtd_link_sync`; log em **Conectar**.

## Conectar outros apps

- **REST + OpenAPI**: `GET /api/openapi.json` (Lovable, GPT Actions, Postman, n8n).
- **Lovable**: veja `integrations/lovable.md` (Edge Function com o token guardado como segredo).
- **Fontes**: veja `integrations/fontes.md` (Gmail, GitHub, Keep, WhatsApp/n8n, bookmarklet).
- **Webhooks de saída**: na tela **Conectar**.

## Publicar (para claude.ai, Lovable, Gmail e GitHub alcançarem o servidor)

Opção rápida, com o servidor rodando no seu computador (túnel HTTPS):

```bash
cloudflared tunnel --url http://127.0.0.1:4317
```

Opção permanente, com Docker em Render, Railway ou Fly.io (monte um volume em `/data`):

```bash
docker build -t gtd-framework .
```

```bash
docker run -p 4317:4317 -v gtd-data:/data -e GTD_TOKEN=um-token-longo gtd-framework
```

Variáveis: `PORT` (4317), `HOST` (127.0.0.1; use 0.0.0.0 em contêiner), `GTD_DATA` (pasta de dados),
`GTD_TOKEN` (sobrepõe o token salvo), `GTD_TZ` (America/Sao_Paulo), `GTD_CORS` (origens permitidas, padrão `*`),
`GTD_GITHUB_SECRET` (valida webhooks do GitHub), `GTD_SEED=0` (base vazia).

> Com o servidor público, o token é a única proteção: use um valor longo e não o coloque em código de front-end.

## API — principais rotas

| Método | Rota | Uso |
|---|---|---|
| GET | `/api/context?hub=&format=md\|json` | resumo do que está em andamento |
| GET/POST | `/api/items` | listar / capturar |
| POST | `/api/items/:id/process` | clarificar (`projeto`, `tarefa`, `feito`, `someday`, `reference`, `trash`, `inbox`) |
| POST | `/api/ingest/:fonte` | ingestão por fonte |
| GET/POST/PATCH/DELETE | `/api/projects[/:id]` | projetos (id ou parte do nome) |
| GET | `/api/today` | tarefas do dia por período |
| GET/POST/PATCH/DELETE | `/api/tasks[/:id]` | tarefas |
| GET/POST | `/api/reviews[/:cadência]` | revisões |
| GET | `/api/events?since=` | log de atividade |
| GET | `/api/stream` | eventos em tempo real (SSE) |
| GET/POST | `/api/export`, `/api/import` | backup |
| POST | `/mcp` | servidor MCP |
