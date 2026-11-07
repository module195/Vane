import z from 'zod';
import { ClassifierInput } from './types';
import { classifierPrompt } from '@/lib/prompts/search/classifier';
import formatChatHistoryAsString from '@/lib/utils/formatHistory';
import { describeError } from '@/lib/utils/describeError';

const schema = z.object({
  classification: z.object({
    skipSearch: z
      .boolean()
      .describe('Indicates whether to skip the search step.'),
    personalSearch: z
      .boolean()
      .describe('Indicates whether to perform a personal search.'),
    academicSearch: z
      .boolean()
      .describe('Indicates whether to perform an academic search.'),
    discussionSearch: z
      .boolean()
      .describe('Indicates whether to perform a discussion search.'),
    showWeatherWidget: z
      .boolean()
      .describe('Indicates whether to show the weather widget.'),
    showStockWidget: z
      .boolean()
      .describe('Indicates whether to show the stock widget.'),
    showCalculationWidget: z
      .boolean()
      .describe('Indicates whether to show the calculation widget.'),
  }),
  /* Missing or malformed from a small model -> [] (no fast path), so the
     classification itself never fails because of this field. */
  searchQueries: z
    .preprocess((v) => (Array.isArray(v) ? v : []), z.array(z.string()))
    .describe(
      'Up to 3 short keyword web search queries that would answer the standalone question. Empty when skipSearch is true.',
    ),
  standaloneFollowUp: z
    .string()
    .describe(
      "A self-contained, context-independent reformulation of the user's question.",
    ),
});

/* Used when the classifier call fails: search the web for the question
   as typed, with no widgets and no fast path. */
const fallbackClassification = (query: string): z.infer<typeof schema> => ({
  classification: {
    skipSearch: false,
    personalSearch: false,
    academicSearch: false,
    discussionSearch: false,
    showWeatherWidget: false,
    showStockWidget: false,
    showCalculationWidget: false,
  },
  searchQueries: [],
  standaloneFollowUp: query,
});

export const classify = async (input: ClassifierInput) => {
  try {
    return await input.llm.generateObject<typeof schema>({
      messages: [
        {
          role: 'system',
          content: classifierPrompt,
        },
        {
          role: 'user',
          content: `<conversation_history>\n${formatChatHistoryAsString(input.chatHistory)}\n</conversation_history>\n<user_query>\n${input.query}\n</user_query>`,
        },
      ],
      schema,
    });
  } catch (err) {
    console.warn(
      `[search] classifier failed (${describeError(err)}); searching the question as typed`,
    );
    return fallbackClassification(input.query);
  }
};
