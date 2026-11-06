import { ResearcherOutput, SearchAgentInput } from './types';
import SessionManager from '@/lib/session';
import { classify } from './classifier';
import Researcher from './researcher';
import { getWriterPrompt } from '@/lib/prompts/search/writer';
import { WidgetExecutor } from './widgets';
import { fitWriterSources, formatSearchResult } from './writerContext';
import db from '@/lib/db';
import { messages } from '@/lib/db/schema';
import { and, eq, gt } from 'drizzle-orm';
import { Message, TextBlock } from '@/lib/types';
import { getTokenCount } from '@/lib/utils/splitText';
import {
  isScopeAborted,
  runWithAbortSignal,
  throwIfScopeAborted,
} from '@/lib/abortScope';
import generateSuggestions from '@/lib/agents/suggestions';

class SearchAgent {
  /* Runs under the session's abort signal: LLM calls, searches and page
     downloads started by any stage stop when the session is cancelled. */
  async searchAsync(session: SessionManager, input: SearchAgentInput) {
    return runWithAbortSignal(session.signal, () =>
      this.runSearch(session, input),
    );
  }

  private async runSearch(session: SessionManager, input: SearchAgentInput) {
    try {
      await this._searchAsync(session, input);
    } catch (err) {
      if (session.signal?.aborted) {
        await this.saveCancelled(session, input);
        return;
      }
      console.error('SearchAgent error:', err);
      session.emit('error', {
        data:
          err instanceof Error
            ? err.message
            : 'An unknown error occurred during search',
      });
      await this.saveFailure(session, input);
    }
  }

  /* The user stopped the answer (or nobody listened for a long time):
     end the stream normally and keep what was produced so far, under the
     existing 'completed' status (no new status, no schema change). */
  private async saveCancelled(
    session: SessionManager,
    input: SearchAgentInput,
  ) {
    session.emit('end', {});
    try {
      await db
        .update(messages)
        .set({
          status: 'completed',
          responseBlocks: session.getAllBlocks(),
        })
        .where(
          and(
            eq(messages.chatId, input.chatId),
            eq(messages.messageId, input.messageId),
          ),
        )
        .execute();
    } catch (dbErr) {
      console.error('SearchAgent: failed to save cancelled answer:', dbErr);
    }
  }

  /* Persists the error status and the blocks produced so far, so a failed
     answer does not stay 'answering' forever in the chat history. */
  private async saveFailure(session: SessionManager, input: SearchAgentInput) {
    try {
      await db
        .update(messages)
        .set({
          status: 'error',
          responseBlocks: session.getAllBlocks(),
        })
        .where(
          and(
            eq(messages.chatId, input.chatId),
            eq(messages.messageId, input.messageId),
          ),
        )
        .execute();
    } catch (dbErr) {
      console.error('SearchAgent: failed to save error status:', dbErr);
    }
  }

  private async _searchAsync(session: SessionManager, input: SearchAgentInput) {
    const exists = await db.query.messages.findFirst({
      where: and(
        eq(messages.chatId, input.chatId),
        eq(messages.messageId, input.messageId),
      ),
    });

    if (!exists) {
      await db.insert(messages).values({
        chatId: input.chatId,
        messageId: input.messageId,
        backendId: session.id,
        query: input.followUp,
        createdAt: new Date().toISOString(),
        status: 'answering',
        responseBlocks: [],
      });
    } else {
      await db
        .delete(messages)
        .where(
          and(eq(messages.chatId, input.chatId), gt(messages.id, exists.id)),
        )
        .execute();
      await db
        .update(messages)
        .set({
          status: 'answering',
          backendId: session.id,
          responseBlocks: [],
        })
        .where(
          and(
            eq(messages.chatId, input.chatId),
            eq(messages.messageId, input.messageId),
          ),
        )
        .execute();
    }

    const classification = await classify({
      chatHistory: input.chatHistory,
      enabledSources: input.config.sources,
      query: input.followUp,
      llm: input.config.llm,
    });

    throwIfScopeAborted();

    const widgetPromise = WidgetExecutor.executeAll({
      classification,
      chatHistory: input.chatHistory,
      followUp: input.followUp,
      llm: input.config.llm,
    }).then((widgetOutputs) => {
      widgetOutputs.forEach((o) => {
        session.emitBlock({
          id: crypto.randomUUID(),
          type: 'widget',
          data: {
            widgetType: o.type,
            params: o.data,
          },
        });
      });
      return widgetOutputs;
    });

    let searchPromise: Promise<ResearcherOutput> | null = null;

    if (!classification.classification.skipSearch) {
      const researcher = new Researcher();
      searchPromise = researcher.research(session, {
        chatHistory: input.chatHistory,
        followUp: input.followUp,
        classification: classification,
        config: input.config,
      });
    }

    const [widgetOutputs, searchResults] = await Promise.all([
      widgetPromise,
      searchPromise,
    ]);

    session.emit('data', {
      type: 'researchComplete',
    });

    const widgetContext = widgetOutputs
      .map((o) => {
        return `<result>${o.llmContext}</result>`;
      })
      .join('\n-------------\n');

    const wrapContext = (results: string) =>
      `<search_results note="These are the search results and assistant can cite these">\n${results}\n</search_results>\n<widgets_result noteForAssistant="Its output is already showed to the user, assistant can use this information to answer the query but do not CITE this as a souce">\n${widgetContext}\n</widgets_result>`;

    const writerMessages: Message[] = [
      ...input.chatHistory,
      {
        role: 'user',
        content: input.followUp,
      },
    ];

    let finalContext =
      '<Query to be answered without searching; Search not made>';

    if (searchResults) {
      const findings = await fitWriterSources({
        findings: searchResults.searchFindings,
        llm: input.config.llm,
        mode: input.config.mode,
        promptWithoutSources: getWriterPrompt(
          wrapContext(''),
          input.config.systemInstructions,
          input.config.mode,
          classification.classification.skipSearch,
        ),
        messages: writerMessages,
      });

      finalContext = findings.map(formatSearchResult).join('\n');
    }

    const finalContextWithWidgets = wrapContext(finalContext);

    const writerPrompt = getWriterPrompt(
      finalContextWithWidgets,
      input.config.systemInstructions,
      input.config.mode,
      classification.classification.skipSearch,
    );

    const answerStream = input.config.llm.streamText({
      messages: [
        {
          role: 'system',
          content: writerPrompt,
        },
        ...writerMessages,
      ],
    });

    let responseBlockId = '';

    for await (const chunk of answerStream) {
      // Leaving the loop closes the provider's stream as well.
      throwIfScopeAborted();
      if (!responseBlockId) {
        const block: TextBlock = {
          id: crypto.randomUUID(),
          type: 'text',
          data: chunk.contentChunk,
        };

        session.emitBlock(block);

        responseBlockId = block.id;
      } else {
        // Providers end with an empty finish_reason chunk; it adds no text,
        // and appendBlockText skips it.
        session.appendBlockText(responseBlockId, chunk.contentChunk);
      }
    }

    throwIfScopeAborted();

    // The answer is done: the client stops loading now, while the
    // follow-up suggestions are generated on the same stream.
    session.emit('data', { type: 'answerEnd' });
    await this.saveCompleted(session, input);

    if (await this.emitSuggestions(session, input)) {
      await this.saveCompleted(session, input);
    }

    session.emit('end', {});
  }

  private async saveCompleted(
    session: SessionManager,
    input: SearchAgentInput,
  ) {
    await db
      .update(messages)
      .set({
        status: 'completed',
        responseBlocks: session.getAllBlocks(),
      })
      .where(
        and(
          eq(messages.chatId, input.chatId),
          eq(messages.messageId, input.messageId),
          // A rewrite of this message may have started meanwhile (the
          // suggestions run after answerEnd): never overwrite its row.
          eq(messages.backendId, session.id),
        ),
      )
      .execute();
  }

  /* Follow-up suggestions, generated right after the writer instead of
     by a second request the client made after messageEnd (one HTTP round
     trip and one model-list lookup earlier). Same rule and same input as
     before: only when the answer has sources, from the chat history plus
     this question and answer. They need the final answer, so they cannot
     run alongside the writer. A failure sends an empty list (no retry from
     the client); returns whether a suggestion block was emitted. */
  private async emitSuggestions(
    session: SessionManager,
    input: SearchAgentInput,
  ): Promise<boolean> {
    const blocks = session.getAllBlocks();
    const hasSources = blocks.some(
      (b) => b.type === 'source' && b.data.length > 0,
    );
    if (!hasSources) return false;

    const answer = blocks.find((b) => b.type === 'text')?.data || '';

    let suggestions: string[] = [];
    try {
      suggestions = await generateSuggestions(
        {
          chatHistory: [
            ...input.chatHistory,
            { role: 'user', content: input.followUp },
            { role: 'assistant', content: answer },
          ],
        },
        input.config.llm,
      );
    } catch (err) {
      if (isScopeAborted()) return false;
      console.error('SearchAgent: failed to generate suggestions:', err);
    }

    session.emitBlock({
      id: crypto.randomUUID(),
      type: 'suggestion',
      data: Array.isArray(suggestions) ? suggestions : [],
    });
    return true;
  }
}

export default SearchAgent;
