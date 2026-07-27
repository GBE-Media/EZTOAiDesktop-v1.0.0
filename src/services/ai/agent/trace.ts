import type { AgentTraceEvent } from './types';

const MAX_EVENTS = 200;
const ring: AgentTraceEvent[] = [];

export function emitAgentTrace(
  runId: string,
  type: AgentTraceEvent['type'],
  data?: unknown
): AgentTraceEvent {
  const event: AgentTraceEvent = {
    runId,
    type,
    timestamp: new Date().toISOString(),
    data,
  };
  ring.push(event);
  if (ring.length > MAX_EVENTS) ring.shift();

  const prefix = `[AgentTrace][${runId}] ${type}`;
  if (type === 'error') {
    console.error(prefix, data);
  } else if (type === 'approval_denied' || type === 'retry') {
    console.warn(prefix, data);
  } else {
    console.log(prefix, data);
  }
  return event;
}

export function getAgentTrace(runId?: string): AgentTraceEvent[] {
  if (!runId) return [...ring];
  return ring.filter(event => event.runId === runId);
}

export function clearAgentTrace(runId?: string): void {
  if (!runId) {
    ring.length = 0;
    return;
  }
  for (let i = ring.length - 1; i >= 0; i -= 1) {
    if (ring[i].runId === runId) ring.splice(i, 1);
  }
}
