# EAP — GTD Framework (sistema web)

Projeto isolado na pasta `gtd-framework` (repositório próprio, sem dependências externas).
Objetivo: transformar o artifact "GTD Framework" (localStorage) em um sistema web persistente, com ingestão
multi-fonte, fluxo contínuo e conexão com o Claude (MCP) e com outros apps (Lovable, n8n…) via API.

Legenda: ✅ concluído · 🔄 em andamento · ⏳ pendente

## 1. Núcleo de dados ✅
- 1.1 Modelo de dados SQLite (`node:sqlite`): itens, projetos, tarefas, estado livre, log de eventos ✅
- 1.2 Regras do framework: WIP por lane (2/3/2) e global (7), máx. 7 tarefas/dia, carry-over automático, alerta pausado >60d, post-mortem ao abandonar ✅
- 1.3 Semente com os dados atuais do artifact (17 projetos, 16 itens de inbox, 7 tarefas, cadências, links, saúde/meds) ✅
- 1.4 Backup: exportar/importar (formato novo + migração do JSON do artifact original) ✅

## 2. API e ingestão ✅
- 2.1 API REST com token (inbox, processamento, projetos, tarefas, revisões, estado, contexto) ✅
- 2.2 Ingestão por fonte: genérico, e-mail/Gmail, GitHub (webhook), texto/Keep, WhatsApp, Lovable, n8n, Web ✅
- 2.3 Deduplicação por ID externo; GitHub herda o hub do projeto pelo repositório ✅
- 2.4 Bookmarklet `/capture` e captura via URL (`?capture=`) para atalhos do celular ✅
- 2.5 Tempo real (SSE) e webhooks de saída para outros sistemas ✅
- 2.6 Especificação OpenAPI 3.1 (Lovable, GPT Actions, Postman) ✅
- 2.7 Ingestão geral: colar textos, links e listas misturados (ou carregar .txt/.md/.csv/.json), com pré-visualização, #hub, títulos de hub, título dos links e sem duplicar links ✅ `POST /api/ingest/geral`, painel na Inbox, `gtd_capture texto=` · 8 testes

## 3. Integração com o Claude ✅
- 3.1 Servidor MCP em `/mcp` (12 ferramentas + 4 prompts de cadência) ✅
- 3.2 Ponte stdio para Claude Desktop (sobe o servidor sozinha) ✅
- 3.3 Contexto por hub (edge, doutorado, side-projects, consultoria-dados, consultoria-n8n, pessoal) ✅

## 4. Interface web ✅
- 4.1 Port das telas originais (Dia, Inbox, Lanes, Projetos, Revisões, Roda, Fluxo, Saúde, Meds, Links) ✅
- 4.2 Telas novas: alertas, edição de projetos/etapas/kanban, processados, atividade, Integrações ✅
- 4.3 Verificação no navegador (desktop e celular 375px, sem rolagem horizontal) ✅
- 4.4 Ditado por voz (🎤 na captura e na Ingestão geral; "próximo item" e "hashtag <hub>"; sem suporte → Win + H) ✅ testado com fala simulada; microfone real a confirmar no Chrome/Edge
- 4.5 Tela de login: dono único por e-mail (fora do código), senha scrypt, sessão em cookie, bloqueio após 5 erros, `npm run senha`; token só para integrações ✅ 9 testes
- 4.6 Visual do Atlassian Design System: tokens oficiais (claro e escuro), seletor de tema (automático/claro/escuro), menu lateral no computador com contadores, barra inferior no celular, ícones no lugar de emojis, Lanes e gráficos no padrão ✅ verificado no navegador (claro, escuro, 375px sem rolagem lateral); corrigido travamento ao abrir na Roda da Vida

## 5. Qualidade e entrega ✅
- 5.1 Testes automatizados de ponta a ponta (42/42 passando: API, ingestão geral, ligação e login) ✅
- 5.5 Repositório público no GitHub com dados de exemplo (dados reais só em `data/`, fora do git) 🔄
- 5.2 README + guias de integração (Gmail Apps Script, Lovable, n8n, GitHub) ✅
- 5.3 Dockerfile + roteiro de publicação (HTTPS, para claude.ai e Lovable) ✅ (build não testado: Docker não verificado nesta máquina)
- 5.4 Repositório git inicial (branch main, primeiro commit) ✅

## 6. Próximos passos (fora do escopo atual) ⏳
- 6.1 Publicar com HTTPS: Cloudflare Tunnel no PC (gtd.<domínio>), GTD e túnel iniciando com o Windows (`scripts/iniciar.ps1`) ✅ testado de fora: login exigido, criação de senha recusada pela internet
- 6.2a MCP conectado ao Claude Code (escopo usuário, ponte stdio com partida automática) ✅
- 6.2b Claude Desktop e instruções `gtd_context hub=…` em cada projeto do Claude ⏳
- 6.3 Configurar as fontes (Apps Script do Gmail, webhooks do GitHub, fluxo n8n do WhatsApp)

## 7. Ligação estruturada com o Diário do Doutorado 🔄
Dois sistemas independentes (GTD = execução, Diário = pesquisa), ligados por contrato de mensagens.
Plano: `docs/plano-integracao-diario.html` (https://claude.ai/artifact/Uv1ViLwctzk9dfXT1UbqSb)
- L1 Contrato de ligação v1 (acao.upsert, acao.concluida, marco.status, bloqueio.*, captura.enviada; chaves, dono, conflito) ✅ `docs/contrato-ligacao.md`, `server/link-contract.mjs`
- L2 Ponta do GTD (registro de ligações, /api/link/sync, gtd_link_sync, gtd_links, painel "No Diário", balde Aguardando, "→ Diário", log) ✅ `server/link.mjs` · 17 testes
- L3 Ponta do Diário (caixa de saída, botão Sincronizar com GTD, log) ⏳
- L4 Publicar o GTD com HTTPS + conector no claude.ai ⏳ decisão sua
- L5 Troca de tipo de controle no GTD (Lista, Etapas, Kanban, EAP simples) ⏳ independente
