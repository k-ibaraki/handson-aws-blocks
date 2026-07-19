/**
 * `npm run pat:push:sandbox` / `npm run pat:push:prod`
 *
 * Pushes GITHUB_PAT from .env to the SSM SecureString parameter the deployed
 * app reads via AppSetting (aws-blocks/index.ts, github-mcp.ts). Run this
 * AFTER a deploy — AppSetting(secret) provisions the parameter (with a random
 * placeholder value) on first `npm run sandbox` / `npm run deploy`; this
 * script only overwrites its value.
 *
 * The parameter name is never printed with its value — this script only ever
 * prints the parameter NAME (a path, not a secret) on success, and error
 * messages never include the PAT.
 */
import { getStackName, loadEnvFile } from '@aws-blocks/blocks/scripts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { githubPatParameterName } from '../github-pat-naming.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

const target = process.argv[2];
if (target !== 'sandbox' && target !== 'prod') {
  console.error('Usage: tsx aws-blocks/scripts/pat-push.ts <sandbox|prod>');
  process.exit(1);
}

const envPath = join(projectRoot, '.env');
if (existsSync(envPath)) loadEnvFile(envPath);

async function main() {
  const pat = process.env.GITHUB_PAT;
  if (!pat) {
    console.error('GITHUB_PAT is not set in .env — nothing to push.');
    process.exit(1);
  }

  const stackName = getStackName({ sandbox: target === 'sandbox', projectRoot });
  const parameterName = githubPatParameterName(stackName);

  const { SSMClient, GetParameterCommand, PutParameterCommand } = await import('@aws-sdk/client-ssm');
  const client = new SSMClient({});

  // The parameter must already exist — AppSetting(secret) provisions it (with
  // a random placeholder) via a CloudFormation custom resource on first
  // deploy. Refuse to create it ourselves here: if the computed name doesn't
  // match what's actually deployed (app not deployed yet, or the naming
  // scheme drifted from AppSetting's own `/${fullId}` derivation — see
  // github-pat-naming.ts), a blind PutParameter would create an orphan
  // parameter the running Lambda never reads. Fail loudly instead.
  try {
    await client.send(new GetParameterCommand({ Name: parameterName, WithDecryption: false }));
  } catch (e: any) {
    if (e.name === 'ParameterNotFound') {
      console.error(
        `SSM parameter "${parameterName}" does not exist yet.\n` +
        `Deploy first (npm run ${target === 'sandbox' ? 'sandbox' : 'deploy'}) so AppSetting provisions it, then re-run this script.`
      );
      process.exit(1);
    }
    throw e;
  }

  await client.send(new PutParameterCommand({
    Name: parameterName,
    Value: pat,
    Type: 'SecureString',
    Overwrite: true,
  }));

  console.log(`GITHUB_PAT pushed to SSM parameter "${parameterName}" (${target}).`);
}

main().catch((err) => {
  // Print only the error message — never the raw error object, which for
  // AWS SDK errors can echo request metadata back to the terminal.
  console.error('Failed to push GITHUB_PAT:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
