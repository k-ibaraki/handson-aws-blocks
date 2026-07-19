/**
 * Backend — aws-blocks/index.ts
 *
 * AI chat app: Cognito auth (sign up → confirmation code → sign in), an
 * Agent-backed chatbot with streaming responses, and per-user conversation
 * history.
 *
 * This file defines your API, auth, data model, and AI agent.
 * The frontend imports these exports directly via `import { ... } from 'aws-blocks'`.
 *
 * ─── IMPORTANT ───────────────────────────────────────────────────────────────
 * Do NOT use local files, in-memory arrays, or local databases for persistence.
 * Use Building Blocks for cloud persistence and other common cloud abstractions.
 * They work locally with automatic mocks and deploy to AWS with zero configuration.
 *
 * For the full list of blocks and how to use them, see:
 *   node_modules/@aws-blocks/blocks/README.md
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { ApiNamespace, Scope, AuthCognito, KVStore, Agent, BedrockModels } from '@aws-blocks/blocks';
import type { InterruptResponse } from '@aws-blocks/bb-agent';
import { z } from 'zod';
import { createGithubPatSetting } from './github-mcp.js';
import { githubIssueTools } from './github-issue-tools.js';
import { APP_SCOPE_ID } from './github-pat-naming.js';

const scope = new Scope(APP_SCOPE_ID);

// ─── Auth ────────────────────────────────────────────────────────────────────
// Email-as-username sign up. Cognito always requires a confirmation code after
// sign-up (`CONFIRM_SIGN_UP`) before the account can sign in.
//
// Locally (mock), Cognito has no real mailbox to deliver the code to, so the
// `codeDelivery` hook below prints it to the terminal running `npm run dev`
// instead, and also stashes it in `lastCode` for the `getLastCode` API method
// (used by automated local tests — see test/e2e.test.ts). In Sandbox/
// Production both are disabled (gated on `BLOCKS_STACK_NAME`, which is only
// set in a deployed Lambda) and Cognito delivers the code over email as
// configured on the User Pool.
let lastCode: { username: string; code: string; purpose: string } | null = null;

const auth = new AuthCognito(scope, 'auth', {
  passwordPolicy: { minLength: 8 },
  signInWith: 'email' as const,
  // 本番URLを知っているだけの第三者が自由サインアップできないよう、セルフサインアップを無効化。
  // 新規ユーザーは管理者が Cognito 側で作成する運用とする。
  selfSignUp: false,
  crossDomain: process.env.BLOCKS_SANDBOX === 'true',
  codeDelivery: async (username, code, purpose) => {
    if (!process.env.BLOCKS_STACK_NAME) {
      lastCode = { username, code, purpose };
      console.log(`\n[auth] ${purpose} confirmation code for "${username}": ${code}\n`);
    }
  },
});
export const authApi = auth.createApi();

// ─── GitHub PAT (secret) ─────────────────────────────────────────────────────
// SSM SecureString, name auto-derived from the scope tree (no explicit
// `name` — see github-pat-naming.ts for why that matters for pat:push:*).
const githubPatSetting = createGithubPatSetting(scope);

// ─── AI Agent ────────────────────────────────────────────────────────────────
// Deployed: Bedrock BALANCED (Claude Sonnet). Local dev: no `model.local` is
// set, so the Agent BB automatically falls back to its canned (keyword-based)
// mock — deterministic, no AWS credentials needed.
const agent = new Agent(scope, 'chat', {
  model: { deployed: BedrockModels.BALANCED },
  systemPrompt:
    'You are a friendly, helpful AI chat assistant. Answer clearly and concisely. ' +
    'You can search, read, and manage GitHub issues in the configured repository using your tools.',
  streamingMode: 'token',
  tools: githubIssueTools(githubPatSetting),
  // ⚠️ 検証用アプリの設定: 既定(未指定)だとセッション用 FileBucket は
  // RemovalPolicy.RETAIN のままで `npm run destroy` 後もデータが残る。
  // 実運用アプリに転用する場合はこの行を削除し、既定の RETAIN に戻すこと。
  removalPolicy: 'destroy',
});

// Conversation titles. `Agent.listConversations()` names every new
// conversation after its own (unguessable) conversationId — a raw UUID isn't
// a friendly sidebar label, so we derive a short title from the first
// message and store it here, keyed by conversationId.
const titles = new KVStore(scope, 'conversation-titles', {
  schema: z.string().max(200),
  // ⚠️ 検証用アプリの設定: 既定(未指定)だと RemovalPolicy.RETAIN のままで
  // `npm run destroy` 後もテーブルが残る。実運用アプリに転用する場合は
  // この行を削除し、既定の RETAIN に戻すこと。
  removalPolicy: 'destroy',
});

function deriveTitle(message: string): string {
  const trimmed = message.trim().replace(/\s+/g, ' ');
  if (!trimmed) return 'New chat';
  return trimmed.length <= 48 ? trimmed : `${trimmed.slice(0, 48)}…`;
}

// ─── API ─────────────────────────────────────────────────────────────────────
export const api = new ApiNamespace(scope, 'api', (context) => ({

  async createConversation() {
    const user = await auth.requireAuth(context);
    const conversationId = await agent.createConversationId(user.userSub);
    return { conversationId };
  },

  /** List the signed-in user's conversations, newest first, with friendly titles. */
  async listConversations() {
    const user = await auth.requireAuth(context);
    const conversations = await agent.listConversations(user.userSub);
    return await Promise.all(
      conversations.map(async (c) => ({
        conversationId: c.conversationId,
        title: (await titles.get(c.conversationId)) ?? 'New chat',
        updatedAt: c.updatedAt,
      })),
    );
  },

  /**
   * Send a message and kick off a streaming response. The response text
   * arrives via the Realtime channel returned by `getChannel`, not this
   * method's return value — `stream()` submits the job and returns
   * immediately (see node_modules/@aws-blocks/blocks/docs/bb-agent.md).
   */
  async sendMessage(conversationId: string, message: string, channelId: string) {
    const user = await auth.requireAuth(context);

    // Agent BB doesn't authorize reads/writes by conversationId on its own —
    // verify the caller actually owns this conversation first.
    const owned = await agent.listConversations(user.userSub);
    if (!owned.some((c) => c.conversationId === conversationId)) {
      throw new Error('Conversation not found');
    }

    const existingTitle = await titles.get(conversationId);
    if (!existingTitle) {
      await titles.put(conversationId, deriveTitle(message));
    }

    const result = await agent.stream(message, { conversationId, userId: user.userSub, channelId });
    return { channelId: result.channelId };
  },

  /** Fetch a conversation's message history. Owner-checked like `sendMessage`. */
  async getConversation(conversationId: string) {
    const user = await auth.requireAuth(context);
    const owned = await agent.listConversations(user.userSub);
    if (!owned.some((c) => c.conversationId === conversationId)) {
      throw new Error('Conversation not found');
    }
    const messages = await agent.getConversation(conversationId);
    return { messages };
  },

  /** Realtime channel for streaming chunks — used by the `useChat` client hook. */
  async getChannel(channelId: string) {
    await auth.requireAuth(context);
    return agent.getChannel(channelId);
  },

  /**
   * Resume an agent paused on a tool-approval interrupt (e.g. a GitHub write
   * tool) with the user's approve/deny response. Owner-checked like
   * `sendMessage`/`getConversation`.
   */
  async resume(channelId: string, responses: InterruptResponse[], conversationId: string) {
    const user = await auth.requireAuth(context);
    const owned = await agent.listConversations(user.userSub);
    if (!owned.some((c) => c.conversationId === conversationId)) {
      throw new Error('Conversation not found');
    }
    await agent.resume(channelId, responses, { conversationId, userId: user.userSub });
  },

  /**
   * Unanswered interrupts for a conversation, if any — lets the client
   * restore the approval UI after a page reload (see `useChat`'s
   * `loadConversation`, which calls this automatically).
   */
  async getPendingInterrupts(conversationId: string) {
    const user = await auth.requireAuth(context);
    const owned = await agent.listConversations(user.userSub);
    if (!owned.some((c) => c.conversationId === conversationId)) {
      throw new Error('Conversation not found');
    }
    const interrupts = await agent.getPendingInterrupts(conversationId);
    return { interrupts };
  },

  // ── Mock-only helper ─────────────────────────────────────────────────
  /**
   * Returns the most recently issued sign-up/reset confirmation code.
   * Only available in local/mock dev — the `BLOCKS_STACK_NAME` env gate
   * forces this to `null` in any deployed environment (Sandbox/Production),
   * so a live code can never leak through this method. It exists purely so
   * automated local tests (see test/e2e.test.ts) can complete the sign-up
   * flow deterministically without a real mailbox.
   *
   * @blocksSkipCodegen
   */
  async getLastCode() {
    return !process.env.BLOCKS_STACK_NAME ? lastCode : null;
  },
}));
