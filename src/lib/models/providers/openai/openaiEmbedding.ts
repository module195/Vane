import OpenAI from 'openai';
import BaseEmbedding from '../../base/embedding';
import { Chunk } from '@/lib/types';

type OpenAIConfig = {
  apiKey: string;
  model: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
};

/* The openai SDK asks for base64 when encoding_format is unset and then
   decodes the reply as packed float32. LM Studio (and other OpenAI-compatible
   servers) ignore encoding_format and send plain float arrays, which that
   decoding turns into all-zero vectors: every similarity becomes 0, so the
   relevance filter, the dedup and the passage ranking silently stop working.
   Asking for floats explicitly makes the SDK return the reply as is. */
const ENCODING_FORMAT = 'float' as const;

class OpenAIEmbedding extends BaseEmbedding<OpenAIConfig> {
  openAIClient: OpenAI;

  constructor(protected config: OpenAIConfig) {
    super(config);

    this.openAIClient = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      defaultHeaders: config.defaultHeaders,
    });
  }

  async embedText(texts: string[]): Promise<number[][]> {
    const response = await this.openAIClient.embeddings.create({
      model: this.config.model,
      input: texts,
      encoding_format: ENCODING_FORMAT,
    });

    return response.data.map((embedding) => embedding.embedding);
  }

  async embedChunks(chunks: Chunk[]): Promise<number[][]> {
    const response = await this.openAIClient.embeddings.create({
      model: this.config.model,
      input: chunks.map((c) => c.content),
      encoding_format: ENCODING_FORMAT,
    });

    return response.data.map((embedding) => embedding.embedding);
  }
}

export default OpenAIEmbedding;
