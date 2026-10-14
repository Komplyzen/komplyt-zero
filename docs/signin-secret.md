# Server signin secret (`KG_JWT_SECRET`)

The server signs in to SurrealDB through the `kg_server` record access with a
shared secret, `KG_JWT_SECRET`. Despite its name it signs no JWT, and clients
never see it: they authenticate with tokens verified against
`KOMPLYT_JWKS_URL` / `KOMPLYT_ISSUER`.

## How the check works

`kg_server`'s SIGNIN only succeeds when `sha256(secret)` is in
`kg_config:signin.signin_sha256s`. That table is `PERMISSIONS NONE`, so
tenant sessions can never read or change it; only the signin query, which
runs with system rights, reads it. A missing or empty row fails closed: no
signin succeeds.

It is an **allowlist**, not a single stored value, so two server revisions
with different secrets can both be valid during a rolling deploy, and a
process with database credentials but a different secret cannot replace the
running server's entry.

Hashes must be lowercase hex (64 characters); the schema rejects anything
else, and it rejects the hash of the empty string, which would admit a
signin that omits the secret.

## First boot

You do not seed the row. At boot the server publishes its own hash
(`src/signin-secret.ts`):

- no row yet: it creates the row with its own hash;
- its hash already listed: nothing to do;
- the row lists other hashes but not its own: it refuses to start
  (`SigninSecretNotAcceptedError`). A server with database credentials and a
  stale or wrong secret must not add itself; follow the rotation steps below.

## Rotating the secret

As a root database user:

1. Compute the new hash. A trailing newline changes it:

   ```bash
   printf %s "$NEW_KG_JWT_SECRET" | sha256sum
   ```

2. Add it, keeping the old one:

   ```sql
   UPDATE kg_config:signin SET signin_sha256s += '<new-hash>';
   ```

3. Deploy the server with the new `KG_JWT_SECRET` and confirm `/ready`.
4. Once no instance with the old secret serves traffic, remove the old hash:

   ```sql
   UPDATE kg_config:signin SET signin_sha256s -= '<old-hash>';
   ```

Never put the raw secret into a `DEFINE ACCESS` clause: `INFO FOR DB` prints
access-definition literals in plaintext.
