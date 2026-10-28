# Fontes de captura

Todas as fontes terminam na **Inbox**. Nada é processado automaticamente: a clarificação continua sendo sua
(ou do Claude, com sua confirmação). Itens com o mesmo ID externo (`source_ref`) não são duplicados.

| Fonte | Como | Endpoint |
|---|---|---|
| UI / celular | campo de captura, tecla `c`, `/?capture=texto` | — |
| Qualquer página web | bookmarklet (tela Conectar) | `GET /capture?text=&url=&token=` |
| Claude (qualquer projeto) | ferramenta `gtd_capture` | `POST /mcp` |
| Gmail | `gmail-apps-script.gs` (marcador "GTD") | `POST /api/ingest/gmail` |
| GitHub | webhook do repositório (JSON) | `POST /api/ingest/github?token=` |
| Google Keep / texto | colar lista; 1 linha = 1 item | `POST /api/ingest/keep` (text/plain) |
| WhatsApp | n8n/Evolution/Z-API → HTTP Request | `POST /api/ingest/whatsapp` |
| Lovable | Edge Function (veja `lovable.md`) | `POST /api/items` |
| n8n / Make / Zapier | nó HTTP Request | `POST /api/ingest/n8n` |
| Google Drive | Apps Script ou n8n | `POST /api/ingest/drive` |

Formato genérico (JSON, item ou lista, ou `{items:[…]}`):

```json
{ "text": "Título curto", "notes": "detalhes", "url": "https://…", "hub": "doutorado", "source_ref": "id-externo" }
```

Parâmetros de URL opcionais em `/api/ingest/*`: `source` (sobrescreve a origem) e `hub` (hub padrão).

## n8n — WhatsApp para o GTD

1. Gatilho do seu provedor de WhatsApp (mensagens para você mesmo, ou começando com `gtd:`).
2. **HTTP Request**: POST `https://seu-gtd/api/ingest/whatsapp`, header `Authorization: Bearer <token>`,
   corpo JSON `{"text": "{{$json.message}}", "source_ref": "{{$json.id}}"}`.

## GitHub

Repositório → Settings → Webhooks → Add webhook:
- Payload URL: `https://seu-gtd/api/ingest/github?token=<token>`
- Content type: `application/json`
- Eventos: Issues, Pull requests, Pull request reviews, Issue comments, Pushes, Releases, Workflow runs
- Opcional: defina `GTD_GITHUB_SECRET` no servidor e o mesmo valor em "Secret" para validar a assinatura.

O item herda o `hub` do projeto cujo campo GitHub for igual ao repositório (ex.: `usuario/rsl-xai-mas` → doutorado).
