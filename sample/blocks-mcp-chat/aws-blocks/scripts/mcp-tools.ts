/**
 * `npm run mcp:tools [-- <filter>]`
 *
 * Queries `tools/list` on the GitHub official remote MCP server
 * (https://api.githubcopilot.com/mcp/) and prints each tool's name,
 * description, and input schema. Run this BEFORE writing any GitHub tool
 * proxy — remote MCP tool names/schemas can change without notice, so the
 * proxy in aws-blocks/github-mcp-tools.ts must be written against what this
 * script actually returns, not guessed names.
 *
 * Reads GITHUB_PAT from .env (never printed). An optional filter narrows
 * output to tools whose name or description contains the given substring
 * (case-insensitive) — e.g. `npm run mcp:tools -- issue`.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '@aws-blocks/blocks/scripts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

const envPath = join(projectRoot, '.env');
if (existsSync(envPath)) loadEnvFile(envPath);

const GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/';

async function main() {
  const pat = process.env.GITHUB_PAT;
  if (!pat) {
    console.error('GITHUB_PAT is not set. Add it to .env first (see .env.example).');
    process.exit(1);
  }

  const filter = process.argv[2]?.toLowerCase();

  const client = new Client({ name: 'blocks-mcp-chat-tools-inspector', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(GITHUB_MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${pat}` } },
  });

  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const filtered = filter
      ? tools.filter((t) => t.name.toLowerCase().includes(filter) || t.description?.toLowerCase().includes(filter))
      : tools;

    for (const tool of filtered) {
      console.log(`\n- ${tool.name}`);
      console.log(`  description: ${tool.description ?? '(none)'}`);
      console.log(`  inputSchema: ${JSON.stringify(tool.inputSchema)}`);
    }
    console.log(`\nTotal: ${filtered.length} tool(s)${filter ? ` matching "${filter}"` : ''} (of ${tools.length})`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  // Print only the error message — never the raw error object, which could
  // echo request details (headers, URLs) back to the terminal.
  console.error('Failed to query tools/list:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
