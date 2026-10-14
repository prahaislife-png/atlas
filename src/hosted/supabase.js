const fail = (status, message, code) => Object.assign(new Error(message), {status, code});
export const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);

export function supabaseConfig(env = process.env, {requireAppOrigin = true} = {}) {
  let url;
  try { url = new URL(env.SUPABASE_URL); } catch { throw fail(503, 'Configure SUPABASE_URL securely before starting hosted ATLAS.'); }
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port) throw fail(503, 'SUPABASE_URL must be an HTTPS Supabase project origin.');
  const anonKey = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
  const serviceKey = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!anonKey || !serviceKey) throw fail(503, 'Configure SUPABASE_ANON_KEY (publishable key) and the server-only SUPABASE_SERVICE_ROLE_KEY (secret key) in secure environment settings.');
  // Explicit mode also works when cloud secrets are injected as opaque proxy
  // placeholders. Never infer key type by decoding or printing credential values.
  const keyMode = env.SUPABASE_KEY_MODE || (env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_SECRET_KEY ? 'modern' : 'legacy');
  if (!['modern','legacy'].includes(keyMode)) throw fail(503, 'SUPABASE_KEY_MODE must be modern or legacy.');
  const connection = {url: url.origin, anonKey, serviceKey, keyMode};
  if (!requireAppOrigin) return connection;
  let app;
  try { app = new URL(env.ATLAS_APP_URL); } catch { throw fail(503, 'Configure ATLAS_APP_URL to the exact HTTPS application origin.'); }
  if (app.protocol !== 'https:' || app.username || app.password || app.pathname !== '/' || app.search || app.hash) throw fail(503, 'ATLAS_APP_URL must be the exact HTTPS application origin.');
  return {...connection, appOrigin: app.origin, appHost: app.host};
}

export function createSupabase(config, fetchImpl = fetch) {
  async function call(route, {token, service = false, method = 'GET', body, headers = {}} = {}) {
    const key = service ? config.serviceKey : config.anonKey;
    const bearer = token || (config.keyMode === 'modern' ? undefined : key);
    let response;
    try {
      response = await fetchImpl(config.url + route, {method, headers: {apikey: key, ...(bearer ? {Authorization: `Bearer ${bearer}`} : {}), 'Content-Type': 'application/json', ...headers},
        ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(8000), redirect: 'error'});
    } catch { throw fail(503, 'The authentication or data service is unavailable. Please retry later.'); }
    let result;
    try { result = await response.json(); } catch { result = null; }
    if (!response.ok) {
      if (response.status === 400 && route.startsWith('/auth/v1/token')) throw fail(401, 'Sign-in failed. Check your credentials and email confirmation.');
      if (result?.code === '40001') throw fail(409, 'The workspace changed. Retry the operation.', 'DB_CONFLICT');
      if (response.status === 401 || response.status === 403 || result?.code === '42501') throw fail(response.status === 401 ? 401 : 403, 'Authentication or workspace permission was denied.');
      if (response.status === 429) throw fail(429, 'The service rate limit was reached. Please wait before retrying.');
      throw fail(503, 'The production data service rejected this operation. Verify migrations, service configuration and permissions.');
    }
    return result;
  }
  const rpc = (name, body, options = {}) => call(`/rest/v1/rpc/${name}`, {...options, method: 'POST', body});
  return {
    call, rpc,
    async user(token) {
      if (!token) throw fail(401, 'Sign in to your ATLAS account.');
      const user = await call('/auth/v1/user', {token});
      if (!uuid(user?.id) || !user.email_confirmed_at || user.role !== 'authenticated') throw fail(403, 'A verified email account is required. Confirm your invitation before signing in.');
      return {id: user.id, email: user.email};
    },
    async organizations(token) {
      return call('/rest/v1/atlas_organizations?select=id,name&order=created_at.asc', {token});
    },
    async membership(token, userId, orgId) {
      if (!uuid(orgId) || !uuid(userId)) throw fail(403, 'Workspace access denied.');
      const rows = await call(`/rest/v1/atlas_memberships?org_id=eq.${orgId}&user_id=eq.${userId}&select=role`, {token});
      if (rows?.length !== 1 || !['owner','editor','viewer'].includes(rows[0].role)) throw fail(403, 'Workspace access denied.');
      return rows[0].role;
    },
    async rateLimit(key, maximum, windowSeconds) {
      const allowed = await rpc('atlas_rate_limit', {p_key: key, p_max: maximum, p_window_seconds: windowSeconds}, {service: true});
      if (allowed !== true) throw fail(429, 'Too many requests. Please wait before retrying.');
    },
    async storeRaw(orgId, runId, evidenceId, evidence) {
      if (![orgId, runId, evidenceId].every(uuid)) throw fail(500, 'Invalid private evidence identity.');
      const key = `${orgId}/${runId}/${evidenceId}.json`;
      await call(`/storage/v1/object/atlas-evidence/${key}`, {service: true, method: 'POST', headers: {'x-upsert': 'false'}, body: evidence});
      return {bucket: 'atlas-evidence', key};
    },
    async loadRaw(orgId, reference) {
      if (reference?.bucket !== 'atlas-evidence' || !new RegExp(`^${orgId}/[a-f0-9-]{36}/[a-f0-9-]{36}\\.json$`, 'i').test(reference.key || '')) throw fail(403, 'Private evidence access denied.');
      return call(`/storage/v1/object/atlas-evidence/${reference.key}`, {service: true});
    }
  };
}

export function createSupabaseStore({client, token, orgId, actorId}) {
  async function row() {
    const rows = await client.call(`/rest/v1/atlas_workspaces?org_id=eq.${orgId}&select=revision,state`, {token});
    if (rows?.length !== 1) throw fail(404, 'Workspace not found or access denied.');
    return rows[0];
  }
  return {
    async read() { return structuredClone((await row()).state); },
    async transaction(update) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const current = await row();
        const draft = structuredClone(current.state);
        const result = await update(draft);
        try {
          await client.rpc('atlas_commit_state', {p_org_id: orgId, p_actor_id: actorId, p_revision: current.revision, p_state: draft}, {service: true});
          return structuredClone(result);
        } catch (error) { if (error.code !== 'DB_CONFLICT' || attempt === 3) throw error; }
      }
    },
    async close() {}
  };
}
