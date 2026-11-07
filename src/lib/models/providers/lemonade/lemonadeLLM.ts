import OpenAILLM from '../openai/openaiLLM';
import { StructuredReasoning } from '../../utils/reasoningControl';
import { localServerReasoning } from '../lmstudio/reasoning';

class LemonadeLLM extends OpenAILLM {
  protected structuredReasoningRequest(mode: StructuredReasoning) {
    return localServerReasoning(this.config.model, mode);
  }
}

export default LemonadeLLM;
