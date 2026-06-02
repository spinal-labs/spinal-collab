/**
 * Translates the Agent SDK's output stream (`SDKMessage`s) into our wire
 * events (`HostEventBody`), and captures the `session_id` from the init message
 * (needed for host-restart resume).
 *
 * Turn grouping: the SDK emits, per assistant response, a `message_start`
 * stream event, then `content_block_delta` token deltas, then a full
 * `assistant` message, then a `result`. We mint a `turnId` at `message_start`
 * and stamp every event of that turn with it, so guests can attach deltas to the
 * right finalized message and replace the live line cleanly.
 *
 * We deliberately do NOT forward raw tool output — tool results are summarized.
 */
import { nanoid } from 'nanoid';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AssistantBlock, HostEventBody } from '@spinal/collab-protocol';

export interface BridgeOutput {
  /** Wire events to broadcast (in order). */
  events: HostEventBody[];
  /** Set on the init message; the host captures it for resume. */
  sessionId?: string;
}

export class SdkBridge {
  private currentTurnId = nanoid();
  sessionId?: string;
  /** tool_use_id → tool name, so a tool_result can be labelled without its body. */
  private readonly toolNames = new Map<string, string>();

  /** Map one SDK message to zero or more wire events. */
  translate(msg: SDKMessage): BridgeOutput {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          this.sessionId = msg.session_id;
          return { events: [], sessionId: msg.session_id };
        }
        return { events: [] };

      case 'stream_event':
        return { events: this.fromStreamEvent(msg.event) };

      case 'assistant':
        return { events: this.fromAssistantMessage(msg.message) };

      case 'user':
        // The only user messages in the OUTPUT stream are SDK-internal tool
        // results echoed back. Human prompts arrive via our input queue, not here.
        return { events: this.fromToolResults(msg) };

      case 'result':
        return {
          events: [
            {
              t: 'turn.result',
              turnId: this.currentTurnId,
              subtype: msg.subtype,
              costUsd: 'total_cost_usd' in msg ? msg.total_cost_usd : undefined,
              usage: 'usage' in msg ? msg.usage : undefined,
            },
          ],
        };

      default:
        return { events: [] };
    }
  }

  private fromStreamEvent(event: unknown): HostEventBody[] {
    const e = event as { type?: string; delta?: { type?: string; text?: string } };
    if (e.type === 'message_start') {
      this.currentTurnId = nanoid();
      return [];
    }
    if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
      const text = e.delta.text ?? '';
      if (!text) return [];
      return [{ t: 'assistant.delta', turnId: this.currentTurnId, text }];
    }
    return [];
  }

  private fromAssistantMessage(message: unknown): HostEventBody[] {
    const content = (message as { content?: unknown }).content;
    const rawBlocks = Array.isArray(content) ? content : [];
    const blocks: AssistantBlock[] = [];
    const toolUses: HostEventBody[] = [];

    for (const raw of rawBlocks) {
      const b = raw as { type?: string; text?: string; id?: string; name?: string; input?: unknown };
      if (b.type === 'text' && typeof b.text === 'string') {
        blocks.push({ type: 'text', text: b.text });
      } else if (b.type === 'tool_use') {
        const name = b.name ?? 'tool';
        if (b.id) this.toolNames.set(b.id, name);
        blocks.push({ type: 'tool_use', id: b.id ?? '', name, input: b.input });
        toolUses.push({ t: 'tool.use', turnId: this.currentTurnId, name, input: b.input });
      }
    }

    const events: HostEventBody[] = [];
    if (blocks.length > 0) {
      events.push({ t: 'assistant.message', turnId: this.currentTurnId, blocks });
    }
    events.push(...toolUses);
    return events;
  }

  private fromToolResults(msg: SDKMessage & { type: 'user' }): HostEventBody[] {
    const content = (msg.message as { content?: unknown }).content;
    if (!Array.isArray(content)) return [];
    const events: HostEventBody[] = [];
    for (const raw of content) {
      const b = raw as {
        type?: string;
        is_error?: boolean;
        content?: unknown;
        tool_use_id?: string;
      };
      if (b.type !== 'tool_result') continue;
      const name = (b.tool_use_id && this.toolNames.get(b.tool_use_id)) || 'tool';
      events.push({
        t: 'tool.result',
        turnId: this.currentTurnId,
        ok: !b.is_error,
        summary: summarizeToolResult(name, b.is_error, b.content),
      });
    }
    return events;
  }
}

/**
 * Build a METADATA-ONLY summary — tool name, ok/error, and output size — never
 * the raw bytes. Tool output can contain file contents, secrets, or command
 * output that guests should not see by default; broadcasting only the shape
 * keeps the "summaries, not raw bytes" guarantee. (A future opt-in
 * `--share-tool-output` flag could relax this per the plan.)
 */
function summarizeToolResult(name: string, isError: boolean | undefined, content: unknown): string {
  let chars = 0;
  let lines = 0;
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
      .join('');
  }
  if (text) {
    chars = text.length;
    lines = text.split('\n').length;
  }
  const status = isError ? 'error' : 'ok';
  if (!chars) return `${name}: ${status}`;
  return `${name}: ${status} · ${lines} line${lines === 1 ? '' : 's'}, ${chars} chars`;
}
