# Contrato de ligação `gtd-link/1`

Liga o **GTD** (dono da execução) a sistemas externos, começando pelo **Diário do Doutorado** (dono da pesquisa).
Os dois continuam independentes: nenhum lê o banco do outro. Eles trocam só as mensagens abaixo.

- Validador: `server/link-contract.mjs` · Esquema JSON: `docs/contrato-ligacao.schema.json`
- Rota: `POST /api/link/sync` · Ferramenta MCP: `gtd_link_sync`

## Envelope

```json
{
  "contrato": "gtd-link/1",
  "tipo": "acao.upsert",
  "chave": "dd:acao:7f3a",
  "alterado_em": "2026-10-17T14:20:00Z",
  "ligado_a": "dd:eap:bib:4_2_3",
  "dados": { }
}
```

| Campo | Regra |
|---|---|
| `contrato` | sempre `gtd-link/1` |
| `tipo` | um dos 6 tipos abaixo |
| `chave` | identificador estável no sistema dono (formato por tipo) |
| `alterado_em` | data-hora ISO 8601 com fuso; decide conflitos |
| `ligado_a` | opcional: nó de EAP (`dd:eap:<árvore>:<código com _>`) ou gate (`dd:gate:<id>`) |
| `dados` | campos do tipo |

## Tipos

| Tipo | Enviado por | Dono | `chave` | `dados` | Efeito no destino |
|---|---|---|---|---|---|
| `acao.upsert` | Diário | Diário | `dd:acao:<id>` | `texto`*, `responsavel`, `prazo` (AAAA-MM-DD), `estado` (aberta, feita, cancelada) | Responsável "eu" (ou vazio): item na **Inbox** do GTD (origem Diário, prazo nas notas). Outro responsável: balde **Aguardando**. `feita`/`cancelada`: fecha o que existir no GTD. |
| `acao.concluida` | GTD | GTD | `dd:acao:<id>` | `concluida_em`* | O Diário marca a ação como feita |
| `marco.status` | Diário | Diário | `dd:eap:…` ou `dd:gate:…` | `titulo`*, `status`, `progresso` (0–100), `decisao`, `gate_em_foco`, `proximo_marco`, `pendencias` | Painel "No Diário" (somente leitura) nos projetos ligados a essa referência |
| `bloqueio.aberto` | Diário | Diário | `dd:bloqueio:<id>` | `texto`* | Alerta no GTD (hub do projeto ligado, ou doutorado) |
| `bloqueio.fechado` | Diário | Diário | `dd:bloqueio:<id>` | — | Encerra o alerta |
| `captura.enviada` | GTD | Diário | `gtd:item:<id>` | `texto`*, `notas`, `url` | Rascunho de entrada no Diário; só vira registro quando você confirma lá |

\* obrigatório

## Regras

1. **Dono decide.** Cada tipo só é aceito de quem o envia na tabela; o resto é recusado com motivo.
2. **Idempotência.** A mesma `chave` com o mesmo `alterado_em` (ou mais antigo) não muda nada: resultado `ignorado`.
3. **Conflito.** Vale o `alterado_em` mais recente do dono. O GTD guarda o último aplicado por chave.
4. **Ações seguem o fluxo GTD.** Uma ação do Diário entra na Inbox; você a clarifica (normalmente em tarefa). Quando a tarefa é concluída, ou o item é marcado "feito", o GTD gera `acao.concluida`. Reabrir a tarefa, descartar o item ou mandá-lo para Algum Dia não é propagado: cancelar uma ação é decisão do Diário.
5. **Sem eco.** Quando o Diário diz que a ação está feita, o GTD fecha a tarefa sem gerar `acao.concluida` de volta.
6. **Entrega garantida.** Mensagens do GTD ficam na caixa de saída e voltam em toda sincronização até o Diário confirmá-las por `id` em `confirmados`.
7. **Ligações.** Um projeto do GTD liga-se a uma ou mais referências do Diário. `ligado_a` cobre descendentes: `dd:eap:bib:4` cobre `dd:eap:bib:4_2_3`. Vale a ligação mais específica.

## Sincronização

Requisição (Diário → GTD):

```json
{ "sistema": "diario",
  "mensagens": [ { "contrato": "gtd-link/1", "tipo": "acao.upsert", "...": "..." } ],
  "confirmados": [12, 13] }
```

Resposta:

```json
{ "contrato": "gtd-link/1",
  "aplicadas": [ { "chave": "dd:acao:7f3a", "tipo": "acao.upsert", "resultado": "criado", "gtd_id": "i_9c0e11aa" } ],
  "pendentes": [ { "id": 14, "contrato": "gtd-link/1", "tipo": "acao.concluida", "chave": "dd:acao:7f3a", "alterado_em": "…", "dados": { "concluida_em": "…" } } ],
  "servidor_em": "2026-10-18T09:00:00Z" }
```

`resultado`: `criado`, `atualizado`, `ignorado` (repetida ou mais antiga) ou `recusado` (com `motivo`).
Tudo fica no log de ligação (`GET /api/link/log`).
