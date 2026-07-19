/**
 * Frontend — src/index.ts
 *
 * AI chat app. Uses lit-html for declarative rendering and the Agent BB's
 * `useChat` client hook for streaming, conversation state, and the
 * subscribe-before-send ordering.
 * Imports the typed backend API via `aws-blocks` (auto-generated proxy).
 */
import { api, authApi } from 'aws-blocks';
import { AccountMenuBar, AuthenticatedContent, onAuthChange } from '@aws-blocks/blocks/ui';
import { useChat, type ChatMessage, type ChatInstance } from '@aws-blocks/bb-agent/client';
import { html, render } from 'lit-html';

// ─── Auth ────────────────────────────────────────────────────────────────────
// This app signs up with `signInWith: 'email'` (see aws-blocks/index.ts), but
// Cognito still assigns each user a random UUID as the *actual* username
// internally and stores the address the user typed as the `email` attribute
// instead — so `user.username` is a UUID, never something to show a human.
// `AccountMenuBar` only ever reads `user.username`, so wrap `authApi` and
// substitute the `email` attribute for it when present. This only affects
// what the UI displays; the real username/userSub the backend uses for
// authorization is untouched.
// Note: local mock auth's `username` already IS the email address (no UUID
// quirk there), so this is only visibly different against a real deployed
// Cognito user pool — don't rely on local/e2e runs to confirm this fix.
function withFriendlyUsername(api: typeof authApi): typeof authApi {
  type AuthState = Awaited<ReturnType<typeof authApi.getAuthState>>;
  function useEmailAsUsername(state: AuthState): AuthState {
    const email = (state.user as unknown as { attributes?: Record<string, string> } | undefined)
      ?.attributes?.email;
    return email && state.user ? { ...state, user: { ...state.user, username: email } } : state;
  }
  return new Proxy(api, {
    get(target, prop, receiver) {
      if (prop === 'getAuthState') return () => target.getAuthState().then(useEmailAsUsername);
      if (prop === 'setAuthState') {
        return (input: Parameters<typeof authApi.setAuthState>[0]) =>
          target.setAuthState(input).then(useEmailAsUsername);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

document.getElementById('menu-bar')!.appendChild(AccountMenuBar(withFriendlyUsername(authApi)));

onAuthChange(authApi, user => {
  document.getElementById('signInMessage')!.style.display = user == null ? '' : 'none';
});

// ─── App (shown when authenticated) ─────────────────────────────────────────
type ConversationSummary = { conversationId: string; title: string; updatedAt: number };
type PendingInterrupt = { id: string; name: string; reason?: { tool?: string; input?: unknown; trustable?: boolean } };

const LAST_CONVERSATION_KEY = 'blocks-mcp-chat:lastConversationId';

document.getElementById('app')!.appendChild(
  AuthenticatedContent(authApi, () => {
    const container = document.createElement('div');
    container.className = 'chat-layout';

    let conversations: ConversationSummary[] = [];
    let activeConversationId: string | null = null;
    let messages: ChatMessage[] = [];
    let loading = false;
    let errorMessage: string | null = null;
    let pendingInterrupts: PendingInterrupt[] = [];
    let respondingInterruptId: string | null = null;
    let chat: ChatInstance = createChat();

    function createChat(): ChatInstance {
      return useChat({
        api: {
          sendMessage: async (conversationId, message, channelId) => {
            await api.sendMessage(conversationId, message, channelId);
          },
          createConversation: () => api.createConversation(),
          getConversation: (id) => api.getConversation(id),
          resume: (channelId, responses, conversationId) => api.resume(channelId, responses, conversationId!),
          getPendingInterrupts: (id) => api.getPendingInterrupts(id),
        },
        subscribe: async (channelId, handler) => {
          const channel = await api.getChannel(channelId);
          return channel.subscribe(handler);
        },
        onMessagesChange: (msgs) => { messages = msgs; redraw(); },
        onLoadingChange: (isLoading) => { loading = isLoading; redraw(); },
        onError: (err) => { errorMessage = err; redraw(); },
        // Tool-approval interrupt (e.g. createIssue/updateIssue) — show the
        // Approve/Deny card. Fires both on a live interrupt chunk and,
        // via loadConversation below, on reload while one is unanswered.
        onInterrupt: (interrupts) => { pendingInterrupts = interrupts as PendingInterrupt[]; redraw(); },
      });
    }

    async function respondToInterrupt(interruptId: string, approved: boolean) {
      respondingInterruptId = interruptId;
      redraw();
      try {
        await chat.respondToInterrupt([{ interruptId, approved }]);
        pendingInterrupts = pendingInterrupts.filter((i) => i.id !== interruptId);
      } catch (err) {
        errorMessage = err instanceof Error ? err.message : String(err);
      } finally {
        respondingInterruptId = null;
        redraw();
      }
    }

    async function refreshConversations() {
      conversations = await api.listConversations();
      redraw();
    }

    function startNewChat() {
      chat.destroy();
      chat = createChat();
      activeConversationId = null;
      messages = [];
      errorMessage = null;
      pendingInterrupts = [];
      localStorage.removeItem(LAST_CONVERSATION_KEY);
      redraw();
    }

    async function selectConversation(conversationId: string) {
      if (conversationId === activeConversationId) return;
      chat.destroy();
      chat = createChat();
      activeConversationId = conversationId;
      errorMessage = null;
      pendingInterrupts = [];
      localStorage.setItem(LAST_CONVERSATION_KEY, conversationId);
      redraw();
      // loadConversation subscribes, backfills history, and — if the agent
      // was left mid tool-approval — calls getPendingInterrupts and fires
      // onInterrupt so the Approve/Deny card reappears after a reload.
      await chat.loadConversation(conversationId);
    }

    async function handleSend() {
      const textarea = container.querySelector('#composer-input') as HTMLTextAreaElement;
      const text = textarea.value.trim();
      if (!text || loading || pendingInterrupts.length > 0) return;
      textarea.value = '';
      errorMessage = null;
      await chat.sendMessage(text);
      if (!activeConversationId) activeConversationId = chat.getConversationId();
      if (activeConversationId) localStorage.setItem(LAST_CONVERSATION_KEY, activeConversationId);
      await refreshConversations();
    }

    function renderApprovalCard(interrupt: PendingInterrupt) {
      const toolName = interrupt.reason?.tool ?? interrupt.name;
      const input = interrupt.reason?.input;
      // useChat.respondToInterrupt() is a no-op while an earlier response is
      // still in flight (its internal `loading` guard) — with parallel tool
      // calls, multiple cards can be pending at once, so disable ALL cards'
      // buttons while any one response is outstanding, not just this card's.
      const disabled = respondingInterruptId !== null;
      return html`
        <div class="approval-card">
          <div class="approval-title">ツール実行の承認が必要です</div>
          <div>ツール: <span class="approval-tool">${toolName}</span></div>
          ${input !== undefined ? html`<pre class="approval-input">${JSON.stringify(input, null, 2)}</pre>` : ''}
          <div class="approval-actions">
            <button
              class="approve-btn"
              ?disabled=${disabled}
              @click=${() => respondToInterrupt(interrupt.id, true)}
            >Approve</button>
            <button
              class="deny-btn"
              ?disabled=${disabled}
              @click=${() => respondToInterrupt(interrupt.id, false)}
            >Deny</button>
          </div>
        </div>
      `;
    }

    function redraw() {
      render(html`
        <aside class="sidebar">
          <button class="new-chat-btn" @click=${startNewChat}>+ New chat</button>
          <ul class="conversation-list">
            ${conversations.map(c => html`
              <li
                class="conversation-item ${c.conversationId === activeConversationId ? 'active' : ''}"
                @click=${() => selectConversation(c.conversationId)}
              >${c.title}</li>
            `)}
          </ul>
        </aside>
        <main class="chat-main">
          ${errorMessage ? html`<div class="error-banner">${errorMessage}</div>` : ''}
          <div class="messages">
            ${messages.length === 0 && pendingInterrupts.length === 0
              ? html`<div class="empty-state">メッセージを送って会話を始めましょう。</div>`
              : messages.map(m => html`
                  <div class="message ${m.role}">${m.content || (m.role === 'assistant' ? '…' : '')}</div>
                `)}
            ${pendingInterrupts.map(renderApprovalCard)}
          </div>
          <div class="composer">
            <textarea
              id="composer-input"
              rows="1"
              placeholder=${pendingInterrupts.length > 0 ? '承認待ちのツール実行があります…' : 'メッセージを入力…'}
              ?disabled=${pendingInterrupts.length > 0}
              @keydown=${(e: KeyboardEvent) => {
                if (e.isComposing || e.keyCode === 229) return;
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
              }}
            ></textarea>
            <button @click=${handleSend} ?disabled=${loading || pendingInterrupts.length > 0}>送信</button>
          </div>
        </main>
      `, container);

      const messagesEl = container.querySelector('.messages');
      if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    // Restore the last-open conversation on reload — loadConversation (via
    // selectConversation) re-subscribes and calls getPendingInterrupts, so an
    // unanswered tool-approval card reappears without the user re-navigating.
    const lastConversationId = localStorage.getItem(LAST_CONVERSATION_KEY);
    refreshConversations().then(() => {
      if (lastConversationId && conversations.some(c => c.conversationId === lastConversationId)) {
        selectConversation(lastConversationId);
      }
    });
    redraw();
    return container;
  })
);
