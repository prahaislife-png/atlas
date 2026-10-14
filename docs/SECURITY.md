# ATLAS operational security and release gate

The Supabase/Vercel implementation has local tests and 31 successful live Supabase Auth/tenant/private-storage checks, described in `SUPABASE.md`. This is not a completed operational launch review. The deployment build now verifies production configuration, live schema/Auth/private storage and read-only model access; missing or invalid services stop deployment. Backup settings, a managed restore drill, paid-search behavior and the actual Vercel HTTPS runtime require separate verification. Local Postgres tests and Auth fixtures alone do not prove those properties.

## Release evidence required

- Verified-user sign-in, secure cookies, refresh, logout and same-origin rejection against the actual Auth project.
- Two real organizations tested through the hosted endpoints and direct data/storage access. Forged organization IDs, observation IDs, exports, viewer writes and private worker RPC calls must be denied.
- Applied schema version, private bucket, reviewed existing RLS/storage policies and trusted server environment values. Runtime service credentials must remain server-only.
- Small explicitly authorized paid provider test with raw provenance and no fixture metrics. Confirm reservations, failure handling and application/provider budget configuration.
- Managed backup/PITR settings and an actual managed restore drill. The local automated pg_dump/restore is not proof of managed backup configuration.
- Exact HTTPS origin, Vercel plan/function duration, target API rewrites, headers and session behavior verified. No unattended scheduling or billing is offered; billing webhooks are not implemented or accepted.
- Owner/account provisioning, privacy/retention operations and incident contacts assigned by the operator. No public self-service signup/recovery is claimed.

## Credentials and access logs

Revoke any key pasted into chat and generate a replacement. Store it only in secure platform settings; do not put it in browser variables or source. The current runtime saves request payloads without authentication headers and never prints upstream exception bodies. Application audit records contain actor IDs, event names, routes with record IDs replaced, timestamps and revision/job IDs, not passwords, provider keys or raw response bodies. Supabase also supplies its own Auth/service logs; configure retention/access appropriately.

The service-role key bypasses RLS and must be treated as an administrative credential. All public mutation/worker paths require a verified user and membership; private database functions independently enforce the actor's role. Do not give service credentials to a browser or client. Restrict operator access to the project and Vercel settings.

## Backup and restore

Enable the appropriate Supabase managed backup/PITR policy before launch. Run a restore drill in a separate protected project/database and verify organizations, memberships, project versions, audit entries and the usage ledger. Restore the private Storage objects separately: a database dump contains object metadata/references, not object bytes. Compare restored references/objects and access policies before resuming workers. Never restore a backup over a running production database as a casual test.

`npm run test:db` performs an actual isolated pg_dump/restore and confirms retained audit history. It does not access the remote project or prove remote object backups.

## Deletion and retention

An owner may issue the documented organization deletion request. It is audited and immediately excludes the organization from reads/writes via membership/RLS; raw objects are no longer member-readable. After 30 days, run `node --env-file-if-exists=.env scripts/purge-deleted.js` as an authorized operator with secure configuration. It lists only expired deleted organizations, deletes their private prefix through the Storage API, then invokes the database's retention-checked purge. It refuses unexpected object hierarchies and preserves database state if storage deletion fails. Database purge is blocked while matching storage records remain. Audit rows are pseudonymous and pruned after 90 days during retention runs. Set an operator schedule; this task is not automatically scheduled by Vercel.

Backups can retain deleted records within the configured backup window. Document the provider backup policy to customers. Account deletion must also be handled through Supabase Auth after ownership transfer or organization deletion/retention; do not silently remove the last owner. There are no enquiry/booking imports in this version.

## Incident procedure

1. Disable the affected deployment/provider integration and stop starting new jobs. Preserve audit records and job reservations; do not retry potentially billed requests blindly.
2. Revoke exposed OpenAI, Supabase service or Vercel credentials in their owning platforms. Replace secure bindings, invalidate affected Auth sessions and redeploy only after checks pass. Never copy the compromised values to tickets/logs.
3. Review sanitized Auth/access/audit events, affected organizations and private object access. Restrict administrative access while investigating.
4. Restore from a verified backup into an isolated protected environment if integrity is uncertain, compare raw evidence and usage history, and document impact and recovery.
5. Notify the assigned owner and affected customers as required by the actual incident and applicable obligations. Assign real operational contacts before launch; this repository does not invent them or send notifications automatically.
