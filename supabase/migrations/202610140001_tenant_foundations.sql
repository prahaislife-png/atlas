begin;
revoke create on schema public from public,anon,authenticated;
create table public.atlas_schema_migrations(version text primary key,applied_at timestamptz not null default now());
alter table public.atlas_schema_migrations enable row level security;
revoke all on public.atlas_schema_migrations from public,anon,authenticated;
grant select on public.atlas_schema_migrations to service_role;

create table public.atlas_organizations (
 id uuid primary key default gen_random_uuid(), name text not null check(length(name) between 1 and 120),
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(), deleted_at timestamptz
);
create table public.atlas_memberships (
 org_id uuid not null references public.atlas_organizations(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 role text not null check(role in ('owner','editor','viewer')), primary key(org_id,user_id)
);
create table public.atlas_workspaces (
 org_id uuid primary key references public.atlas_organizations(id) on delete cascade,
 revision bigint not null default 0, state jsonb not null check(jsonb_typeof(state)='object'), updated_at timestamptz not null default now()
);
create table public.atlas_project_versions (
 id bigint generated always as identity primary key, org_id uuid not null references public.atlas_organizations(id) on delete cascade,
 revision bigint not null, state_snapshot jsonb not null, archived_at timestamptz not null default now(), unique(org_id,revision)
);
create table public.atlas_scan_jobs (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references public.atlas_organizations(id) on delete cascade,
 run_id uuid not null, prompt_id uuid not null, status text not null default 'queued' check(status in ('queued','running','succeeded','failed')),
 lease_token uuid, lease_until timestamptz, created_at timestamptz not null default now(), finished_at timestamptz,
 unique(org_id,run_id,prompt_id)
);
create index atlas_jobs_claim on public.atlas_scan_jobs(org_id,created_at) where status in ('queued','running');
create table public.atlas_audit_log (
 id bigint generated always as identity primary key, org_id uuid not null, actor_id uuid,
 event text not null, metadata jsonb not null default '{}', occurred_at timestamptz not null default now()
);
create table public.atlas_rate_limits (key text primary key, window_start timestamptz not null, count integer not null);

create function public.atlas_role(p_org_id uuid) returns text language sql stable security definer set search_path=public,pg_temp as $$
 select m.role from public.atlas_memberships m join public.atlas_organizations o on o.id=m.org_id
 where m.org_id=p_org_id and m.user_id=auth.uid() and o.deleted_at is null
$$;
revoke all on function public.atlas_role(uuid) from public;
grant execute on function public.atlas_role(uuid) to authenticated;

alter table public.atlas_organizations enable row level security;
alter table public.atlas_memberships enable row level security;
alter table public.atlas_workspaces enable row level security;
alter table public.atlas_project_versions enable row level security;
alter table public.atlas_scan_jobs enable row level security;
alter table public.atlas_audit_log enable row level security;
alter table public.atlas_rate_limits enable row level security;
create policy atlas_org_read on public.atlas_organizations for select to authenticated using(public.atlas_role(id) is not null);
create policy atlas_member_read on public.atlas_memberships for select to authenticated using((user_id=auth.uid() and public.atlas_role(org_id) is not null) or public.atlas_role(org_id)='owner');
create policy atlas_workspace_read on public.atlas_workspaces for select to authenticated using(public.atlas_role(org_id) is not null);
create policy atlas_version_read on public.atlas_project_versions for select to authenticated using(public.atlas_role(org_id) is not null);
create policy atlas_job_read on public.atlas_scan_jobs for select to authenticated using(public.atlas_role(org_id) is not null);
create policy atlas_audit_read on public.atlas_audit_log for select to authenticated using(public.atlas_role(org_id)='owner');
revoke all on public.atlas_organizations,public.atlas_memberships,public.atlas_workspaces,public.atlas_project_versions,public.atlas_scan_jobs,public.atlas_audit_log,public.atlas_rate_limits from anon,authenticated;
grant select on public.atlas_organizations,public.atlas_memberships,public.atlas_workspaces,public.atlas_project_versions,public.atlas_scan_jobs,public.atlas_audit_log to authenticated;
grant all on public.atlas_organizations,public.atlas_memberships,public.atlas_workspaces,public.atlas_project_versions,public.atlas_scan_jobs,public.atlas_audit_log,public.atlas_rate_limits to service_role;
grant usage,select on sequence public.atlas_project_versions_id_seq,public.atlas_audit_log_id_seq to service_role;

-- Called with a verified user JWT; no browser-supplied owner/actor ID is accepted.
create function public.atlas_create_organization(p_name text,p_initial_state jsonb) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid; v_user uuid:=auth.uid();
begin
 if v_user is null or not exists(select 1 from auth.users where id=v_user and email_confirmed_at is not null) then raise exception 'Verified account required' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_user::text,0));
 if (select count(*) from atlas_organizations where created_by=v_user and deleted_at is null)>=3 then raise exception 'Organization limit reached' using errcode='P0001'; end if;
 if length(trim(p_name)) not between 1 and 120 or p_initial_state->>'schemaVersion'<>'2' or jsonb_array_length(p_initial_state->'observations')<>0 or jsonb_array_length(p_initial_state->'usage')<>0 then raise exception 'Invalid initial workspace'; end if;
 insert into atlas_organizations(name,created_by) values(trim(p_name),v_user) returning id into v_id;
 insert into atlas_memberships values(v_id,v_user,'owner');
 insert into atlas_workspaces(org_id,state) values(v_id,jsonb_build_object('schemaVersion',2,'project',jsonb_build_object('brand','','aliases','[]'::jsonb,'domain','','city','','country','CZ','languages','[]'::jsonb,'timezone','Europe/Prague','competitors','[]'::jsonb,'prompts','[]'::jsonb,'onboarded',false),'observations','[]'::jsonb,'runs','[]'::jsonb,'actions','[]'::jsonb,'usage','[]'::jsonb,'createdAt',now()));
 insert into atlas_audit_log(org_id,actor_id,event) values(v_id,v_user,'organization.created');
 return v_id;
end $$;
revoke all on function public.atlas_create_organization(text,jsonb) from public;
grant execute on function public.atlas_create_organization(text,jsonb) to authenticated;

-- Writes require a private server credential AND an independently verified actor.
-- Authenticated REST clients have read-only RLS access and cannot forge evidence.
create function public.atlas_require_editor(p_org_id uuid,p_actor_id uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not exists(select 1 from atlas_memberships m join atlas_organizations o on o.id=m.org_id
  where m.org_id=p_org_id and m.user_id=p_actor_id and m.role in ('owner','editor') and o.deleted_at is null)
 then raise exception 'Forbidden' using errcode='42501'; end if;
end $$;

create function public.atlas_commit_state(p_org_id uuid,p_actor_id uuid,p_revision bigint,p_state jsonb) returns bigint
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_old jsonb; v_revision bigint; v_run jsonb; v_prompt jsonb; v_changed boolean;
begin
 perform atlas_require_editor(p_org_id,p_actor_id);
 select state,revision into v_old,v_revision from atlas_workspaces where org_id=p_org_id for update;
 if v_revision is distinct from p_revision then raise exception 'Workspace changed; retry' using errcode='40001'; end if;
 if p_state->'schemaVersion' is distinct from '2'::jsonb or jsonb_typeof(p_state->'project') is distinct from 'object' or jsonb_typeof(p_state->'usage') is distinct from 'array' or jsonb_typeof(p_state->'observations') is distinct from 'array' or jsonb_typeof(p_state->'runs') is distinct from 'array' or jsonb_typeof(p_state->'actions') is distinct from 'array' then raise exception 'Invalid state'; end if;
 if jsonb_array_length(p_state->'usage')<jsonb_array_length(v_old->'usage') or exists(
  select 1 from jsonb_array_elements(v_old->'usage') with ordinality x(value,n) where value is distinct from p_state->'usage'->(n::integer-1)) then raise exception 'Usage is append-only'; end if;
 v_changed:=v_old->'project' is distinct from p_state->'project';
 if v_changed then
  if exists(select 1 from atlas_scan_jobs where org_id=p_org_id and status in ('queued','running')) then raise exception 'Wait for active scans' using errcode='40001'; end if;
  insert into atlas_project_versions(org_id,revision,state_snapshot) values(p_org_id,v_revision,v_old) on conflict do nothing;
 else
  if jsonb_array_length(p_state->'observations')<jsonb_array_length(v_old->'observations') or exists(
   select 1 from jsonb_array_elements(v_old->'observations') with ordinality x(value,n) where value is distinct from p_state->'observations'->(n::integer-1)) then raise exception 'Evidence is immutable'; end if;
  for v_run in select value from jsonb_array_elements(v_old->'runs') where value->>'status'<>'running' loop
   if not exists(select 1 from jsonb_array_elements(p_state->'runs') x where x=v_run) then raise exception 'Completed runs are immutable'; end if;
  end loop;
 end if;
 for v_run in select value from jsonb_array_elements(p_state->'runs') x where not exists(select 1 from jsonb_array_elements(v_old->'runs') y where y->>'id'=x->>'id') loop
  if v_run->>'status'<>'running' or not exists(select 1 from jsonb_array_elements(p_state->'usage') u where u->>'runId'=v_run->>'id') then raise exception 'A run requires its reserved budget'; end if;
  for v_prompt in select value from jsonb_array_elements(v_run->'prompts') loop
   insert into atlas_scan_jobs(org_id,run_id,prompt_id) values(p_org_id,(v_run->>'id')::uuid,(v_prompt->>'id')::uuid);
  end loop;
 end loop;
 update atlas_workspaces set state=p_state,revision=revision+1,updated_at=now() where org_id=p_org_id;
 insert into atlas_audit_log(org_id,actor_id,event,metadata) values(p_org_id,p_actor_id,case when v_changed then 'project.versioned' else 'workspace.updated' end,jsonb_build_object('revision',v_revision+1));
 return v_revision+1;
end $$;

create function public.atlas_claim_job(p_org_id uuid,p_actor_id uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job atlas_scan_jobs; v_expired boolean;
begin
 perform atlas_require_editor(p_org_id,p_actor_id);
 select * into v_job from atlas_scan_jobs where org_id=p_org_id and (status='queued' or (status='running' and lease_until<now()))
 order by case when status='running' then 0 else 1 end,created_at for update skip locked limit 1;
 if not found then return null; end if;
 v_expired:=v_job.status='running';
 update atlas_scan_jobs set status='running',lease_token=gen_random_uuid(),lease_until=now()+interval '90 seconds' where id=v_job.id returning * into v_job;
 return to_jsonb(v_job)||jsonb_build_object('expired',v_expired);
end $$;

create function public.atlas_finish_job(p_job_id uuid,p_lease_token uuid,p_actor_id uuid,p_observation jsonb,p_error jsonb,p_failed_evidence jsonb default null) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job atlas_scan_jobs; v_state jsonb; v_runs jsonb:='[]'; v_run jsonb; v_result jsonb; v_results jsonb; v_status text; v_good integer; v_pending integer;
begin
 select * into v_job from atlas_scan_jobs where id=p_job_id for update;
 if not found or v_job.status<>'running' or v_job.lease_token is distinct from p_lease_token then raise exception 'Job lease is no longer valid' using errcode='40001'; end if;
 perform atlas_require_editor(v_job.org_id,p_actor_id);
 if v_job.lease_until<now() then p_observation:=null; p_error:='{"code":"PROCESS_INTERRUPTED","message":"The worker lease expired. No successful observation was accepted; its reservation is retained."}'; end if;
 if (p_observation is null)=(p_error is null) then raise exception 'Provide observation or failure'; end if;
 select state into v_state from atlas_workspaces where org_id=v_job.org_id for update;
 if p_observation is not null then
  if p_observation->>'runId'<>v_job.run_id::text or p_observation->>'promptId'<>v_job.prompt_id::text then raise exception 'Observation context mismatch'; end if;
  v_state:=jsonb_set(v_state,'{observations}',v_state->'observations'||jsonb_build_array(p_observation));
 end if;
 for v_run in select value from jsonb_array_elements(v_state->'runs') loop
  if v_run->>'id'=v_job.run_id::text then
   v_results:='[]'; v_good:=0; v_pending:=0;
   for v_result in select value from jsonb_array_elements(v_run->'results') loop
    if v_result->>'promptId'=v_job.prompt_id::text then
     if p_observation is not null then v_result:=v_result||jsonb_build_object('status','succeeded','observationId',p_observation->>'id');
     else v_result:=v_result||jsonb_build_object('status','failed','error',p_error); if p_failed_evidence is not null then v_result:=v_result||jsonb_build_object('evidenceRef',p_failed_evidence); end if; end if;
    end if;
    if v_result->>'status'='succeeded' then v_good:=v_good+1; elsif v_result->>'status'='pending' then v_pending:=v_pending+1; end if;
    v_results:=v_results||jsonb_build_array(v_result);
   end loop;
   v_status:=case when v_pending>0 then 'running' when v_good=jsonb_array_length(v_results) then 'completed' when v_good>0 then 'partial' else 'failed' end;
   v_run:=v_run||jsonb_build_object('results',v_results,'status',v_status,'finishedAt',case when v_pending=0 then to_jsonb(now()) else 'null'::jsonb end);
  end if;
  v_runs:=v_runs||jsonb_build_array(v_run);
 end loop;
 v_state:=jsonb_set(v_state,'{runs}',v_runs);
 update atlas_workspaces set state=v_state,revision=revision+1,updated_at=now() where org_id=v_job.org_id;
 update atlas_scan_jobs set status=case when p_observation is null then 'failed' else 'succeeded' end,finished_at=now(),lease_until=null where id=p_job_id;
 insert into atlas_audit_log(org_id,actor_id,event,metadata) values(v_job.org_id,p_actor_id,'scan.question.finished',jsonb_build_object('jobId',p_job_id,'succeeded',p_observation is not null));
end $$;

create function public.atlas_rate_limit(p_key text,p_max integer,p_window_seconds integer) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_count integer;
begin
 if p_max<1 or p_window_seconds<1 or length(p_key)>200 then raise exception 'Invalid limit'; end if;
 insert into atlas_rate_limits as r(key,window_start,count) values(p_key,now(),1)
 on conflict(key) do update set window_start=case when r.window_start<now()-make_interval(secs=>p_window_seconds) then now() else r.window_start end,
 count=case when r.window_start<now()-make_interval(secs=>p_window_seconds) then 1 else r.count+1 end returning count into v_count;
 return v_count<=p_max;
end $$;

create function public.atlas_delete_organization(p_org_id uuid,p_actor_id uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not exists(select 1 from atlas_memberships where org_id=p_org_id and user_id=p_actor_id and role='owner') then raise exception 'Owner required' using errcode='42501'; end if;
 update atlas_organizations set deleted_at=now() where id=p_org_id and deleted_at is null;
 insert into atlas_audit_log(org_id,actor_id,event) values(p_org_id,p_actor_id,'organization.deletion_requested');
end $$;

create function public.atlas_set_member(p_org_id uuid,p_actor_id uuid,p_user_id uuid,p_role text) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform 1 from atlas_organizations where id=p_org_id and deleted_at is null for update;
 if not found or not exists(select 1 from atlas_memberships where org_id=p_org_id and user_id=p_actor_id and role='owner') then raise exception 'Owner required' using errcode='42501'; end if;
 if not exists(select 1 from auth.users where id=p_user_id and email_confirmed_at is not null) then raise exception 'Verified member account required' using errcode='42501'; end if;
 if p_role is not null and p_role not in ('owner','editor','viewer') then raise exception 'Invalid role'; end if;
 if exists(select 1 from atlas_memberships where org_id=p_org_id and user_id=p_user_id and role='owner') and p_role is distinct from 'owner' and (select count(*) from atlas_memberships where org_id=p_org_id and role='owner')<=1 then raise exception 'The last owner cannot be removed'; end if;
 if p_role is null then delete from atlas_memberships where org_id=p_org_id and user_id=p_user_id;
 else insert into atlas_memberships(org_id,user_id,role) values(p_org_id,p_user_id,p_role) on conflict(org_id,user_id) do update set role=excluded.role; end if;
 insert into atlas_audit_log(org_id,actor_id,event,metadata) values(p_org_id,p_actor_id,'membership.changed',jsonb_build_object('userId',p_user_id,'role',p_role));
end $$;

create function public.atlas_purge_organization(p_org_id uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform 1 from atlas_organizations where id=p_org_id and deleted_at<now()-interval '30 days' for update;
 if not found then raise exception 'Deletion retention window has not elapsed'; end if;
 if exists(select 1 from storage.objects where bucket_id='atlas-evidence' and name like p_org_id::text||'/%') then raise exception 'Purge private objects through Storage API first'; end if;
 delete from atlas_organizations where id=p_org_id;
 insert into atlas_audit_log(org_id,event) values(p_org_id,'organization.purged');
 delete from atlas_audit_log where occurred_at<now()-interval '90 days';
 delete from atlas_rate_limits where window_start<now()-interval '1 day';
end $$;

-- All mutation/worker helpers below are private server capabilities, never JWT RPCs.
revoke all on function public.atlas_require_editor(uuid,uuid),public.atlas_commit_state(uuid,uuid,bigint,jsonb),public.atlas_claim_job(uuid,uuid),public.atlas_finish_job(uuid,uuid,uuid,jsonb,jsonb,jsonb),public.atlas_rate_limit(text,integer,integer),public.atlas_delete_organization(uuid,uuid) from public,anon,authenticated;
grant execute on function public.atlas_require_editor(uuid,uuid),public.atlas_commit_state(uuid,uuid,bigint,jsonb),public.atlas_claim_job(uuid,uuid),public.atlas_finish_job(uuid,uuid,uuid,jsonb,jsonb,jsonb),public.atlas_rate_limit(text,integer,integer),public.atlas_delete_organization(uuid,uuid) to service_role;
revoke all on function public.atlas_set_member(uuid,uuid,uuid,text),public.atlas_purge_organization(uuid) from public,anon,authenticated;
grant execute on function public.atlas_set_member(uuid,uuid,uuid,text),public.atlas_purge_organization(uuid) to service_role;

-- Raw snapshots are private and never overwritten. Service-side writes only;
-- members can read their organization's exact prefix through storage RLS.
insert into storage.buckets(id,name,public) values('atlas-evidence','atlas-evidence',false) on conflict(id) do update set public=false;
create policy atlas_evidence_read on storage.objects for select to authenticated using(
 bucket_id='atlas-evidence' and exists(select 1 from public.atlas_organizations o where o.id::text=(storage.foldername(storage.objects.name))[1] and public.atlas_role(o.id) is not null)
);

insert into public.atlas_schema_migrations(version) values('202610140001');
commit;
