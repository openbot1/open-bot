/**
 * Agent server v2 — public surface (v1.04, Đội T4).
 *
 * REST server chuyên conversations (tạo/liệt kê/pause/resume/cancel/
 * fork/stream SSE), treo trên event log, loopback-only + Bearer token.
 */
export { generateAgentServerToken, isAuthorizedToken, isLoopbackAddress, parseBearerToken } from './auth';
export { ConversationManager } from './conversations';
export type { ConversationManagerOptions } from './conversations';
export { startAgentServerV2 } from './server';
export type { StartAgentServerV2Options } from './server';
export {
  formatSseEvent,
  formatSseRunEnded,
  isTerminalRunEvent,
  SSE_HEARTBEAT,
  SSE_RUN_ENDED_EVENT,
  subscribeConversationEvents,
} from './stream';
export type { SseSubscribeOptions } from './stream';
export { AGENT_SERVER_API_VERSION, AgentServerError, conversationNotFound } from './types';
export type {
  AgentServerConversation,
  AgentServerHandle,
  AgentServerV2Options,
  CondenseConversationInput,
  ConversationControlInput,
  ConversationEventsQuery,
  CreateConversationInput,
  ForkConversationInput,
  SendMessageInput,
} from './types';
