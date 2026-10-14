// The local runtime is intentionally not a hosted entry point. Removing the Host
// check or relocating state to /tmp does not supply authentication or durability.
export const PRODUCTION_BLOCKERS = Object.freeze([
  'Supabase authentication and secure sessions have not been verified against the configured project.',
  'Production tenant-isolation and private evidence access must be verified after applying the migration.',
  'Managed Postgres migration and backup/restore must be verified on the actual managed service.',
  'Secure provider bindings and the exact HTTPS ATLAS_APP_URL are required.',
  'Vercel account access and the target build/worker limits have not been verified.'
]);

export function assertLocalRuntime(env = process.env) {
  if (env.VERCEL === undefined && env.NODE_ENV !== 'production') return;
  throw Object.assign(new Error(
    'ATLAS deployment blocked: Mission 1 is a local research instrument.\n' +
    PRODUCTION_BLOCKERS.map(message => `- ${message}`).join('\n') +
    '\nComplete Mission 2 and the launch gate before deploying. See docs/VERCEL.md.'
  ), {code: 'DEPLOYMENT_NOT_READY'});
}
