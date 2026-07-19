# AI Chat App (AWS Blocks)

AI chat app with Cognito authentication, a streaming AI agent, and per-user conversation history.

## Getting Started

```bash
npm run dev          # Start local dev server (mocks, no AWS needed)
npm run test:e2e     # Run API tests
npm run sandbox      # Deploy to AWS sandbox
```

Open http://localhost:3000 after `npm run dev`.

### Signing up locally

The local mock has no real mailbox to deliver the sign-up confirmation code
to. Instead, **the code is printed to the terminal running `npm run dev`**:

```
[auth] signUp confirmation code for "you@example.com": 123456
```

Copy that code into the "Verification Code" field in the browser. This only
happens in local/mock dev — in Sandbox/Production, Cognito emails the code
as usual.

## Project Structure

| Path | Purpose |
|------|---------|
| `aws-blocks/index.ts` | Backend: Cognito auth, AI agent, conversation API |
| `src/index.ts` | Frontend: sidebar + streaming chat UI |
| `test/e2e.test.ts` | Tests: auth flow, conversations, streaming chat, ownership |
| `index.html` | HTML shell |

## What's Included

- **AuthCognito** — sign up → confirmation code → sign in, with JWT sessions
- **Agent** — AI chat with streaming responses (`@aws-blocks/bb-agent`); deploys with
  `BedrockModels.BALANCED`, uses the built-in canned (keyword-based) mock locally —
  no AWS credentials needed for local dev
- **KVStore** — friendly conversation titles derived from each conversation's first
  message (conversations are named after their raw UUID by default; this app renames
  them client-visibly instead of showing that ID)
- **useChat client hook** — handles streaming subscriptions and message state for the UI

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Local dev with mock storage and canned AI responses |
| `npm run test:e2e` | Test API via direct imports |
| `npm run typecheck` | TypeScript type checking |
| `npm run sandbox` | Deploy backend to AWS, serve frontend locally |
| `npm run deploy` | Full production deploy |
| `npm run sandbox:destroy` | Tear down sandbox resources |

## Building on this template

The test file (`test/e2e.test.ts`) is structured in sections — Auth, Conversations, Chat.
Add your own tests by copying a `test(...)` block and changing the assertion.

To point the agent at a different model, edit `model.deployed` in `aws-blocks/index.ts`
(see `node_modules/@aws-blocks/blocks/docs/bb-agent.md` for presets, tools, and local
Ollama options). To add tools the agent can call, use the `tools` option on `Agent`.

## Stack naming

Your CloudFormation stack names are derived from the `stackId` in `.blocks/config.json` — generated at scaffold time from your project name plus a random suffix (e.g., `my-app-a3x9kf`). Production deploys as `<stackId>-prod` and sandbox as `<stackId>-<username>-<random>`, where the sandbox identifier is per-machine and stored in `.blocks-sandbox/sandbox-id.txt` (gitignored). This lets multiple developers share a testing account without colliding.

To change the stack name, edit `stackId` in `.blocks/config.json`. For dynamic naming logic, modify `aws-blocks/index.cdk.ts` directly.

## For Agents

Full Building Block documentation: `node_modules/@aws-blocks/blocks/README.md`

**Do not use local files or in-memory storage** — use Building Blocks for all data persistence and cloud abstractions (they mock locally and deploy to AWS automatically).

Start in `aws-blocks/index.ts` (backend) and `src/index.ts` (frontend). Test via `npm run test:e2e`. The API transport (JSON-RPC) is auto-generated and intentionally invisible — do not curl endpoints directly. Testing is best done through the e2e tests which use the same typed client as the frontend.

Every `ApiNamespace` method must `return` a JSON-serializable value — the local dev server responds with a 500 for handlers that fall through without a return.
