\set ON_ERROR_STOP on
insert into auth.users values
 ('11111111-1111-4111-8111-111111111111','owner-a@example.com',now()),
 ('22222222-2222-4222-8222-222222222222','owner-b@example.com',now()),
 ('33333333-3333-4333-8333-333333333333','viewer@example.com',now()),
 ('44444444-4444-4444-8444-444444444444','unverified@example.com',null);

set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.atlas_create_organization('Organization A','{"schemaVersion":2,"observations":[],"usage":[]}') as org_a \gset
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
select public.atlas_create_organization('Organization B','{"schemaVersion":2,"observations":[],"usage":[]}') as org_b \gset
reset role;
insert into public.atlas_memberships values(:'org_a','33333333-3333-4333-8333-333333333333','viewer');
insert into storage.objects(bucket_id,name) values('atlas-evidence',:'org_a'||'/run/evidence.json'),('atlas-evidence',:'org_b'||'/run/evidence.json');
select set_config('test.org_a',:'org_a',false),set_config('test.org_b',:'org_b',false);

set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
do $$begin
 if (select count(*) from atlas_organizations)<>1 or (select name from atlas_organizations)<>'Organization A' then raise exception 'RLS organization leak'; end if;
 if (select count(*) from atlas_workspaces)<>1 then raise exception 'RLS workspace leak'; end if;
 if exists(select 1 from atlas_workspaces where org_id=current_setting('test.org_b')::uuid) then raise exception 'Cross-tenant read'; end if;
 if (select count(*) from storage.objects)<>1 then raise exception 'Private evidence leak'; end if;
 begin update atlas_workspaces set state='{}'; raise exception 'Direct writes permitted'; exception when insufficient_privilege then null; end;
 begin perform atlas_commit_state(current_setting('test.org_a')::uuid,auth.uid(),0,'{}'); raise exception 'Private write RPC exposed'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',false);
do $$begin
 begin perform atlas_create_organization('Unverified','{"schemaVersion":2,"observations":[],"usage":[]}'); raise exception 'Unverified account accepted'; exception when insufficient_privilege then null; end;
end $$;
reset role;

set role service_role;
do $$declare v_org uuid:=current_setting('test.org_a')::uuid; v_state jsonb; v_rev bigint; v_job jsonb; v_expired jsonb; begin
 -- Even a server mutation must supply a verified actor who belongs to this org.
 begin perform atlas_commit_state(v_org,'22222222-2222-4222-8222-222222222222',0,'{}'); raise exception 'Cross-org actor accepted'; exception when insufficient_privilege then null; end;
 begin perform atlas_commit_state(v_org,'33333333-3333-4333-8333-333333333333',0,'{}'); raise exception 'Viewer write accepted'; exception when insufficient_privilege then null; end;
 select state into v_state from atlas_workspaces where org_id=v_org;
 v_state:=jsonb_set(v_state,'{project,brand}','"Real Business"');
 perform atlas_commit_state(v_org,'11111111-1111-4111-8111-111111111111',0,v_state);
 begin perform atlas_commit_state(v_org,'11111111-1111-4111-8111-111111111111',0,v_state); raise exception 'Stale revision accepted'; exception when serialization_failure then null; end;
 if (select count(*) from atlas_project_versions where org_id=v_org)<>1 then raise exception 'Project history lost'; end if;
 v_state:=jsonb_set(v_state,'{usage}','[{"date":"2026-10-14","runId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","reservedUsd":0.05}]');
 v_state:=jsonb_set(v_state,'{runs}','[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","status":"running","prompts":[{"id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","text":"Unbranded buyer question"}],"results":[{"promptId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","status":"pending"}]}]');
 perform atlas_commit_state(v_org,'11111111-1111-4111-8111-111111111111',1,v_state);
 v_job:=atlas_claim_job(v_org,'11111111-1111-4111-8111-111111111111');
 if v_job is null or (v_job->>'expired')::boolean then raise exception 'Queue claim failed'; end if;
 if atlas_claim_job(v_org,'11111111-1111-4111-8111-111111111111') is not null then raise exception 'Active lease duplicated'; end if;
 perform atlas_finish_job((v_job->>'id')::uuid,(v_job->>'lease_token')::uuid,'11111111-1111-4111-8111-111111111111',
 '{"id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","runId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","promptId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","mode":"live","answer":"Test evidence, never production data"}',null,null);
 select state,revision into v_state,v_rev from atlas_workspaces where org_id=v_org;
 if v_state->'runs'->0->>'status'<>'completed' or jsonb_array_length(v_state->'observations')<>1 then raise exception 'Durable result missing'; end if;
 begin perform atlas_commit_state(v_org,'11111111-1111-4111-8111-111111111111',v_rev,jsonb_set(v_state,'{observations}','[]')); raise exception 'Evidence deletion accepted'; exception when raise_exception then if sqlerrm='Evidence deletion accepted' then raise; end if; end;
 begin perform atlas_finish_job((v_job->>'id')::uuid,(v_job->>'lease_token')::uuid,'11111111-1111-4111-8111-111111111111',null,'{}'); raise exception 'Completed lease reused'; exception when serialization_failure then null; end;
 v_state:=jsonb_set(v_state,'{usage}',v_state->'usage'||'[{"date":"2026-10-14","runId":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","reservedUsd":0.05}]'::jsonb);
 v_state:=jsonb_set(v_state,'{runs}',v_state->'runs'||'[{"id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","status":"running","prompts":[{"id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"}],"results":[{"promptId":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","status":"pending"}]}]'::jsonb);
 perform atlas_commit_state(v_org,'11111111-1111-4111-8111-111111111111',v_rev,v_state);
 v_job:=atlas_claim_job(v_org,'11111111-1111-4111-8111-111111111111');
 update atlas_scan_jobs set lease_until=now()-interval '1 minute' where id=(v_job->>'id')::uuid;
 v_expired:=atlas_claim_job(v_org,'11111111-1111-4111-8111-111111111111');
 if not (v_expired->>'expired')::boolean or v_expired->>'lease_token'=v_job->>'lease_token' then raise exception 'Expired lease not isolated'; end if;
 begin perform atlas_finish_job((v_job->>'id')::uuid,(v_job->>'lease_token')::uuid,'11111111-1111-4111-8111-111111111111',null,'{}'); raise exception 'Old worker lease accepted'; exception when serialization_failure then null; end;
 perform atlas_finish_job((v_expired->>'id')::uuid,(v_expired->>'lease_token')::uuid,'11111111-1111-4111-8111-111111111111',null,'{"code":"PROCESS_INTERRUPTED"}');
 select state into v_state from atlas_workspaces where org_id=v_org;
 if v_state->'runs'->1->>'status'<>'failed' or jsonb_array_length(v_state->'usage')<>2 or jsonb_array_length(v_state->'observations')<>1 then raise exception 'Recovery fabricated evidence or refunded usage'; end if;
 perform atlas_set_member(v_org,'11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','editor');
 if (select role from atlas_memberships where org_id=v_org and user_id='33333333-3333-4333-8333-333333333333')<>'editor' then raise exception 'Role change missing'; end if;
 begin perform atlas_set_member(v_org,'11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','viewer'); raise exception 'Last owner removed'; exception when raise_exception then if sqlerrm='Last owner removed' then raise; end if; end;
 begin perform atlas_set_member(v_org,'33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','owner'); raise exception 'Editor changed owner'; exception when insufficient_privilege then null; end;
 perform atlas_delete_organization(v_org,'11111111-1111-4111-8111-111111111111');
end $$;
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
do $$begin
 if exists(select 1 from atlas_workspaces) or exists(select 1 from storage.objects) then raise exception 'Deleted tenant still readable'; end if;
end $$;
reset role;
do $$begin
 if not exists(select 1 from atlas_audit_log where event='organization.deletion_requested') then raise exception 'Delete not audited'; end if;
 if (select public from storage.buckets where id='atlas-evidence') then raise exception 'Evidence bucket public'; end if;
 begin perform atlas_purge_organization(current_setting('test.org_a')::uuid); raise exception 'Premature purge permitted'; exception when raise_exception then if sqlerrm='Premature purge permitted' then raise; end if; end;
 update atlas_organizations set deleted_at=now()-interval '31 days' where id=current_setting('test.org_a')::uuid;
 begin perform atlas_purge_organization(current_setting('test.org_a')::uuid); raise exception 'Purge ignored retained storage'; exception when raise_exception then if sqlerrm='Purge ignored retained storage' then raise; end if; end;
 -- Test-only storage stub: this deletion represents successful Storage API removal.
 delete from storage.objects where name like current_setting('test.org_a')||'/%';
 perform atlas_purge_organization(current_setting('test.org_a')::uuid);
 if exists(select 1 from atlas_workspaces where org_id=current_setting('test.org_a')::uuid) then raise exception 'Purged workspace retained'; end if;
 if not exists(select 1 from atlas_audit_log where event='organization.purged') then raise exception 'Purge not audited'; end if;
end $$;
select 'PASS: RLS, forbidden mutations, verified users, private evidence, CAS, durable jobs, immutable history, audited deletion';
