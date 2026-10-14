import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import {createHostedHandler} from '../src/hosted/handler.js';
import {createSupabase,createSupabaseStore,supabaseConfig} from '../src/hosted/supabase.js';
import {processOneJob} from '../src/hosted/worker.js';
import {purgeDeletedOrganizations} from '../src/hosted/retention.js';
import {createOpenAIAdapter} from '../src/providers/openai.js';
import {emptyState} from '../src/store.js';
import {validateProject} from '../src/workspace.js';

import {A,B,V,OA,OB,config,profile,fixtures} from './helpers/hosted-fixture.js';
async function serve(t,{client=fixtures(),env={OPENAI_API_KEY:'fixture-provider-key'},adapter}={}) {
  const settings={...config};const server=http.createServer(createHostedHandler({client,env,config:settings,adapter}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;Object.assign(settings,{appOrigin:base,appHost:new URL(base).host});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  async function request(route,{token='fixture-a',org=OA,method='GET',body,origin=base,headers={}}={}){
    const result=await fetch(base+route,{method,headers:{...(token?{Cookie:`__Host-atlas-access=${token}; __Host-atlas-org=${org}`}:{ }),...(body!==undefined?{'Content-Type':'application/json',Origin:origin}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    return{status:result.status,body:await result.json(),headers:result.headers};
  }
  return{request,client};
}

test('hosted API requires verified authentication and rejects forged organization cookies and IDs',async t=>{
  const{request,client}=await serve(t);
  assert.equal((await request('/api/state',{token:''})).status,401);
  const a=await request('/api/state');assert.equal(a.status,200);assert.equal(a.body.hosted,true);assert.equal(a.body.organization.id,OA);
  assert.equal((await request('/api/state',{org:OB})).status,403);
  const b=await request('/api/state?orgId='+OA,{token:'fixture-b',org:OB});assert.equal(b.body.project.brand,'Private B Business');
  const forbidden=await request('/api/organizations/select',{method:'POST',body:{id:OB}});assert.equal(forbidden.status,403);assert.equal(forbidden.headers.has('set-cookie'),false);
  assert.equal(client.rows.get(OB).state.observations.length,0);
});
test('hosted login keeps tokens in secure HttpOnly cookies and returns no secrets in JSON',async t=>{
  const{request}=await serve(t);
  assert.equal((await request('/api/auth/login',{token:'',method:'POST',body:{email:'a@example.com',password:'wrong'}})).status,401);
  const result=await request('/api/auth/login',{token:'',method:'POST',body:{email:'a@example.com',password:'fixture-password'}});
  assert.equal(result.status,200);assert.deepEqual(result.body,{ok:true});
  const cookie=result.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Lax/);
  assert.equal(JSON.stringify(result.body).includes('fixture-a'),false);
  const out=await request('/api/auth/logout',{method:'POST',body:{}});assert.match(out.headers.get('set-cookie'),/Max-Age=0/);
});
test('hosted API rejects cross-origin/missing-Origin writes and viewer mutations',async t=>{
  const{request,client}=await serve(t);
  const value={title:'Review verified service details',detail:'Check the exact captured evidence with the owner.'};
  assert.equal((await request('/api/actions',{method:'POST',body:value,origin:'https://attacker.example'})).status,403);
  assert.equal((await request('/api/actions',{method:'POST',body:value,headers:{Origin:''}})).status,403);
  assert.equal((await request('/api/actions',{method:'POST',body:value,token:'fixture-viewer'})).status,403);
  assert.equal((await request('/api/state',{token:'fixture-viewer'})).status,200);
  assert.equal(client.rows.get(OA).state.actions.length,0);
});
test('hosted scan reserves once across simultaneous requests, queues durably, and never calls the provider inline',async t=>{
  let paidCalls=0;const adapter={provider:'openai',method:'api',model:'gpt-4.1-mini',engine:'API search',async collect(){paidCalls++;throw new Error('Unexpected inline collection');}};
  const{request,client}=await serve(t,{adapter});const id=client.rows.get(OA).state.project.prompts[0].id;
  const outcomes=await Promise.all([1,2].map(()=>request('/api/scan',{method:'POST',body:{promptIds:[id]}})));
  assert.deepEqual(outcomes.map(r=>r.status).sort(),[200,409]);
  assert.equal(outcomes.find(r=>r.status===200).body.queued,true);assert.equal(paidCalls,0);
  assert.equal(client.rows.get(OA).state.usage.length,1);assert.equal(client.rows.get(OA).state.runs.length,1);assert.equal(client.rows.get(OB).state.usage.length,0);
});
test('hosted organization creation uses authenticated ownership and an empty canonical workspace',async t=>{
  const{request,client}=await serve(t);
  const result=await request('/api/organizations',{method:'POST',body:{name:'New Team',ownerId:B}});assert.equal(result.status,201);
  const created=[...client.rows.keys()].find(id=>![OA,OB].includes(id));assert.equal(client.roles.get(A+created),'owner');assert.equal(client.roles.has(B+created),false);
  assert.deepEqual(client.rows.get(created).state.observations,[]);
});
test('Supabase configuration rejects unsafe origins and missing credentials without echoing values',()=>{
  const valid={SUPABASE_URL:'https://project-ref.supabase.co',SUPABASE_ANON_KEY:'fixture-anon',SUPABASE_SERVICE_ROLE_KEY:'fixture-service',ATLAS_APP_URL:'https://atlas.example.com'};
  assert.equal(supabaseConfig(valid).appHost,'atlas.example.com');
  for(const value of ['http://project-ref.supabase.co','https://127.0.0.1','https://project-ref.supabase.co.evil.com','https://project-ref.supabase.co/path'])assert.throws(()=>supabaseConfig({...valid,SUPABASE_URL:value}));
  assert.throws(()=>supabaseConfig({...valid,SUPABASE_SERVICE_ROLE_KEY:''}),/Configure SUPABASE_ANON_KEY/);
});
test('real Supabase client verifies user confirmation and sanitizes transport/provider errors',async()=>{
  const settings={...config,url:'https://fixture-project.supabase.co'};
  const client=createSupabase(settings,async(url,options)=>{assert.equal(url,settings.url+'/auth/v1/user');assert.equal(options.headers.Authorization,'Bearer fixture-access');return new Response(JSON.stringify({id:A,role:'authenticated',email_confirmed_at:null}),{status:200});});
  await assert.rejects(client.user('fixture-access'),{status:403});
  const unavailable=createSupabase(settings,async()=>{throw new Error('fixture-secret-must-not-escape');});
  await assert.rejects(unavailable.call('/auth/v1/user'),error=>error.status===503&&!error.message.includes('fixture-secret'));
  const denied=createSupabase(settings,async()=>new Response(JSON.stringify({message:'fixture-secret-must-not-escape'}),{status:403}));
  await assert.rejects(denied.call('/rest/v1/atlas_workspaces'),error=>error.status===403&&!error.message.includes('fixture-secret'));
  await assert.rejects(denied.loadRaw(OA,{bucket:'atlas-evidence',key:OB+'/file.json'}),{status:403});
});
test('Supabase store retries a CAS conflict against a freshly loaded state instead of losing another mutation',async()=>{
  const client=fixtures();let conflict=true;const rpc=client.rpc.bind(client);
  client.rpc=async(name,value,options)=>{if(conflict){conflict=false;client.rows.get(OA).revision++;client.rows.get(OA).state.actions.push({id:'other-request'});throw Object.assign(new Error('conflict'),{code:'DB_CONFLICT'});}return rpc(name,value,options);};
  const store=createSupabaseStore({client,token:'fixture-a',orgId:OA,actorId:A});await store.transaction(state=>state.actions.push({id:'this-request'}));
  assert.deepEqual((await store.read()).actions.map(a=>a.id),['other-request','this-request']);
});
test('expired durable jobs fail without another paid provider call and preserve their reservation',async()=>{
  let collected=0,finished;const client={async rpc(name,args){if(name==='atlas_claim_job')return{id:crypto.randomUUID(),org_id:OA,run_id:crypto.randomUUID(),prompt_id:crypto.randomUUID(),lease_token:crypto.randomUUID(),expired:true};finished=args;}};
  const result=await processOneJob({client,store:{},orgId:OA,actorId:A,env:{},adapter:{async collect(){collected++;}}});
  assert.equal(result.succeeded,false);assert.equal(collected,0);assert.equal(finished.p_error.code,'PROCESS_INTERRUPTED');assert.equal(finished.p_observation,null);
});

test('durable worker stores exact raw evidence privately before accepting a measured observation',async()=>{
  const project=profile(),runId=crypto.randomUUID(),prompt=project.prompts[0];let stored,finished,paid=0;
  const response={status:'completed',model:'gpt-4.1-mini-2025-04-14',output:[{type:'web_search_call',status:'completed'},{type:'message',status:'completed',content:[{type:'output_text',text:'TEST FIXTURE: Research Business offers a relevant service.',annotations:[{type:'url_citation',url:'https://example.com/services',title:'TEST FIXTURE source'}]}]}]};
  const adapter=createOpenAIAdapter({apiKey:'fixture-not-real',fetchImpl:async()=>{paid++;return new Response(JSON.stringify(response));}});
  const job={id:crypto.randomUUID(),run_id:runId,prompt_id:prompt.id,lease_token:crypto.randomUUID(),expired:false};
  const client={async rpc(name,args){if(name==='atlas_claim_job')return job;finished=args;},async storeRaw(org,run,id,evidence){stored={org,run,id,evidence};return{bucket:'atlas-evidence',key:`${org}/${run}/${id}.json`};}};
  const result=await processOneJob({client,store:{async read(){return{runs:[{id:runId,projectSnapshot:project,prompts:[prompt]}]};}},orgId:OA,actorId:A,env:{},adapter});
  assert.equal(result.succeeded,true);assert.equal(paid,1);assert.deepEqual(stored.evidence.rawResponse,response);
  assert.equal(finished.p_observation.model,response.model);assert.equal(finished.p_observation.brandMentioned,true);assert.equal(finished.p_observation.targetCited,true);
  assert.equal(finished.p_observation.rawResponse,undefined);assert.equal(finished.p_observation.rawRef.key.startsWith(OA+'/'),true);assert.equal(finished.p_error,null);
});
test('a storage failure cannot turn a paid answer into accepted evidence or leak service details',async()=>{
  const project=profile(),prompt=project.prompts[0],runId=crypto.randomUUID();let finished;
  const client={async rpc(name,args){if(name==='atlas_claim_job')return{id:crypto.randomUUID(),run_id:runId,prompt_id:prompt.id,lease_token:crypto.randomUUID(),expired:false};finished=args;},async storeRaw(){throw new Error('fixture-private-detail');}};
  const adapter={async collect(){return{rawResponse:{output_text:'TEST FIXTURE'},observedAt:new Date().toISOString()};}};
  await processOneJob({client,store:{async read(){return{runs:[{id:runId,projectSnapshot:project,prompts:[prompt]}]};}},orgId:OA,actorId:A,env:{},adapter});
  assert.equal(finished.p_observation,null);assert.equal(finished.p_error.code,'COLLECTION_FAILED');assert.equal(JSON.stringify(finished).includes('fixture-private-detail'),false);
});
test('retention deletes only the expired organization prefix before its audited database purge',async()=>{
  const operations=[];
  const client={async call(route,options){operations.push({route,options});if(route.startsWith('/rest/'))return[{id:OA}];if(route.includes('/list/'))return options.body.prefix===OA?[{name:'a-run',id:null}]:[{name:'evidence.json',id:'fixture-object'}];return{};},async rpc(name,args){operations.push({name,args});}};
  assert.deepEqual(await purgeDeletedOrganizations(client,new Date('2026-10-14T00:00:00Z')),{purged:1});
  const removal=operations.find(o=>o.options?.method==='DELETE');assert.deepEqual(removal.options.body.prefixes,[OA+'/a-run/evidence.json']);
  assert.equal(operations.at(-1).name,'atlas_purge_organization');assert.equal(operations.at(-1).args.p_org_id,OA);
});
