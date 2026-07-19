import * as cdk from 'aws-cdk-lib';
import { RemovalPolicies, Mixins } from 'aws-cdk-lib';

import { Hosting, BlocksStack, SandboxDisableDeletionProtection } from '@aws-blocks/blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { getStackName, loadEnvFile } from '@aws-blocks/blocks/scripts';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env (GITHUB_OWNER/GITHUB_REPO) so it can be baked into the Lambda's
// environment below. GITHUB_PAT is intentionally NOT read here — it must
// never end up in a plain Lambda env var; it's pushed to SSM SecureString
// instead (see scripts/pat-push.ts) and read at runtime via AppSetting.
const envPath = join(__dirname, '..', '.env');
if (existsSync(envPath)) loadEnvFile(envPath);

const app = new cdk.App();

const sandboxMode = app.node.tryGetContext('sandboxMode') === 'true';
const projectRoot = app.node.tryGetContext('projectRoot') || process.cwd();

const stackName = getStackName({ sandbox: sandboxMode, projectRoot });
export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts')
});

// ⚠️ 検証用アプリの設定 — AWS Blocks の既定では、本番相当のスタックは
// DynamoDB テーブルや S3 バケットなど本番データを持つリソースに
// RemovalPolicy.RETAIN を適用し、`npm run destroy` を実行してもスタック
// 削除後にデータごと残る（＝誤って本番データを失わない）ようになっている。
// このアプリは検証用のため、sandboxMode かどうかに関わらず常に全リソースを
// 削除可能にし、`npm run destroy` でデータも含めて完全に削除できるようにしている。
// 実運用アプリに転用する場合は、この2行を下の `if (sandboxMode)` ブロックの中に
// 戻し、本番データを保持する既定の挙動に戻すこと。
//
// NOTE: RemovalPolicy はデプロイ済みの CloudFormation テンプレートに焼き込まれる
// 設定であり、`cdk destroy` はテンプレートを再生成せず既存のテンプレート通りに
// 削除するだけ（`cdk deploy` を経ないと反映されない）。そのため、この変更を
// 取り込む前にデプロイ済みのスタックに対しては、`npm run deploy` で一度
// テンプレートを更新してから `npm run destroy` を実行しないと、データが
// 削除されずに残ったままになる。
RemovalPolicies.of(blocksStack).destroy();
Mixins.of(blocksStack).apply(new SandboxDisableDeletionProtection());

if (sandboxMode) {
  // Tell the runtime that cookies need cross-domain attributes (frontend on
  // localhost, API on API Gateway — different registrable domains).
  blocksStack.handler.addEnvironment('BLOCKS_SANDBOX', 'true');
}

// Bake the target GitHub repo (from .env) into the Lambda's environment for
// both sandbox and production — the GitHub tools (aws-blocks/github-issue-tools.ts)
// read these at runtime instead of hardcoding a repo. GITHUB_PAT is never
// baked in here (see comment above) — it's read from AppSetting at runtime.
if (process.env.GITHUB_OWNER) blocksStack.handler.addEnvironment('GITHUB_OWNER', process.env.GITHUB_OWNER);
if (process.env.GITHUB_REPO) blocksStack.handler.addEnvironment('GITHUB_REPO', process.env.GITHUB_REPO);

// Add static site hosting only when deploying (not in sandbox mode)
if (!sandboxMode) {
  new Hosting(blocksStack, 'Hosting', {
    root: join(__dirname, '..'),
    buildCommand: 'npm run build',
    buildOutputDir: 'dist',
    api: blocksStack
  });
}