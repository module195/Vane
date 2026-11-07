import { Tool, ToolCall } from '@/lib/models/types';
import {
  ActionOutput,
  AdditionalConfig,
  ClassifierOutput,
  ResearchAction,
  SearchAgentConfig,
  SearchSources,
} from '../../types';

class ActionRegistry {
  private static actions: Map<string, ResearchAction> = new Map();

  static register(action: ResearchAction<any>) {
    this.actions.set(action.name, action);
  }

  static unregisterWhere(predicate: (name: string) => boolean) {
    for (const name of Array.from(this.actions.keys())) {
      if (predicate(name)) this.actions.delete(name);
    }
  }

  static get(name: string): ResearchAction | undefined {
    return this.actions.get(name);
  }

  static getAvailableActions(config: {
    classification: ClassifierOutput;
    fileIds: string[];
    mode: SearchAgentConfig['mode'];
    sources: SearchSources[];
  }): ResearchAction[] {
    return Array.from(
      this.actions.values().filter((action) => action.enabled(config)),
    );
  }

  static getAvailableActionTools(config: {
    classification: ClassifierOutput;
    fileIds: string[];
    mode: SearchAgentConfig['mode'];
    sources: SearchSources[];
  }): Tool[] {
    const availableActions = this.getAvailableActions(config);

    return availableActions.map((action) => ({
      name: action.name,
      description: action.getToolDescription({ mode: config.mode }),
      schema: action.schema,
    }));
  }

  static getAvailableActionsDescriptions(config: {
    classification: ClassifierOutput;
    fileIds: string[];
    mode: SearchAgentConfig['mode'];
    sources: SearchSources[];
  }): string {
    const availableActions = this.getAvailableActions(config);

    return availableActions
      .map(
        (action) =>
          `<tool name="${action.name}">\n${action.getDescription({ mode: config.mode })}\n</tool>`,
      )
      .join('\n\n');
  }

  static async execute(
    name: string,
    params: any,
    additionalConfig: AdditionalConfig & {
      researchBlockId: string;
      fileIds: string[];
      mode: SearchAgentConfig['mode'];
    },
  ): Promise<ActionOutput> {
    const action = this.actions.get(name);

    /* A made-up tool name or a tool that throws used to fail the whole
       answer. Tell the model instead, so it can go on with other tools.
       Only the error type is reported: messages can carry the query. */
    if (!action) {
      console.warn(`[research] model called unknown tool "${name}"`);
      return {
        type: 'search_results',
        results: [],
        note: `There is no tool named "${name}". Use only the tools you were given.`,
      };
    }

    try {
      return await action.execute(params, additionalConfig);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      const kind = err instanceof Error ? err.name : typeof err;
      console.warn(`[research] tool "${name}" failed: ${kind}`);
      return {
        type: 'search_results',
        results: [],
        note: `The tool "${name}" failed (${kind}). Try a different tool or arguments.`,
      };
    }
  }

  static async executeAll(
    actions: ToolCall[],
    additionalConfig: AdditionalConfig & {
      researchBlockId: string;
      fileIds: string[];
      mode: SearchAgentConfig['mode'];
    },
  ): Promise<ActionOutput[]> {
    /* Results must come back in call order: the researcher pairs
       results[i] with the tool call at the same index. Pushing in
       completion order mixed up results between parallel calls. */
    return Promise.all(
      actions.map((actionConfig) =>
        this.execute(
          actionConfig.name,
          actionConfig.arguments,
          additionalConfig,
        ),
      ),
    );
  }
}

export default ActionRegistry;
