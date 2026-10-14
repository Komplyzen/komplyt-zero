-- Migration 037: meta_model, the stored result of the meta-model lenses, and tenant_tier (LYT-310)
--
-- The methodology, resiliency and process lenses of kg_meta_model are computed by a private batch
-- job (komplyzen-platform), not per request. The job writes one row per container, scope, scope id
-- and lens; the public kg_meta_model tool only reads them. The schema is public, so the table
-- carries its own isolation:
--   * a row is visible exactly to the users who may see its container (the same grant rule as
--     `node`: the user's principals must be in the container's granted_principals),
--   * a scoped (tenant) connection can never create, update or delete a row; only the job, which
--     signs in as root, writes,
--   * a row's tenant must be the tenant of its container (asserted on write, and checked again on
--     read), so a buggy writer cannot put one tenant's model under another tenant's name.
--
-- It also adds `tenant_tier`, one row per tenant (record id = the tenant id) with the subscription tier
-- the server last saw in that tenant's verified tokens. The server notes it (see src/tenant-tier.ts) so
-- the batch job can limit itself to licensed, recently active workspaces without asking Komplyt. It is a
-- table of its own, not fields on `tenant`, so that nothing tools return (tenant.name is surfaced in
-- several responses) and no unique index (tenant.name) is touched. PERMISSIONS NONE: scoped connections
-- can neither read nor write it, so a tenant cannot set or see a tier; only the server's root connection
-- writes and only the job reads.
--   tier        free | team | pro | enterprise
--   updated_at  last time the server wrote the row (about hourly while the tenant is active)
--   changed_at  last time `tier` changed (the job waits a grace period after a downgrade)
--
-- Additive: creates two new tables, touches no existing table or record, safe on a database that already
-- has data. Nothing reads it until the reader ships, so applying it ahead of the job is harmless.
--
-- scope_id is '' for scope = 'container' (a UNIQUE index cannot treat NONE as a value).
-- `model` holds the lens output as given; it is NONE when status = 'insufficient'.

DEFINE TABLE OVERWRITE meta_model TYPE NORMAL SCHEMAFULL
  PERMISSIONS
    FOR select WHERE tenant = type::record('tenant', $auth.tenantId)
      AND container.tenant = tenant
      AND array::any($auth.principals, |$p: any| {
        LET $parts = string::split($p, ':');
        RETURN container.granted_principals CONTAINS type::record($parts[0], $parts[1]);
      }),
    FOR create, update, delete NONE;

DEFINE FIELD OVERWRITE tenant ON meta_model TYPE record<tenant>
  ASSERT $value = container.tenant PERMISSIONS FULL;
DEFINE FIELD OVERWRITE container ON meta_model TYPE record<container> PERMISSIONS FULL;
DEFINE FIELD OVERWRITE scope ON meta_model TYPE string
  ASSERT $value INSIDE ['container', 'project', 'person'] PERMISSIONS FULL;
DEFINE FIELD OVERWRITE scope_id ON meta_model TYPE string DEFAULT '' PERMISSIONS FULL;
DEFINE FIELD OVERWRITE lens ON meta_model TYPE string
  ASSERT $value INSIDE ['methodology', 'resiliency', 'process'] PERMISSIONS FULL;
DEFINE FIELD OVERWRITE status ON meta_model TYPE string
  ASSERT $value INSIDE ['confident', 'provisional', 'insufficient'] PERMISSIONS FULL;
DEFINE FIELD OVERWRITE explanation ON meta_model TYPE string PERMISSIONS FULL;
DEFINE FIELD OVERWRITE model ON meta_model TYPE none | object FLEXIBLE PERMISSIONS FULL;
DEFINE FIELD OVERWRITE computed_at ON meta_model TYPE datetime PERMISSIONS FULL;
DEFINE FIELD OVERWRITE job_version ON meta_model TYPE string PERMISSIONS FULL;

DEFINE INDEX OVERWRITE meta_model_key ON meta_model FIELDS container, scope, scope_id, lens UNIQUE;
DEFINE INDEX OVERWRITE meta_model_tenant ON meta_model FIELDS tenant;

DEFINE TABLE OVERWRITE tenant_tier TYPE NORMAL SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD OVERWRITE tier ON tenant_tier TYPE string
  ASSERT $value INSIDE ['free', 'team', 'pro', 'enterprise'] PERMISSIONS FULL;
DEFINE FIELD OVERWRITE updated_at ON tenant_tier TYPE datetime PERMISSIONS FULL;
DEFINE FIELD OVERWRITE changed_at ON tenant_tier TYPE datetime PERMISSIONS FULL;
