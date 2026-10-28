# Conectar apps Lovable ao GTD

O GTD expõe uma API REST com CORS liberado e autenticação por token. Qualquer app Lovable pode
**capturar** itens na inbox, **ler o contexto** (o que está em andamento) e **reagir a mudanças** (webhooks).

> O app Lovable roda em `https://….lovable.app`. Para ele alcançar o GTD, o servidor precisa estar
> publicado com HTTPS (veja README → Publicar). `http://127.0.0.1` só funciona enquanto você testa no
> seu próprio computador.

## 1. Guarde o token como segredo

Não coloque o token no código do front-end publicado. No Lovable, conecte o Supabase e crie uma
**Edge Function** com os segredos `GTD_URL` e `GTD_TOKEN`; o front chama a função, e a função chama o GTD.

## 2. Prompt pronto para o Lovable

```
Crie uma Supabase Edge Function chamada "gtd" que repassa requisições para a API do meu GTD.
Segredos: GTD_URL e GTD_TOKEN. A função recebe {action, payload}:
- action "capture": POST {GTD_URL}/api/items com payload {text, notes?, url?, hub?} e source "Lovable"
- action "context": GET {GTD_URL}/api/context?format=json&hub={payload.hub}
- action "projects": GET {GTD_URL}/api/projects?status=ativo
Sempre envie o header Authorization: Bearer {GTD_TOKEN}.
Depois adicione no app um botão "Enviar para meu GTD" que chama a função com action "capture".
A especificação completa está em {GTD_URL}/api/openapi.json.
```

## 3. Edge Function (Deno) — referência

```ts
// supabase/functions/gtd/index.ts
const GTD_URL = Deno.env.get('GTD_URL')!;
const GTD_TOKEN = Deno.env.get('GTD_TOKEN')!;
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' };

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  const { action, payload = {} } = await req.json();
  const h = { Authorization: `Bearer ${GTD_TOKEN}`, 'Content-Type': 'application/json' };
  let r: Response;
  if (action === 'capture') r = await fetch(`${GTD_URL}/api/items`, { method: 'POST', headers: h, body: JSON.stringify({ ...payload, source: 'Lovable' }) });
  else if (action === 'context') r = await fetch(`${GTD_URL}/api/context?format=json${payload.hub ? `&hub=${payload.hub}` : ''}`, { headers: h });
  else if (action === 'projects') r = await fetch(`${GTD_URL}/api/projects?status=ativo`, { headers: h });
  else return new Response(JSON.stringify({ error: 'ação inválida' }), { status: 400, headers: cors });
  return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
});
```

## 4. Receber eventos do GTD no app

Na tela **Conectar → Webhooks de saída**, adicione a URL de uma Edge Function. A cada mudança o GTD envia:

```json
{ "event": "item.captured", "ts": "2026-10-17T12:00:00Z", "entity_id": "i_ab12cd34", "summary": "Lovable: …", "data": { } }
```

Tipos: `item.captured`, `item.processed`, `item.updated`, `project.created`, `project.updated`,
`task.created`, `task.updated`, `task.rollover`, `review.done`, `state.updated`, `import.done`.
