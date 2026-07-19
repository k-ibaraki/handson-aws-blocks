/**
 * Static proxy: a fixed set of Issue-related Agent tools, each forwarding to
 * exactly one tool call on GitHub's official remote MCP server. Tool names
 * and schemas below were confirmed with `npm run mcp:tools -- issue` against
 * https://api.githubcopilot.com/mcp/ (not guessed) — that server currently
 * exposes issue reads/writes as two grouped tools (`issue_read` / `issue_write`,
 * distinguished by a `method` field) rather than one tool per verb, so this
 * proxy re-splits them into per-verb Agent tools for clearer approval prompts.
 *
 * Read-only operations (search / get / list comments) run autonomously.
 * Anything that mutates GitHub (create / update / close / reopen / comment)
 * requires human approval via `needsApproval: true` — see bb-agent's
 * interrupt/resume flow (node_modules/@aws-blocks/blocks/docs/bb-agent.md).
 */
import { z } from 'zod';
import type { ToolsConfig } from '@aws-blocks/blocks';
import { callGithubMcpTool, createGithubPatSetting, resolveGithubPat, resolveGithubRepo } from './github-mcp.js';

type GithubPatSetting = ReturnType<typeof createGithubPatSetting>;

/** MCP tool results are `{ content: [{ type: 'text', text: string }, ...] }` — flatten to a string for the agent. */
function extractText(result: Awaited<ReturnType<typeof callGithubMcpTool>>): string {
  const content = (result as { content?: unknown[] }).content ?? [];
  const text = content
    .filter((c): c is { type: 'text'; text: string } => (c as { type?: string }).type === 'text')
    .map((c) => c.text)
    .join('\n');
  return text || JSON.stringify(result);
}

async function callGithub(githubPatSetting: GithubPatSetting, mcpToolName: string, args: Record<string, unknown>): Promise<string> {
  const pat = await resolveGithubPat(githubPatSetting);
  const { owner, repo } = resolveGithubRepo();
  const result = await callGithubMcpTool(pat, mcpToolName, { owner, repo, ...args });
  return extractText(result);
}

export function githubIssueTools(githubPatSetting: GithubPatSetting): ToolsConfig {
  return (tool) => ({
    // ── Read-only — no approval required ─────────────────────────────────
    searchIssues: tool({
      description: 'Search issues in the configured GitHub repository using GitHub issue search syntax (e.g. "is:open label:bug").',
      parameters: z.object({
        query: z.string().describe('GitHub issue search query (already scoped to is:issue by the server)'),
      }),
      needsApproval: false,
      handler: ({ input }) => callGithub(githubPatSetting, 'search_issues', { query: input.query }),
    }),

    getIssue: tool({
      description: 'Get the details of a single issue by number in the configured GitHub repository.',
      parameters: z.object({ issueNumber: z.number().describe('Issue number') }),
      needsApproval: false,
      handler: ({ input }) => callGithub(githubPatSetting, 'issue_read', { method: 'get', issue_number: input.issueNumber }),
    }),

    listIssueComments: tool({
      description: 'List the comments on a single issue in the configured GitHub repository.',
      parameters: z.object({ issueNumber: z.number().describe('Issue number') }),
      needsApproval: false,
      handler: ({ input }) => callGithub(githubPatSetting, 'issue_read', { method: 'get_comments', issue_number: input.issueNumber }),
    }),

    // ── Mutating — human approval required ───────────────────────────────
    createIssue: tool({
      description: 'Create a new issue in the configured GitHub repository.',
      parameters: z.object({
        title: z.string(),
        body: z.string().optional(),
        labels: z.array(z.string()).optional(),
      }),
      needsApproval: true,
      handler: ({ input }) => callGithub(githubPatSetting, 'issue_write', {
        method: 'create',
        title: input.title,
        body: input.body,
        labels: input.labels,
      }),
    }),

    updateIssue: tool({
      description: "Update an existing issue's title, body, or labels in the configured GitHub repository.",
      parameters: z.object({
        issueNumber: z.number(),
        title: z.string().optional(),
        body: z.string().optional(),
        labels: z.array(z.string()).optional(),
      }),
      needsApproval: true,
      handler: ({ input }) => callGithub(githubPatSetting, 'issue_write', {
        method: 'update',
        issue_number: input.issueNumber,
        title: input.title,
        body: input.body,
        labels: input.labels,
      }),
    }),

    closeIssue: tool({
      description: 'Close an issue in the configured GitHub repository.',
      parameters: z.object({
        issueNumber: z.number(),
        reason: z.enum(['completed', 'not_planned']).optional().describe('Why the issue is being closed'),
      }),
      needsApproval: true,
      handler: ({ input }) => callGithub(githubPatSetting, 'issue_write', {
        method: 'update',
        issue_number: input.issueNumber,
        state: 'closed',
        state_reason: input.reason,
      }),
    }),

    reopenIssue: tool({
      description: 'Reopen a closed issue in the configured GitHub repository.',
      parameters: z.object({ issueNumber: z.number() }),
      needsApproval: true,
      handler: ({ input }) => callGithub(githubPatSetting, 'issue_write', {
        method: 'update',
        issue_number: input.issueNumber,
        state: 'open',
      }),
    }),

    addIssueComment: tool({
      description: 'Add a comment to an issue in the configured GitHub repository.',
      parameters: z.object({
        issueNumber: z.number(),
        body: z.string(),
      }),
      needsApproval: true,
      handler: ({ input }) => callGithub(githubPatSetting, 'add_issue_comment', {
        issue_number: input.issueNumber,
        body: input.body,
      }),
    }),
  });
}
