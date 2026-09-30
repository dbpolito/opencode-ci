# Credentials and captured logs

The CLI replaces known secrets with `[REDACTED]` on stdout and stderr, including assistant replies, reasoning, tool output, child transcripts, and errors. It masks:

- Environment variables named for API keys, tokens, secrets, passwords, private/access keys, or auth, such as `OPENAI_API_KEY` and `GH_TOKEN`.
- API keys, OAuth access/refresh tokens, and strings in metadata/configuration from loaded auth JSON.
- Refreshed credentials read from the run's database before output and during write-back. Old tokens stay masked too.

Raw, JSON-escaped, and URL-encoded values are covered. Local redaction protects the GitHub console and captures such as `2>&1 | tee run.log`. The CLI does not emit `::add-mask::` commands: they contain the secret itself, and `tee` saves them before GitHub processes them. GitHub's console masking does not sanitize files. Credentials already registered by the workflow still benefit from GitHub's console masking.

Credential files keep their real values for authentication and token write-back. Never commit, cache, log, or upload them.

## Limits

This masks known values. It does not detect every secret in repository files, cover arbitrary encodings or secrets split across separate writes, or sanitize content an agent publishes through tools such as `gh`. Plugins and dependencies writing directly to process streams bypass local redaction.

Refreshed tokens must be in the auth database before output is emitted. Previously written files cannot be retroactively redacted. The runner creates no encrypted transcript or share link.

## Previously captured logs

Earlier versions emitted secret-bearing `::add-mask::` lines on GitHub Actions. Uploaded logs captured with `tee` or redirection may contain credentials even when the console looks masked.

1. Remove affected artifacts, including retained or downloaded copies where possible. Do not paste their contents into issues or diagnostic output.
2. Revoke/rotate exposed long-lived credentials, especially OAuth refresh tokens, API keys, and PATs. Reauthorize the dedicated CI login and update repository secrets. Revoke exposed short-lived installation/access tokens where possible; deletion alone is not enough.
3. Upgrade to a release containing the fix. Until then, stop uploading captured logs or sanitize them before upload: remove entire `::add-mask::` command lines and redact known credentials in raw, JSON-escaped, and URL-encoded forms, including refreshed tokens. Stripping command lines alone does not sanitize other output. Do not print secrets while sanitizing.
4. Upload explicitly selected, sanitized files instead of the entire review directory. Exclude auth JSON, databases, and unsanitized logs. Skip the upload if sanitization fails.
