/**
 * Single source of truth for the GitHub PAT's SSM parameter name.
 *
 * `AppSetting` (see aws-blocks/index.ts) derives its SSM parameter name from
 * the construct scope tree as `/${fullId}`, where fullId is built by walking
 * up the scope chain: `${parent.fullId}-${id}`, rooted at the CloudFormation
 * stack name (see node_modules/@aws-blocks/core/src/common/index.ts,
 * `computeScopeFullId`). For `new AppSetting(scope, GITHUB_PAT_SETTING_ID)`
 * nested under `new Scope(APP_SCOPE_ID)`, that resolves to
 * `/${stackName}-${APP_SCOPE_ID}-${GITHUB_PAT_SETTING_ID}`.
 *
 * The pat:push:sandbox / pat:push:prod scripts need this same name to write
 * the parameter directly via SSM — they don't run inside the CDK/Lambda
 * context that would let them ask the AppSetting instance for it. Recomputing
 * the name here (rather than making the scripts synth the stack) keeps them
 * fast and credential-scoped to SSM only.
 */
export const APP_SCOPE_ID = 'my-app';
export const GITHUB_PAT_SETTING_ID = 'github-pat';

export function githubPatParameterName(stackName: string): string {
  return `/${stackName}-${APP_SCOPE_ID}-${GITHUB_PAT_SETTING_ID}`;
}
