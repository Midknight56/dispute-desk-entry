import type { AgAiEvent, AgAiRunInput } from 'ag-studio';
import type { ChartRequest } from './addChart';

export type AskReply = {
  spec: Omit<ChartRequest, 'title'>;
  title: string;
  rows: unknown[];
  by: unknown;
  neurons: unknown;
};

export type EventIds = { messageId: string; toolCallId: string };

export function shouldFinish(messages: Array<{ role: string }>): boolean {
  return messages.at(-1)?.role === 'tool';
}

export function askToEvents(reply: AskReply | { finish: true } | { error: string }, ids: EventIds): AgAiEvent[] {
  if ('error' in reply) return [{ type: 'RUN_ERROR', message: reply.error }];
  if ('finish' in reply) {
    return [
      { type: 'TEXT_MESSAGE_START', messageId: ids.messageId, role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: ids.messageId, delta: 'Added.' },
      { type: 'TEXT_MESSAGE_END', messageId: ids.messageId },
    ];
  }
  return [
    { type: 'TOOL_CALL_START', toolCallId: ids.toolCallId, toolCallName: 'add_dispute_chart' },
    {
      type: 'TOOL_CALL_ARGS',
      toolCallId: ids.toolCallId,
      delta: JSON.stringify({
        chart: reply.spec.chart,
        groupBy: reply.spec.groupBy,
        metric: reply.spec.metric,
        period: reply.spec.period,
        title: reply.title,
      }),
    },
    { type: 'TOOL_CALL_END', toolCallId: ids.toolCallId },
  ];
}

export function latestUserText(input: AgAiRunInput): string {
  const message = [...input.messages].reverse().find((item) => item.role === 'user');
  if (!message || message.role !== 'user') return '';
  return typeof message.content === 'string' ? message.content : '';
}
