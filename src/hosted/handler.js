import crypto from 'node:crypto';
import {createAtlasHandler} from '../../server.js';
import {emptyState} from '../store.js';
import {createSupabase, createSupabaseStore, supabaseConfig, uuid} from './supabase.js';
import {processOneJob} from './worker.js';

const accessCookie = '__Host-atlas-access';
const refreshCookie = '__Host-atlas-refresh';
const orgCookie = '__Host-atlas-org';
const fail = (status, message) => Object.assign(new Error(message), {status});
const send = (res, status, data) => { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(JSON.stringify(data)); };
function cookies(req) {
  const result = {};
  for (const part of (req.headers.cookie || '').split(';')) { const index = part.indexOf('='); if (index < 0) continue; try { result[part.slice(0,index).trim()] = decodeURIComponent(part.slice(index+1)); } catch {} }
  return result;
}
const cookie = (name, value, seconds) => `${name}=${encodeURIComponent(value)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;
function sessionCookies(res, session) {
  if (typeof session?.access_token !== 'string' || typeof session?.refresh_token !== 'string' || session.access_token.length > 8192 || session.refresh_token.length > 8192) throw fail(503, 'The authentication service returned an invalid session.');
  res.setHeader('Set-Cookie', [cookie(accessCookie,session.access_token,Math.min(3600,Number(session.expires_in)||3600)),cookie(refreshCookie,session.refresh_token,60*60*24*30)]);
}
async function body(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  let text = '';
  for await (const part of req) { text += part; if (Buffer.byteLength(text) > 8192) throw fail(413,'Request too large'); }
  try { const value = JSON.parse(text || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw fail(400,'Provide a JSON object.'); }
}

export function createHostedHandler({env = process.env, fetchImpl = fetch, adapter, client: injectedClient, config: injectedConfig} = {}) {
  return async function hosted(req,res) {
    try {
      const config = injectedConfig || supabaseConfig(env);
      const client = injectedClient || createSupabase(config,fetchImpl);
      if ((req.headers.host || '').toLowerCase() !== config.appHost.toLowerCase() || (req.headers.origin && req.headers.origin !== config.appOrigin) || req.headers['sec-fetch-site'] === 'cross-site') throw fail(403,'Application origin is not allowed.');
      if (!['GET','HEAD'].includes(req.method) && (req.headers.origin !== config.appOrigin || !String(req.headers['content-type'] || '').startsWith('application/json'))) throw fail(403,'Same-origin JSON requests are required.');
      const url = new URL(req.url,config.appOrigin);
      const saved = cookies(req);
      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        const source = req.headers['x-vercel-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
        const key = 'login:' + crypto.createHmac('sha256',config.serviceKey).update(String(source)).digest('hex');
        await client.rateLimit(key,10,600);
        const value = await body(req);
        if (typeof value.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email) || value.email.length > 320 || typeof value.password !== 'string' || !value.password || value.password.length > 1024) throw fail(400,'Enter your email address and password.');
        let session;
        try { session = await client.call('/auth/v1/token?grant_type=password',{method:'POST',body:{email:value.email.trim(),password:value.password}}); }
        catch (error) { if ([401,403].includes(error.status)) throw fail(401,'Sign-in failed. Check your credentials and confirm your email invitation.'); throw error; }
        await client.user(session.access_token);
        sessionCookies(res,session);
        return send(res,200,{ok:true});
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/refresh') {
        if (!saved[refreshCookie]) throw fail(401,'Sign in again to continue.');
        const session = await client.call('/auth/v1/token?grant_type=refresh_token',{method:'POST',body:{refresh_token:saved[refreshCookie]}});
        await client.user(session.access_token); sessionCookies(res,session);
        return send(res,200,{ok:true});
      }
      const token = saved[accessCookie];
      if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        // Clear local credentials even if provider-side revocation is unavailable.
        res.setHeader('Set-Cookie',[cookie(accessCookie,'',0),cookie(refreshCookie,'',0),cookie(orgCookie,'',0)]);
        if (token) { try { await client.call('/auth/v1/logout',{token,method:'POST'}); } catch {} }
        return send(res,200,{ok:true});
      }
      const user = await client.user(token);
      await client.rateLimit('user:'+user.id,120,60);
      if (req.method === 'POST' && url.pathname === '/api/organizations') {
        const value = await body(req);
        if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 120) throw fail(400,'Enter an organization name (1–120 characters).');
        const orgId = await client.rpc('atlas_create_organization',{p_name:value.name.trim(),p_initial_state:emptyState()},{token});
        if (!uuid(orgId)) throw fail(503,'The organization could not be created.');
        res.setHeader('Set-Cookie',cookie(orgCookie,orgId,60*60*24*30));
        return send(res,201,{ok:true});
      }
      const organizations = await client.organizations(token);
      if (req.method === 'GET' && url.pathname === '/api/auth/session') return send(res,200,{user,organizations});
      if (req.method === 'POST' && url.pathname === '/api/organizations/select') {
        const value = await body(req); await client.membership(token,user.id,value.id);
        res.setHeader('Set-Cookie',cookie(orgCookie,value.id,60*60*24*30));
        return send(res,200,{ok:true});
      }
      const orgId = saved[orgCookie] || organizations[0]?.id;
      if (!orgId) throw Object.assign(fail(409,'Create an organization to begin.'),{setupRequired:true});
      const role = await client.membership(token,user.id,orgId);
      if (!['GET','HEAD'].includes(req.method) && !['owner','editor'].includes(role)) throw fail(403,'Your role has read-only workspace access.');
      const store = createSupabaseStore({client,token,orgId,actorId:user.id});
      if (url.pathname === '/api/organizations/members') {
        if (role !== 'owner') throw fail(403,'Only an organization owner can manage membership.');
        if (req.method === 'GET') return send(res,200,await client.call(`/rest/v1/atlas_memberships?org_id=eq.${orgId}&select=user_id,role`,{token}));
        if (req.method === 'POST') {
          const value = await body(req);
          if (!uuid(value.userId) || (value.role !== null && !['owner','editor','viewer'].includes(value.role))) throw fail(400,'Choose a verified member account and valid role.');
          await client.rpc('atlas_set_member',{p_org_id:orgId,p_actor_id:user.id,p_user_id:value.userId,p_role:value.role},{service:true});
          return send(res,200,{ok:true});
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/worker/tick') return send(res,200,await processOneJob({client,store,orgId,actorId:user.id,env,adapter}));
      if (req.method === 'DELETE' && url.pathname === '/api/organizations/current') {
        const value = await body(req);
        if (role !== 'owner' || value.confirm !== 'DELETE') throw fail(403,'Only the owner can confirm workspace deletion.');
        await client.rpc('atlas_delete_organization',{p_org_id:orgId,p_actor_id:user.id},{service:true});
        res.setHeader('Set-Cookie',cookie(orgCookie,'',0)); return send(res,200,{ok:true});
      }
      await client.call('/rest/v1/atlas_audit_log',{service:true,method:'POST',body:{org_id:orgId,actor_id:user.id,event:'api.access',metadata:{method:req.method,route:url.pathname.replace(/[0-9a-f-]{36}/gi,':id')}},headers:{Prefer:'return=minimal'}});
      const hydrateObservation = async observation => observation.rawRef ? {...observation,...await client.loadRaw(orgId,observation.rawRef),id:observation.id,runId:observation.runId,promptId:observation.promptId} : observation;
      const hydrateRun = async run => ({...run,results:await Promise.all(run.results.map(async result => result.evidenceRef ? {...result,evidence:await client.loadRaw(orgId,result.evidenceRef)} : result))});
      if (req.method === 'GET' && url.pathname === '/api/project-versions') return send(res,200,await client.call(`/rest/v1/atlas_project_versions?org_id=eq.${orgId}&select=id,revision,archived_at&order=revision.desc`,{token}));
      const versionMatch=url.pathname.match(/^\/api\/project-versions\/(\d+)\/export$/);
      if (req.method === 'GET' && versionMatch) {
        const rows=await client.call(`/rest/v1/atlas_project_versions?org_id=eq.${orgId}&id=eq.${versionMatch[1]}&select=state_snapshot`,{token});
        if(rows.length!==1)throw fail(404,'Research version not found.');
        const snapshot=rows[0].state_snapshot;
        res.setHeader('Content-Disposition',`attachment; filename="atlas-research-version-${versionMatch[1]}.json"`);
        return send(res,200,{...snapshot,observations:await Promise.all(snapshot.observations.map(hydrateObservation)),runs:await Promise.all(snapshot.runs.map(hydrateRun))});
      }
      const organization = organizations.find(o => o.id === orgId);
      const handler = createAtlasHandler({store,env,adapter,hosted:true,hydrateObservation,hydrateRun,context:{hosted:true,user,organization:{...organization,role},organizations}});
      // Vercel can parse JSON request bodies before the handler receives the stream.
      if (req.body && typeof req.body === 'object') {
        const raw = Buffer.from(JSON.stringify(req.body));
        req[Symbol.asyncIterator] = async function*(){yield raw;};
      }
      return await handler(req,res);
    } catch (error) {
      if (res.headersSent) return res.destroy();
      const status = [400,401,403,404,409,413,429,503].includes(error.status) ? error.status : 503;
      return send(res,status,{error:error.status ? error.message : 'The production service is unavailable. No credentials or customer data were logged.',...(error.setupRequired?{setupRequired:true}:{})});
    }
  };
}
