import {
  isGptOss,
  isQwen3,
  NO_REASONING_CHANGE,
  ReasoningRequest,
  StructuredReasoning,
} from '../../utils/reasoningControl';

/**
 * Local OpenAI-compatible servers that render a Jinja chat template (LM
 * Studio, Lemonade / llama.cpp). Off: chat_template_kwargs.enable_thinking
 * = false, plus /no_think for Qwen3 because LM Studio may ignore the kwargs
 * (bug tracker #1990). gpt-oss cannot stop thinking, so it gets effort
 * "low". Low: reasoning_effort "low".
 */
export const localServerReasoning = (
  model: string,
  mode: StructuredReasoning,
): ReasoningRequest => {
  if (mode === 'default') return NO_REASONING_CHANGE;
  if (mode === 'low' || isGptOss(model)) {
    return { params: { reasoning_effort: 'low' } };
  }
  return {
    params: { chat_template_kwargs: { enable_thinking: false } },
    noThink: isQwen3(model),
  };
};
