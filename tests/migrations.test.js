import test from 'node:test';
import assert from 'node:assert/strict';
import {applySupabaseMigration} from '../src/hosted/migrations.js';
const env={SUPABASE_URL:'https://project-ref.supabase.co',SUPABASE_ACCESS_TOKEN:'fixture-operator-token'};

test('migration automation needs an operator credential and safe project URL before network access',async()=>{
  let calls=0;const fetchImpl=async()=>{calls++;};
  await assert.rejects(applySupabaseMigration({env:{},fetchImpl}),/SUPABASE_ACCESS_TOKEN/);
  await assert.rejects(applySupabaseMigration({env:{...env,SUPABASE_URL:'https://127.0.0.1'},fetchImpl}),/valid HTTPS/);
  assert.equal(calls,0);
});
test('initial setup applies the actual transactional migration and confirms its recorded version',async()=>{
  const queries=[];
  const result=await applySupabaseMigration({env,fetchImpl:async(url,options)=>{
    assert.equal(url,'https://api.supabase.com/v1/projects/project-ref/database/query');
    assert.equal(options.redirect,'error');
    const sql=JSON.parse(options.body).query;queries.push(sql);
    if(queries.length===1)return Response.json([{exists:false}]);
    if(queries.length===2){assert.match(sql,/create table public\.atlas_organizations/);assert.match(sql,/enable row level security/);assert.match(sql,/begin;/);assert.match(sql,/commit;/);return Response.json([]);}
    return Response.json([{version:'202610140001'}]);
  }});
  assert.deepEqual(result,{status:'applied',version:'202610140001'});assert.equal(queries.length,3);
});
test('repeated setup skips an applied migration and refuses unknown histories',async()=>{
  let calls=0;
  const result=await applySupabaseMigration({env,fetchImpl:async()=>Response.json(++calls===1?[{exists:true}]:[{version:'202610140001'}])});
  assert.equal(result.status,'already_applied');assert.equal(calls,2);
  calls=0;
  await assert.rejects(applySupabaseMigration({env,fetchImpl:async()=>Response.json(++calls===1?[{exists:true}]:[{version:'unrecognized'}])}),/different ATLAS migration history/);
  assert.equal(calls,2);
});
test('management failures never expose upstream error bodies, transport messages or credentials',async()=>{
  await assert.rejects(applySupabaseMigration({env,fetchImpl:async()=>new Response('fixture-private-upstream-detail',{status:403})}),error=>error.message.includes('HTTP 403')&&!error.message.includes('fixture-private'));
  await assert.rejects(applySupabaseMigration({env,fetchImpl:async()=>{throw new Error('fixture-private-upstream-detail');}}),error=>/not be confirmed/.test(error.message)&&!error.message.includes('fixture-private'));
});
