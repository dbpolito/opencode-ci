# OpenCode's native auth import/export

The CLI import/export behavior below was checked against OpenCode commit `4c33a253aa` (September 29, 2026, [PR #52139](https://github.com/anomalyco/opencode/pull/52139)). The SDK review was updated for `@opencode/sdk@2.2.6`; the published [API reference](https://opencode.ai/docs/api) now includes credential list/create/update endpoints.

## Commands

Export one integration to a private file:

```sh
(umask 077; opencode auth export openai > openai-credentials.json)
```

Import that file, or read it from stdin:

```sh
opencode auth import openai-credentials.json
opencode auth import < openai-credentials.json
```

These commands use the OpenCode service/client, not direct SQLite access. They also accept the shared server options. Export without a target includes every integration; targeting `openai` includes all its saved accounts, not just the selected one. Environment-only connections are not exported.

Export writes real secrets to stdout. Its warning appears only when stdout is a TTY, and the CLI does not set file permissions on shell redirection. Use `umask 077`, never `tee`, and never include the result in logs or artifacts.

## Format and import behavior

The export is an array of entries with `id`, `integrationID`, `label`, `active`, and `value`. The value contains the API key or OAuth access/refresh tokens, expiry, method ID, and optional metadata/configuration.

Import validates the array and creates missing entries. Existing IDs are skipped, not overwritten. Existing destination account selections are preserved; integrations new to the destination adopt the exported selection. Import reports counts on stderr.

Repeated import does **not** update rotated tokens. It is a transfer tool, not credential synchronization.

## Fit for opencode-ci

Our current auth file is an object keyed by integration ID with one credential value per integration. Native exports are not accepted by `parseAuth` as-is. Do not substitute a native export in the current workflow.

The current SDK exposes `credential.list()` and `credential.create()`. They are candidates for replacing database access, but not a drop-in replacement for all of it:

- Before every output write, masking synchronously reads committed credentials so rotated tokens cannot be printed while an asynchronous credential refresh is pending. The runner reuses one read-only connection and prepared query for those reads, including shutdown and write-back.
- The runner's key credential format accepts `configuration`; the SDK's current credential schema does not. Moving writes to the API must not silently drop existing fields.
- Local `auth export --db` deliberately reads the source database read-only, without starting a service or applying migrations.

A follow-up could:

- Accept native exports alongside existing auth JSON, choosing the selected account for each integration.
- Seed the private run host with `credential.create()` once credential formats are reconciled. Use `credential.list()` only where asynchronous reads do not weaken pre-output masking or shutdown write-back.
- Keep local masking up to date before output, retain old masks, and save write-back files atomically with mode `0600`.

Moving seeding to the API would reduce our dependency on OpenCode's SQLite layout. Removing synchronous reads needs a masking design that also covers newly rotated tokens before any diagnostic output. Calling the OpenCode CLI during a run would add an installation/service dependency without solving token write-back.
