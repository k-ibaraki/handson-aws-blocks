/**
 * End-to-end tests — tests the API via direct imports (same typed client the frontend uses).
 *
 * Run:  npm run test:e2e
 *
 * Structure:
 *   - Setup (starts dev server, imports client) — don't touch
 *   - Auth (sign up → confirm code → sign in)
 *   - Conversations (create, list, friendly titles)
 *   - Chat (send message, canned streaming response, ownership checks)
 *
 * To add tests: copy any test block, rename, change the assertion. The setup
 * boilerplate handles server lifecycle — you just call api.* methods.
 *
 * The canned mock (used automatically in local dev — no AWS credentials
 * needed) replies deterministically based on keywords in the prompt, e.g.
 * a message containing "weather" always gets back a fixed weather reply.
 * See node_modules/@aws-blocks/bb-agent/src/providers/canned.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { installCookieJar, isServerRunning } from '@aws-blocks/blocks/utils';
import type { api as ApiType, authApi as AuthApiType } from 'aws-blocks';

// Install cookie jar before importing the API client — Node's fetch doesn't
// persist cookies between requests, which breaks authenticated API calls.
installCookieJar();

let server: ChildProcess | null = null;
let api: typeof ApiType;
let authApi: typeof AuthApiType;

// ─── Setup (don't touch) ─────────────────────────────────────────────────────

test.before(async () => {
  // Use existing dev server if running, otherwise start one
  if (!await isServerRunning()) {
    server = spawn('npm', ['run', 'dev:server'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    server.unref();
    await setTimeout(2000);
  }

  const mod = await import('aws-blocks');
  api = mod.api;
  authApi = mod.authApi;

  // Wait for server readiness
  for (let i = 0; i < 30; i++) {
    try {
      await authApi.getAuthState();
      return;
    } catch {
      await setTimeout(1000);
    }
  }
  throw new Error('Dev server did not become ready within 30s');
});

test.after(() => {
  if (server?.pid) {
    try { process.kill(-server.pid, 'SIGTERM'); } catch {}
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_USER = 'chatuser@example.com';
const TEST_PASSWORD = 'TestPass123!';

/** Poll getConversation() until the agent's assistant reply lands (canned mock is near-instant). */
async function waitForAssistantReply(conversationId: string, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { messages } = await api.getConversation(conversationId);
    const assistant = messages.find((m) => m.role === 'assistant' && m.content);
    if (assistant) return assistant;
    await setTimeout(200);
  }
  throw new Error(`No assistant reply within ${timeoutMs}ms`);
}

/** Poll getConversation() until an `interrupt` (tool-approval pause) message lands. */
async function waitForInterrupt(conversationId: string, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { messages } = await api.getConversation(conversationId);
    const interrupt = messages.find((m) => m.role === 'interrupt');
    if (interrupt) return interrupt;
    await setTimeout(200);
  }
  throw new Error(`No interrupt within ${timeoutMs}ms`);
}

// ─── Auth: sign up → confirm code → sign in ──────────────────────────────────

test('auth: starts signed out', async () => {
  const state = await authApi.getAuthState();
  assert.strictEqual(state.state, 'signedOut');
});

test('auth: sign up requires a confirmation code', async () => {
  const state = await authApi.setAuthState({
    action: 'signUp',
    username: TEST_USER,
    password: TEST_PASSWORD,
    // Skip the auto-sign-in bridge — this test drives the explicit
    // sign up → confirm code → sign in sequence instead.
    autoSignIn: 'false',
  });
  assert.strictEqual(state.state, 'confirmingSignUp');
});

test('auth: confirm sign up with the code printed to the terminal, then sign in', async () => {
  // Local dev has no real mailbox — the code is printed to the terminal
  // running `npm run dev` and also captured by the mock-only `getLastCode`
  // helper so this test can complete the flow deterministically.
  const last = await api.getLastCode();
  assert.ok(last, 'expected a confirmation code to have been issued');
  assert.strictEqual(last!.username, TEST_USER);
  assert.strictEqual(last!.purpose, 'signUp');

  const confirmed = await authApi.setAuthState({
    action: 'confirmSignUp',
    username: TEST_USER,
    code: last!.code,
  });
  assert.strictEqual(confirmed.state, 'signedOut');

  const signedIn = await authApi.setAuthState({
    action: 'signIn',
    username: TEST_USER,
    password: TEST_PASSWORD,
  });
  assert.strictEqual(signedIn.state, 'signedIn');
  assert.strictEqual(signedIn.user?.username, TEST_USER);
});

test('auth: unauthenticated access is rejected', async () => {
  await authApi.setAuthState({ action: 'signOut' });

  await assert.rejects(
    () => api.listConversations(),
    (err: any) => err.message.includes('Authentication'),
  );

  // Sign back in for the remaining tests
  await authApi.setAuthState({
    action: 'signIn',
    username: TEST_USER,
    password: TEST_PASSWORD,
  });
});

// ─── Conversations ─────────────────────────────────────────────────────────────

test('conversations: create + list, with a friendly title (not a raw UUID)', async () => {
  const { conversationId } = await api.createConversation();
  assert.ok(conversationId);

  const list = await api.listConversations();
  const created = list.find((c) => c.conversationId === conversationId);
  assert.ok(created, 'new conversation should appear in the list');
  assert.strictEqual(created!.title, 'New chat');
  assert.notStrictEqual(created!.title, conversationId);
});

// ─── Chat ───────────────────────────────────────────────────────────────────────

test('chat: send a message and get a canned streaming reply', async () => {
  const { conversationId } = await api.createConversation();
  await api.sendMessage(conversationId, 'What is the weather like today?', conversationId);

  const assistant = await waitForAssistantReply(conversationId);
  assert.match(assistant.content, /weather/i);
  assert.match(assistant.content, /canned response/i);

  const { messages } = await api.getConversation(conversationId);
  assert.ok(messages.some((m) => m.role === 'user' && m.content.includes('weather')));
});

test('chat: title updates from the raw conversationId to the first message', async () => {
  const { conversationId } = await api.createConversation();

  let list = await api.listConversations();
  assert.strictEqual(list.find((c) => c.conversationId === conversationId)!.title, 'New chat');

  await api.sendMessage(conversationId, 'Can you help me plan a trip?', conversationId);
  await waitForAssistantReply(conversationId);

  list = await api.listConversations();
  const updated = list.find((c) => c.conversationId === conversationId);
  assert.ok(updated);
  assert.strictEqual(updated!.title, 'Can you help me plan a trip?');
  assert.notStrictEqual(updated!.title, conversationId);
});

test('chat: cannot send to or read a conversation you do not own', async () => {
  const otherConversationId = 'not-a-real-or-owned-conversation-id';

  await assert.rejects(() => api.sendMessage(otherConversationId, 'hi', otherConversationId));
  await assert.rejects(() => api.getConversation(otherConversationId));
});

// ─── GitHub tools: approval required, deny path ──────────────────────────────
//
// createIssue/updateIssue/closeIssue/reopenIssue/addIssueComment all require
// human approval (needsApproval: true) — see aws-blocks/github-issue-tools.ts.
// This confirms the full "approval requested → denied → completes with no
// external call" path: the only code path that talks to GitHub's MCP server
// is inside each tool's handler, so if the handler never runs, no request
// was ever sent.

test('github tools: createIssue pauses for approval; denying it completes without calling GitHub', async () => {
  const { conversationId } = await api.createConversation();

  // "createissue" as one word matches only the createIssue tool under the
  // canned mock's word-boundary matcher (see providers/canned.ts). A prompt
  // containing the standalone word "issue" would also match every other
  // issue-related tool (getIssue, listIssueComments, ...) and trigger a real,
  // needsApproval:false GitHub call — deliberately avoided here.
  await api.sendMessage(conversationId, 'please createissue now', conversationId);

  await waitForInterrupt(conversationId);

  const { interrupts } = await api.getPendingInterrupts(conversationId);
  assert.strictEqual(interrupts.length, 1);
  assert.strictEqual((interrupts[0].reason as any)?.tool, 'createIssue');

  // Deny.
  await api.resume(conversationId, [{ interruptId: interrupts[0].id, approved: false }], conversationId);

  const assistant = await waitForAssistantReply(conversationId);
  assert.match(assistant.content, /denied/i);

  const { messages } = await api.getConversation(conversationId);

  const approval = messages.find((m) => m.role === 'approval');
  assert.ok(approval, 'expected an approval record');
  assert.strictEqual((approval!.metadata as any).approved, false);

  const toolResults = messages.filter((m) => m.role === 'tool-result' && (m.metadata as any).toolName === 'createIssue');
  assert.strictEqual(toolResults.length, 1, 'expected exactly one tool-result for createIssue (no retry after denial)');

  // The framework substitutes a synthetic "denied" result instead of ever
  // invoking the handler — a real call would echo GitHub's own response
  // shape (an issue number/URL). Asserting the denial text AND the absence
  // of GitHub response fields is the in-band evidence that no HTTP request
  // to GitHub's MCP server was made.
  const output = JSON.stringify((toolResults[0].metadata as any).toolOutput);
  assert.match(output, /denied/i);
  assert.doesNotMatch(output, /html_url|issue_number|"number":/i);
});
