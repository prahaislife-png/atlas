import crypto from 'node:crypto';
import {emptyState} from '../../src/store.js';
import {validateProject} from '../../src/workspace.js';
export const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',V='33333333-3333-4333-8333-333333333333';
export const OA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',OB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const denial=(status=403)=>Object.assign(new Error('Permission denied'),{status});
export const config={url:'https://fixture-project.supabase.co',anonKey:'fixture-anon',serviceKey:'fixture-service',appOrigin:'',appHost:''};
export const profile=()=>validateProject({brand:'Research Business',domain:'https://example.com',urlConfirmed:true,country:'CZ',city:'Prague',languages:['English'],competitors:['Other Studio','Rival Business'],prompts:Array.from({length:8},(_,i)=>({text:`Which Prague beauty studios offer service ${i+1}?`,language:'English'}))});
export function fixtures() {
  const rows=new Map([[OA,{revision:0,state:{...emptyState(),project:profile()}}],[OB,{revision:0,state:{...emptyState(),project:{...profile(),brand:'Private B Business'}}}]]);
  const roles=new Map([[A+OA,'owner'],[B+OB,'owner'],[V+OA,'viewer']]);
  const identity=token=>({'fixture-a':A,'fixture-b':B,'fixture-viewer':V,'fixture-new':'44444444-4444-4444-8444-444444444444'}[token]);
  const calls=[];
  const client={calls,rows,roles,
    async user(token){const id=identity(token);if(!id)throw denial(401);return{id,email:id===A?'a@example.com':'b@example.com'};},
    async organizations(token){const user=identity(token);return[...rows.keys()].filter(id=>roles.has(user+id)).map(id=>({id,name:id===OA?'Team A':id===OB?'Team B':'New Team'}));},
    async membership(token,user,org){if(identity(token)!==user||!roles.has(user+org))throw denial();return roles.get(user+org);},
    async rateLimit(){},
    async call(route,options={}){
      calls.push({route,options});
      if(route.startsWith('/auth/v1/token')){if(options.body.password!=='fixture-password' && options.body.refresh_token!=='fixture-refresh')throw denial(401);return{access_token:options.body.email==='new@example.com'?'fixture-new':options.body.email==='b@example.com'?'fixture-b':options.body.email==='viewer@example.com'?'fixture-viewer':'fixture-a',refresh_token:'fixture-refresh',expires_in:3600};}
      if(route==='/auth/v1/logout'||route==='/rest/v1/atlas_audit_log')return null;
      if(route.startsWith('/rest/v1/atlas_project_versions?'))return[];
      if(route.startsWith('/rest/v1/atlas_workspaces?')){const org=route.match(/org_id=eq\.([^&]+)/)[1];if(!roles.has(identity(options.token)+org))return[];return[structuredClone(rows.get(org))];}
      throw new Error('Unexpected fixture route');
    },
    async rpc(name,value,options){
      calls.push({name,value,options});
      if(name==='atlas_commit_state'){
        if(!['owner','editor'].includes(roles.get(value.p_actor_id+value.p_org_id)))throw denial();
        const current=rows.get(value.p_org_id);if(current.revision!==value.p_revision)throw Object.assign(new Error('Conflict'),{status:409,code:'DB_CONFLICT'});
        rows.set(value.p_org_id,{revision:current.revision+1,state:structuredClone(value.p_state)});return current.revision+1;
      }
      if(name==='atlas_create_organization'){const id=crypto.randomUUID();roles.set(identity(options.token)+id,'owner');rows.set(id,{revision:0,state:emptyState()});return id;}
      if(name==='atlas_delete_organization')return null;
      if(name==='atlas_claim_job')return null;
      throw new Error('Unexpected fixture RPC');
    }
  };
  return client;
}
