# Incident Diagnostics and Log Privacy Runbook

This runbook defines how to diagnose an open-bot incident without turning local diagnostic data into a second exposure of credentials, personal data, prompts, files or workspace metadata. It documents the diagnostic surfaces present in the reviewed source snapshot and sets operator handling rules. It does not add a central logging service or change application behaviour.

## 1. Non-negotiable handling rules

- Treat every raw log, trace, journal, crash report, audit record, screenshot and exported bundle as **sensitive local data** until reviewed. “Redacted” means selected patterns were removed; it does not prove that arbitrary secrets or PII are absent.
- Never log or export API keys, OAuth access/refresh tokens, bearer headers, cookies, session IDs, passwords, private keys, webhook signing secrets, full environment dumps, provider request/response bodies, attachment bytes or raw tool arguments.
- Do not add chat prompts, model responses, file contents, customer/user names, email addresses, phone numbers or workspace paths to a new diagnostic field. Prefer stable event codes, component names, timestamps, durations, counters and opaque run/trace IDs.
- Capture the smallest time window and the smallest set of records needed. Keep raw originals local and access-restricted; share only an independently inspected sanitized copy.
- Do not use a UI “redact” marker as proof that data has been erased from disk. Do not edit or rewrite original audit evidence in place.

## 2. Confirmed diagnostic-surface inventory

The following inventory is grounded in the source at snapshot `2d14cc1b73c3f9fecb4b92614c180fb15a404aec`. Configured paths may differ by profile or host. It is a minimum confirmed inventory, not a claim that every OS, plugin or child-process log has been exhaustively enumerated.

| Surface | Current contents and location | Current bounds / protection | Incident handling |
|---|---|---|---|
| Crash reports | Opt-in only (default OFF); `<userData>/crash-reports/<id>.json`. Main and renderer error message + stack, source/kind, platform, app/Node version and timestamp. No send endpoint in this implementation. | Message/stack pass through `redactCrashText`; message max 2,000 chars, stack max 8,000. Files are written mode `0600`; oldest removed above 50 reports or 5 MiB total. | Check the setting first. Turning it OFF stops new collection but does not delete existing reports. Inspect every report before export. |
| Thread / harness NDJSON | Per-thread event files under the configured `logDir`; assistant text and result text may be retained (truncated), alongside event metadata. Tool-call records keep argument-key names, not argument values. | Secret-looking object keys, Bearer and known provider-key patterns are sanitized; strings are capped at 2,000 chars. Defaults: 5 MiB per file and 50 MiB per thread before rotation/pruning. | Treat as conversation-bearing data, not a secret-free operational log. Do not share raw thread files. |
| Run event log | `<userData>/run-logs/<runId>.jsonl` plus rotated JSONL files. Includes prompts, model response text, tool output previews, event metadata and file-change paths; tool-call arguments are represented by key names. | Payload sanitizer redacts selected credential keys/patterns and truncates strings. Defaults: 8 MiB per file and 64 MiB per run. Appends are fsynced; events have a SHA-256 hash chain. | Export only selected events after review. `exportJsonl` returns event data; do not treat it as a sanitized evidence bundle. |
| Run event-log redaction | `event.redacted` markers can hide selected text events in folded/replayed UI state. | The original JSONL event remains on disk and in raw reads/exports. A marker is not secure deletion and does not break the append-only audit chain. | Never claim disk erasure from a marker. For a real disclosure, preserve evidence first and follow approved data-removal/retention handling separately. |
| Durable run journal | `<journalDir>/<runId>.journal.jsonl`; entries include tool/model activity, errors, checkpoints and potentially message snapshots. | Writes use the tracing `sanitizeValue` helper, but the journal append path does not set a file mode or show an fsync call. Pruning keeps the 20 newest finished journals by default and never prunes unfinished runs. | A checkpoint can contain conversation messages and completed tool calls. Treat the entire journal and `exportBundle` as sensitive. Verify before interpreting; do not assume crash-proof persistence or complete redaction. |
| Traces | `<userData>/traces.jsonl`; span summaries, labels, errors, attributes and timing. | Tracer sanitizes and caps summary text at 500 chars. Store keeps 100 finished traces by default; appends and rewrite files use mode `0600`. | Review input/output summaries and attributes; short excerpts can still contain PII or proprietary text. |
| Hook execution log | `<userData>/hook-executions.jsonl` plus an in-memory ring. Records hook name/event/action, duration, reason and error. Hook stdout/stderr are deliberately not stored by this record. | Ring defaults to 500 records (hard max 10,000); file pruning triggers above 1,000,000 bytes and keeps the newest 1,000 lines. | Inspect reason/error strings and the separate logger/host output; do not infer that stdout/stderr are absent from every other sink. |
| Sandbox execution audit | Per-bot `<botDir>/audit/audit.jsonl` plus rotated `audit-*.jsonl`. May contain commands, arguments, exit data and detail/output excerpts. | Registered known secret values are scrubbed at write time; export can scrub again with supplied current secrets. Rotation defaults to 10 MiB or 100,000 entries; hash-chain verification is available. | Command lines, paths and details remain sensitive. Unknown/unregistered secrets and PII are not guaranteed to be removed. Preserve originals and sanitize a copy. |
| Egress telemetry | In-memory aggregate counts by outcome and fixed context label. | The telemetry API accepts kind/context counters, not URL, host, path, query or request/response content. | Prefer aggregate counters for network-policy evidence; do not attach raw URLs or request data to a replacement diagnostic record. |

### Storage-permission caveat

The crash-report writer explicitly applies mode `0600` to report files; the trace store opens/appends and rewrites its file with mode `0600`. Several other stores create directories recursively or append files without an explicit per-file mode in the reviewed call sites. Their effective access therefore depends on the parent directory, process umask and platform ACLs. Do not infer owner-only permissions for all logs from the crash-report implementation. Verify actual permissions on the host and keep diagnostic directories inside the user's protected profile.

No single severity-level, retention or export policy is established across all these independent stores. Apply the operational policy below consistently when collecting evidence.

## 3. Severity and data-minimisation policy

Use the following fields and levels when writing incident notes or adding future diagnostic records:

| Level | Appropriate content | Do not include |
|---|---|---|
| FATAL / ERROR | Stable error code, component, operation, outcome, timestamp, sanitized stack reference and opaque run/trace ID. | Raw exception objects, prompts, request bodies, headers, environment values, file contents or secrets. |
| WARN | Retry, fallback, timeout, policy denial or recovery transition with a bounded reason code. | Unbounded command output, full paths or user-supplied text. |
| INFO | Lifecycle transitions, version/platform, durations, counts and state changes. | Conversation text, tool argument values, credentials or customer identifiers. |
| DEBUG | Temporary, explicitly enabled, local-only diagnostics using synthetic data and a bounded time window. | Raw prompts/responses, tokens, cookies, auth headers, attachments, environment dumps or unrestricted payload dumps. |

DEBUG must be OFF by default and disabled again when the investigation ends. Do not turn a diagnostic need into permanent payload logging. A stack trace or exception message can itself embed a URL, user input, path or credential; sanitize it before recording and still inspect the result.

## 4. Incident triage and evidence preservation

1. Open an incident record with an opaque incident ID, UTC start time, affected app version/source SHA, OS/platform, impact, first observed symptom and the responsible operator. Avoid names, account identifiers and workspace paths in the incident title.
2. Contain ongoing exposure. Stop repeated actions that generate sensitive logs; disable opt-in crash reporting if it is not needed for the investigation. Remember that disabling it only stops new crash reports; it does not delete existing files.
3. Identify the relevant bot, run, trace, thread and time window. Record opaque IDs and the exact source paths in the restricted incident record, not in a public ticket.
4. Before analysis or deletion, copy the relevant original files into a restricted incident directory. Make the source copy read-only where the OS supports it. Record each original's source, capture time, byte size and SHA-256. Do not redact, truncate, rotate or reformat the only original.
5. Keep original evidence separate from working copies. Analyse copies locally. Preserve hash-chain verification results, corrupt-line counts and time ranges alongside the evidence; a valid hash chain proves integrity of the recorded sequence, not absence of sensitive content.
6. Collect only relevant OS/service-manager stdout/stderr or child-process output. These streams are not covered by the local store guarantees above; review them as raw data and do not upload a full environment or process dump.

## 5. Sanitized evidence export

1. Create a new working copy; never sanitize the preserved original in place.
2. Apply the relevant repository redactor and any exact known-secret list available to the operator. Include current and recently rotated credentials, OAuth tokens, webhook secrets and test sentinels. A redactor only catches its implemented patterns and supplied values.
3. Remove unrelated prompts, model text, tool output, file contents, command arguments, usernames, emails, customer data, hostnames, absolute paths and identifiers. Replace paths with neutral placeholders such as `<workspace>` and `<userData>`; replace user/account identifiers with stable per-incident pseudonyms only when correlation is essential.
4. Inspect every line and every attachment manually. Search for sentinel values and known secret fragments, then search for PII patterns and path prefixes. A zero-match scan is necessary but not sufficient: encoding, truncation, escaping and unknown secret formats can evade pattern checks.
5. Re-run hash/sequence verification on the sanitized derivative only if the transformation preserves its format. Redaction may legitimately invalidate a hash chain; do not represent a changed derivative as the original integrity-verified evidence.
6. Create a manifest containing the sanitized file names, SHA-256 hashes, byte sizes, time range, source SHA, redaction method, operator and review outcome. Do not include original secret values in the manifest.
7. Share only the minimum approved sanitized bundle over an approved private channel. Never attach raw `*.jsonl`, journal, trace, crash report, environment file or workspace archive to a public issue or PR.

## 6. Credential exposure and retention

- If a real credential may have entered a log, revoke or rotate it at its issuing provider/control plane immediately. Deleting or redacting a local file does not revoke a credential. Verify the replacement works, then remove the old value from active configuration and approved secret stores.
- For sinks that scrub registered secret values, register newly issued secrets before the next operation that could log them. Historical records may still contain values that were not known at write time.
- Keep raw originals access-restricted only for the active investigation and any approved security/legal hold. Without a hold, remove temporary raw incident copies within 30 calendar days after incident closure. Retain the sanitized evidence manifest/bundle for 90 days or the shorter applicable project policy; record any approved exception and expiry. Do not alter product-managed audit history to satisfy this temporary-copy schedule.
- Record who accessed, copied, sanitized, shared or deleted an evidence artifact. Verify deletion from the incident working area and its managed copies; do not promise forensic erasure from SSDs, backups or OS snapshots.

## 7. PASS / HOLD criteria

**PASS** only when the diagnostic scope is bounded, original evidence is preserved and hashed, the shared copy has been manually reviewed, sentinel/secret checks are clean, access and retention are recorded, and any exposed credential has been revoked or rotated.

**HOLD** on any raw credential, bearer token, private key, user/customer content or identifying path in a proposed export; unknown provenance; unverified permission exposure; missing original needed for investigation; unexplained hash/sequence failure; or a claim that UI redaction deleted on-disk data.

This runbook is an operator procedure for the reviewed snapshot. It does not prove that every logger, plugin, worker, OS log or future code path has been audited, and it does not make raw diagnostic exports safe by default.
