# ADR 0002: Controle do raciocínio por chamada e por provedor

- **Status:** Proposta
- **Data:** 07/11/2026
- **Relacionados:** `improvements.md` G1-02, G1-06; `llm-inventory.md` §0, §4.6-4.7; `benchmark-2026-11-07.md` §2

## Contexto

Na rodada de 07/11 (qwen3.6-35b-a3b no LM Studio), 86% dos tokens gerados foram raciocínio, descartado pelo app. O classificador levou 43 s em média; um cálculo de 15% levou 49 s. O raciocínio só é desligado no Ollama, com `think: false` quando o nome do modelo contém um item de uma lista fixa (`ollamaLLM.ts:44-53,118,174,225,267`). OpenAI, Anthropic, Gemini, Groq, LM Studio, Lemonade e Bifrost estendem ou instanciam `OpenAILLM`, que não manda nada (`llm-inventory.md` §3). O teto de 8.192 do `generateObject` (`objectDefaults.ts:18`, `openaiLLM.ts:262-265`) conta os tokens de pensamento no LM Studio, então um modelo que pensa muito pode cortar o JSON.

`GenerateOptions` existe mas está morto: nenhum provedor e nenhum ponto de chamada o preenchem (`llm-inventory.md` §4.1). As 13 chamadas LLM usam o mesmo modelo (`llm-inventory.md` §0).

A Perplexity fixa o raciocínio por nível: `none` no `fast`, `minimal` no `low`, `medium` no `medium`/`high`, `high` no `xhigh` ([effort]). O GPT 5.6 recusa `reasoning_effort` junto com ferramentas (upstream #1173).

## Opções

### A. Nada no código; o usuário ajusta o template do modelo
- Prós: zero código; nenhuma regressão possível.
- Contras: liga ou desliga para todas as etapas, inclusive o redator; quase ninguém sabe fazer; não resolve Gemini nem Groq.

### B. `/no_think` (ou equivalente) no prompt das etapas estruturadas
- Prós: uma linha por prompt; funciona no Qwen3 em qualquer servidor.
- Contras: específico de família de modelo; outros modelos leem a instrução como texto; mexe em todos os prompts.

### C. Intenção por chamada (`reasoning: 'off' | 'low' | 'default'`), traduzida por provedor
- Prós: cada etapa declara o que precisa; cada provedor sabe o seu parâmetro (Ollama `think`, OpenAI e Gemini `reasoning_effort`, llama.cpp/LM Studio `chat_template_kwargs.enable_thinking`, Groq `reasoning_effort`/`reasoning_format`, e `/no_think` como último recurso no Qwen3); padrão "default" = comportamento atual; dá para desligar por env.
- Contras: matriz de provedor × modelo para manter; um parâmetro desconhecido pode dar 400 em servidor estrito; a tradução exata por provedor precisa ser confirmada.

### D. Modelo separado sem raciocínio para as etapas estruturadas
- Prós: o efeito mais forte; independe de parâmetro.
- Contras: é funcionalidade nova (configuração, UI, carga de dois modelos na GPU); muda o modelo efetivo das etapas, o que pede aprovação. Está em `improvements.md` G3-03.

## Decisão proposta

**C**, aplicada primeiro às chamadas `generateObject` (classificador, widgets, mídia, sugestões, seletor e extrator), que não usam ferramentas. Pesquisador e redator ficam em "default" até o eval dizer outra coisa.

Detalhes:
1. Campo opcional em `GenerateObjectInput` e `GenerateTextInput` (`models/types.ts:52-75`).
2. Tradução por provedor num só lugar por classe; a lista do Ollama passa a aceitar acréscimos por env.
3. Um erro 400 que cite o parâmetro faz uma nova tentativa sem ele, e o provedor é lembrado em memória.
4. Env `LLM_STRUCTURED_REASONING` (`default` | `off` | `low`), com padrão `default`. Mudar o padrão para `off` só depois do eval e com aprovação do usuário.
5. Com raciocínio ligado, o teto de saída do `generateObject` ganha folga (ou o teto passa a valer só para o conteúdo, onde o servidor separa `reasoning_content`).

## Consequências

- **Positivas:** o maior ganho de latência disponível sem trocar de modelo (estimado em minutos por bateria; a medir); menos JSON cortado pelo teto.
- **Negativas:** possível queda de qualidade em classificação e extração com modelos que dependem do pensamento; matriz de compatibilidade para manter.
- **A medir:** tokens de raciocínio, TTFT e tempo por etapa (`improvements.md` G1-01), com `default` e `off`, no LM Studio do usuário; taxa de JSON inválido; notas do eval por modo.
- **Gate:** eval da Fase 5 nos três modos; aprovação do usuário para mudar o padrão.

[effort]: https://docs.perplexity.ai/docs/agent-api/effort.md
