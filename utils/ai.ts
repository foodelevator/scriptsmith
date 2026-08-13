import {
  addPageScript,
  getPageScript,
  updatePageScript,
  type PageScript,
} from './scripts';

export const API_KEY_STORAGE_KEY = 'openaiApiKey';
export const DEFAULT_OPENAI_MODEL = 'gpt-5.6-sol';
const OPENAI_TIMEOUT_MS = 60_000;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ScriptChatRequest {
  apiKey: string;
  origin: string;
  scriptId: string;
  creating: boolean;
  messages: ChatMessage[];
}

export interface ScriptChatResponse {
  message: string;
  script: PageScript;
}

export interface ScriptChatCallbacks {
  onTextDelta?(delta: string): void;
  onThinkingStart?(itemId: string): void;
  onThinkingDone?(itemId: string): void;
  onToolCall?(callId: string, name: string): void;
  onToolResult?(callId: string): void;
}

type ResponseInputItem = Record<string, unknown>;

type ToolCall = ResponseInputItem & {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
};

type ResponseOutputItem = ResponseInputItem & {
  type?: string;
  content?: unknown;
};

interface OpenAiResponse {
  output?: ResponseOutputItem[];
  output_text?: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string } | null;
}

const tools = [
  {
    type: 'function',
    name: 'edit_script',
    description:
      'Edit the script with an exact text replacement. old_text must occur exactly once. Use an empty old_text only when the script is empty and you are setting its initial content.',
    parameters: {
      type: 'object',
      properties: {
        old_text: { type: 'string' },
        new_text: { type: 'string' },
      },
      required: ['old_text', 'new_text'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'set_name',
    description: 'Set the short, human-readable name of the script.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'set_description',
    description: 'Set a concise description of what the script does.',
    parameters: {
      type: 'object',
      properties: { description: { type: 'string' } },
      required: ['description'],
      additionalProperties: false,
    },
    strict: true,
  },
] as const;

function systemPrompt(script: PageScript, creating: boolean): string {
  const metadataInstruction = creating
    ? 'This script is being created. You MUST set a useful name and description with the tools, in addition to editing its code, before saying the task is complete. This remains mandatory on every turn while creating the script: if the current name is still "Untitled script" or the description is still the placeholder, set them now.'
    : 'This is an existing script. Do not change its name or description unless the user explicitly asks you to do so.';

  return `You are Vibext, an agent that writes JavaScript user scripts for a browser extension. The script runs at document_idle on pages whose exact origin is ${script.origin}. Help the user over multiple turns and use tools whenever a requested change should be made. Make targeted edits with edit_script; you may call it multiple times. Do not merely paste proposed code when you can edit the script. Avoid external libraries unless the user requests them. The script may run again after reload, so make DOM changes idempotent and account for dynamically added content when appropriate.

${metadataInstruction}

Current script:
Name: ${script.name}
Description: ${script.description}
Code:
\`\`\`javascript
${script.code}
\`\`\``;
}

function parseArguments(call: ToolCall): Record<string, unknown> {
  try {
    const value = JSON.parse(call.arguments);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Tool arguments must be an object.');
    }
    return value as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `The model returned invalid arguments for ${call.name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function requiredString(
  args: Record<string, unknown>,
  key: string,
  toolName: string,
): string {
  const value = args[key];
  if (typeof value !== 'string') {
    throw new Error(`${toolName} requires a string ${key}.`);
  }
  return value;
}

function replaceExactlyOnce(content: string, oldText: string, newText: string): string {
  if (oldText === '') {
    if (content !== '') throw new Error('Empty old_text can only be used on an empty script.');
    return newText;
  }

  const first = content.indexOf(oldText);
  if (first === -1) throw new Error('old_text was not found in the current script.');
  if (content.indexOf(oldText, first + oldText.length) !== -1) {
    throw new Error('old_text occurs more than once; include more surrounding text.');
  }
  return `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`;
}

async function useTool(script: PageScript, call: ToolCall): Promise<PageScript> {
  const args = parseArguments(call);

  switch (call.name) {
    case 'edit_script':
      return updatePageScript(script, {
        code: replaceExactlyOnce(
          script.code,
          requiredString(args, 'old_text', 'edit_script'),
          requiredString(args, 'new_text', 'edit_script'),
        ),
      });
    case 'set_name': {
      const name = requiredString(args, 'name', 'set_name').trim();
      if (!name) throw new Error('The script name cannot be empty.');
      return updatePageScript(script, { name });
    }
    case 'set_description': {
      const description = requiredString(
        args,
        'description',
        'set_description',
      ).trim();
      if (!description) throw new Error('The script description cannot be empty.');
      return updatePageScript(script, { description });
    }
    default:
      throw new Error(`Unknown tool: ${call.name}`);
  }
}

function toolCallKey(item: Record<string, unknown>): string | null {
  if (typeof item.call_id === 'string') return item.call_id;
  if (typeof item.id === 'string') return item.id;
  return null;
}

async function readResponseStream(
  response: Response,
  callbacks: ScriptChatCallbacks,
): Promise<OpenAiResponse> {
  if (!response.body) throw new Error('OpenAI returned an empty response stream.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const announcedTools = new Set<string>();
  const announcedReasoning = new Set<string>();
  let buffer = '';
  let completed: OpenAiResponse | null = null;
  let streamedText = false;

  const handleEvent = (frame: string): void => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return;

    const event = JSON.parse(data) as Record<string, unknown>;
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      streamedText = true;
      callbacks.onTextDelta?.(event.delta);
    }

    if (
      event.type === 'response.output_item.added' ||
      event.type === 'response.output_item.done'
    ) {
      const item = event.item;
      if (item && typeof item === 'object') {
        const outputItem = item as Record<string, unknown>;
        const key = toolCallKey(outputItem);
        if (
          event.type === 'response.output_item.added' &&
          outputItem.type === 'reasoning' &&
          key &&
          !announcedReasoning.has(key)
        ) {
          announcedReasoning.add(key);
          callbacks.onThinkingStart?.(key);
        }
        if (
          event.type === 'response.output_item.done' &&
          outputItem.type === 'reasoning' &&
          key
        ) {
          callbacks.onThinkingDone?.(key);
        }
        if (
          event.type === 'response.output_item.added' &&
          outputItem.type === 'function_call' &&
          typeof outputItem.name === 'string' &&
          key &&
          !announcedTools.has(key)
        ) {
          announcedTools.add(key);
          callbacks.onToolCall?.(key, outputItem.name);
        }
      }
    }

    if (event.type === 'response.completed' && event.response) {
      completed = event.response as OpenAiResponse;
    }
    if (event.type === 'response.failed') {
      const failed = event.response as OpenAiResponse | undefined;
      throw new Error(failed?.error?.message ?? 'OpenAI could not complete the response.');
    }
    if (event.type === 'response.incomplete') {
      const incomplete = event.response as OpenAiResponse | undefined;
      throw new Error(
        `OpenAI returned an incomplete response${incomplete?.incomplete_details?.reason ? `: ${incomplete.incomplete_details.reason}` : '.'}`,
      );
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? '';
    for (const frame of frames) handleEvent(frame);
    if (done) break;
  }
  if (buffer.trim()) handleEvent(buffer);
  if (!completed) throw new Error('OpenAI closed the response stream unexpectedly.');
  const finalResponse = completed as OpenAiResponse;

  for (const item of finalResponse.output ?? []) {
    if (!isToolCall(item)) continue;
    const key = toolCallKey(item);
    if (key && !announcedTools.has(key)) callbacks.onToolCall?.(key, item.name);
  }
  if (!streamedText) {
    const text = outputText(finalResponse);
    if (text) callbacks.onTextDelta?.(text);
  }

  return finalResponse;
}

async function createResponse(
  apiKey: string,
  instructions: string,
  input: ResponseInputItem[],
  callbacks: ScriptChatCallbacks,
): Promise<OpenAiResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  let response: Response;

  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: DEFAULT_OPENAI_MODEL,
        instructions,
        input,
        tools,
        tool_choice: 'auto',
        reasoning: { effort: 'low' },
        store: false,
        // Required when statelessly passing reasoning items back after tools.
        include: ['reasoning.encrypted_content'],
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as OpenAiResponse | null;
      throw new Error(
        body?.error?.message ?? `OpenAI request failed (${response.status}).`,
      );
    }

    return await readResponseStream(response, callbacks);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('OpenAI did not respond within 60 seconds. Try again.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

}

function isToolCall(item: ResponseOutputItem): item is ToolCall {
  return (
    item.type === 'function_call' &&
    typeof item.call_id === 'string' &&
    typeof item.name === 'string' &&
    typeof item.arguments === 'string'
  );
}

function outputText(response: OpenAiResponse): string {
  if (typeof response.output_text === 'string') return response.output_text.trim();

  return (response.output ?? [])
    .filter((item) => item.type === 'message' && Array.isArray(item.content))
    .flatMap((item) => item.content as ResponseOutputItem[])
    .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n')
    .trim();
}

export async function createDraftScript(origin: string): Promise<PageScript> {
  return addPageScript({
    origin,
    name: 'Untitled script',
    description: 'Describe what you want this script to do in the chat.',
    code: '',
  });
}

export async function chatWithScript(
  request: ScriptChatRequest,
  callbacks: ScriptChatCallbacks = {},
): Promise<ScriptChatResponse> {
  const apiKey = request.apiKey.trim();
  if (!apiKey) throw new Error('Add your OpenAI API key before chatting.');
  if (request.messages.length === 0) throw new Error('The conversation is empty.');

  let script = await getPageScript(request.origin, request.scriptId);
  if (!script) throw new Error('The script no longer exists.');
  let editedCode = script.code.trim() !== '';
  let namedScript = script.name !== 'Untitled script';
  let describedScript =
    script.description !== 'Describe what you want this script to do in the chat.';

  const input: ResponseInputItem[] = request.messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  let instructions = systemPrompt(script, request.creating);

  for (let turn = 0; turn < 10; turn += 1) {
    const answer = await createResponse(apiKey, instructions, input, callbacks);
    const output = answer.output ?? [];
    const calls = output.filter(isToolCall);

    // Preserve every output item, especially encrypted reasoning items. The
    // Responses API requires these to accompany subsequent tool outputs.
    input.push(...output);

    if (calls.length === 0) {
      const creationIncomplete =
        request.creating &&
        (!editedCode || !namedScript || !describedScript);
      if (creationIncomplete) {
        instructions = `${systemPrompt(script, request.creating)}\n\nThe new script is not complete yet. You must edit its code and set both a new useful name and a new useful description with the available tools before replying.`;
        continue;
      }

      return {
        message: outputText(answer) || 'Done.',
        script,
      };
    }

    for (const call of calls) {
      let result: Record<string, unknown>;
      try {
        script = await useTool(script, call);
        if (call.name === 'edit_script') editedCode = script.code.trim() !== '';
        if (call.name === 'set_name') namedScript = true;
        if (call.name === 'set_description') describedScript = true;
        result = {
          ok: true,
          name: script.name,
          description: script.description,
          code: script.code,
        };
      } catch (error) {
        result = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      callbacks.onToolResult?.(call.call_id);
      input.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: JSON.stringify(result),
      });
    }

    instructions = systemPrompt(script, request.creating);
  }

  throw new Error('The agent used too many tool calls. Try a more focused request.');
}
