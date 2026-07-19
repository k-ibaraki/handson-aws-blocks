/**
 * GitHub MCP integration — connection + secret resolution.
 *
 * Connects to GitHub's official remote MCP server
 * (https://api.githubcopilot.com/mcp/) from inside an Agent tool handler,
 * authenticated with a PAT (static proxy — this app exposes a fixed set of
 * GitHub tools to the agent; it does not forward the remote server's full
 * tool list). See aws-blocks/github-issue-tools.ts for the tool definitions
 * and aws-blocks/scripts/mcp-tools.ts for the tools/list inspector used to
 * confirm the remote server's actual tool names/schemas before wiring them
 * up here.
 */
import { AppSetting, Scope } from '@aws-blocks/blocks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { GITHUB_PAT_SETTING_ID } from './github-pat-naming.js';

const GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/';

export function createGithubPatSetting(scope: Scope) {
  return new AppSetting<string>(scope, GITHUB_PAT_SETTING_ID, { secret: true });
}

/**
 * Resolve the GitHub PAT. Local/mock dev reads it from `.env` (loaded into
 * process.env by aws-blocks/scripts/server.ts); deployed environments
 * (sandbox/production) read it from the AppSetting-backed SSM SecureString.
 * Gated the same way as the auth codeDelivery hook in index.ts —
 * BLOCKS_STACK_NAME is only set inside a deployed Lambda, never locally.
 */
export async function resolveGithubPat(githubPatSetting: ReturnType<typeof createGithubPatSetting>): Promise<string> {
  if (!process.env.BLOCKS_STACK_NAME) {
    const pat = process.env.GITHUB_PAT;
    if (!pat) {
      throw new Error('GITHUB_PAT is not set. Add it to .env (see .env.example) for local development.');
    }
    return pat;
  }
  return githubPatSetting.get();
}

/** GITHUB_OWNER/GITHUB_REPO: plain env vars — Lambda env vars when deployed (see index.cdk.ts), .env locally. */
export function resolveGithubRepo(): { owner: string; repo: string } {
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  if (!owner || !repo) {
    throw new Error('GITHUB_OWNER / GITHUB_REPO are not configured (set them in .env).');
  }
  return { owner, repo };
}

/**
 * Open a short-lived MCP client connection to GitHub's official remote MCP
 * server, authenticated with the caller's PAT, call one tool, then close.
 * A fresh connection per call keeps this simple inside the AsyncJob
 * consumer Lambda (no cross-invocation connection pool to manage) — the
 * endpoint is plain HTTPS, so the per-call handshake cost is small relative
 * to the LLM round trip this is nested inside.
 */
export async function callGithubMcpTool(pat: string, name: string, args: Record<string, unknown>) {
  const client = new Client({ name: 'blocks-mcp-chat', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(GITHUB_MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${pat}` } },
  });
  await client.connect(transport);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}
