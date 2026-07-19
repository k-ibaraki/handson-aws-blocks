import { startDevServer, loadEnvFile } from '@aws-blocks/blocks/scripts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env (GITHUB_PAT/GITHUB_OWNER/GITHUB_REPO) into process.env for local
// dev — aws-blocks/index.ts and github-mcp.ts read these via process.env.
const envPath = join(__dirname, '..', '..', '.env');
if (existsSync(envPath)) loadEnvFile(envPath);

startDevServer({
  backendPath: join(__dirname, '..', 'index.ts'),
  frontendCommand: 'npx vite --port 3100 --strictPort',
  frontendPort: 3100,
});
