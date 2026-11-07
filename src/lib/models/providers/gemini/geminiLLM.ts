import OpenAILLM from '../openai/openaiLLM';
import {
  NO_REASONING_CHANGE,
  StructuredReasoning,
} from '../../utils/reasoningControl';

class GeminiLLM extends OpenAILLM {
  /* Gemini's OpenAI-compatible endpoint maps reasoning_effort to its
     thinking budget; "none" turns thinking off where the model allows it
     (2.5 Pro does not, and its 400 falls back to the default). */
  protected structuredReasoningRequest(mode: StructuredReasoning) {
    if (mode === 'default') return NO_REASONING_CHANGE;
    return { params: { reasoning_effort: mode === 'off' ? 'none' : 'low' } };
  }
}

export default GeminiLLM;
