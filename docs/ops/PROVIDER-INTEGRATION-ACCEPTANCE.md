# Provider and Integration Acceptance Runbook

## 1. Purpose and acceptance boundary

This runbook defines a repeatable operator acceptance pass for the provider and integration surfaces present in this repository snapshot. It covers the Gemini, OpenAI, Anthropic, xAI/Grok and Ollama API providers, Composio, and the consent-gated CLI auto-detection path.

This is an operator procedure, not evidence that every provider, account, model, integration or operating system has already passed. Record PASS, FAIL, BLOCKED or NOT RUN for each applicable check. Do not convert an unconfigured provider, missing credential, unavailable local service or skipped live test into PASS.

The acceptance boundary is the exact application build and commit under test. Record the app version, commit SHA, OS/build, architecture, Node.js/npm versions where relevant, provider/model identifiers, test timestamp and operator. Never include API keys, OAuth tokens, session URLs, prompt contents containing secrets, or raw credential/config files in the evidence.

## 2. Repository implementation references

Use the checked-in implementation and existing operational notes as the source of truth:

- Provider registry and dispatch: `packages/core/src/providers/index.ts`.
- Provider transports: `packages/core/src/providers/gemini.ts`, `packages/core/src/providers/openai.ts`, `packages/core/src/providers/anthropic.ts`, `packages/core/src/providers/xai.ts`, `packages/core/src/providers/ollama.ts`, and shared `packages/core/src/providers/openaiCompatible.ts`.
- Provider and model background: `docs/providers-v097.md`.
- Gemini live-test boundary and historical evidence: `docs/live-test-gemini.md`.
- Composio architecture, current integration boundary and recorded live-read evidence: `docs/composio-integration.md`; implementation overview: `packages/core/src/composio/README.md`.
- CLI detection implementation: `packages/core/src/routerV30/cliAgentDetectV30.ts`; earlier CLI probe adapters: `packages/core/src/routerV2/cliProbeV2.ts`.
- Build and test commands / evidence rules: `docs/TESTING.md` and root `package.json`.

These references describe implementation and historical test evidence. They do not substitute for testing the exact candidate build.

## 3. Preflight and evidence hygiene

1. Start from a clean, identified candidate build. Record the exact commit SHA and application version; do not mix results from another SHA.
2. Confirm the machine, OS account and network environment are the intended test environment. For Ollama, record whether the local service is available and which local model is already installed.
3. Use dedicated, least-privilege test credentials and test accounts. Keep credentials in the application's supported secret storage/configuration path; do not paste them into terminal commands, issue comments, screenshots or evidence files.
4. Use a disposable test conversation/workspace for provider and tool-call checks. Avoid production data and destructive actions.
5. Record each check's exact provider ID, selected model, outcome, timestamp and sanitized error category. Redact keys, bearer headers, OAuth tokens, Composio presigned MCP URLs, personal data and prompt content.
6. If a prerequisite is unavailable, mark the check BLOCKED or NOT RUN with the reason. Do not silently substitute a mock result for a live-provider acceptance result.

## 4. API provider acceptance

Run the following matrix independently. A successful request through one provider does not validate another provider, even when they share transport code.

| Provider | Registry identity | Acceptance focus |
| --- | --- | --- |
| Gemini | `gemini` | Gemini generateContent request/response, text response, tool-call round trip and usage metadata where available |
| OpenAI | `openai` | Chat Completions request/response, text response and tool-call round trip |
| Anthropic | `anthropic` | Messages request/response, text response and tool_use/tool_result round trip |
| Grok / xAI | `xai` | xAI Chat Completions request/response, text response and tool-call round trip |
| Ollama | `ollama` | Local OpenAI-compatible endpoint, installed model discovery and local chat/tool-call behavior |

For each configured provider:

1. In the application provider/settings flow, select the intended provider and explicitly chosen model. Verify the displayed provider identity and model are the ones being exercised.
2. Configure the provider's own credential using the application's supported settings/Vault flow. Do not reuse one vendor's key for another provider. Ollama is local and its registry metadata says it does not require an API key.
3. Perform a minimal harmless text request. Confirm a non-empty response and that the UI/run completes without an unresolved provider error.
4. Where tool calling is part of the candidate workflow, use a harmless read-only test tool. Confirm the provider's tool call is surfaced, the tool result is returned to the model, and the final response completes. Do not use a write-capable external tool for this test.
5. Exercise model listing/selection if available. Record whether the list came from the live endpoint or a documented fallback; a fallback catalogue is not proof that a model is currently available at the vendor.
6. Exercise a negative case using an intentionally unconfigured provider or a safely invalid test credential only when this can be done without exposing or overwriting a real credential. Confirm the failure is bounded and actionable; restore the valid configuration afterwards.
7. Record latency and sanitized error details, but do not impose a universal latency threshold unless the release owner has specified one.

### Provider-specific notes

- Gemini uses the Google Generative Language API `generateContent` transport. Its historical live test is gated by `OPENBOT_LIVE_GEMINI=1` and the proxy described in `docs/live-test-gemini.md`. The documented live evidence is for the historical `gemini-2.5-flash` test path; do not generalize it to every model.
- OpenAI and xAI use the shared OpenAI-compatible transport, but require separate provider configuration and separate live acceptance. Shared transport tests do not prove either vendor account or endpoint is currently usable.
- Anthropic uses the Messages API and its own tool_use/tool_result message mapping. Do not infer Anthropic acceptance from OpenAI-compatible provider results.
- Ollama uses the local endpoint `http://localhost:11434/v1`, default model `llama3.1`, and no API key according to the provider registry. Verify the local server and exact installed model on the test machine; a fallback model list while Ollama is unavailable is not a successful local inference test.

## 5. Composio acceptance

Composio is an optional connected-app integration, not a required dependency for local providers. Its source is documented as disabled by default and its tools enter the existing AppRegistry/tool-filter path.

### Safe configuration and read-only checks

1. Confirm Composio is disabled by default on a fresh or reset test profile. Confirm the local provider path remains usable with Composio disabled.
2. If the owner has authorized a test, enable Composio explicitly in Settings and configure the user's project API key through the supported Vault path. The key belongs in Vault namespace `provider`, key `composio`; never put it in source, `.env`, logs or evidence.
3. Confirm the UI exposes only configured/not-configured status, not the key value.
4. Create or refresh a Tool Router session using the server-returned MCP URL and headers. Do not construct the presigned URL manually or log/store it in evidence.
5. Verify the read-only discovery path: list session meta-tools, search for a harmless read-only toolkit action, retrieve its schema, and inspect the returned tool metadata. The documented wire shapes include the `toolkits` policy object, `tool_slugs` for schema lookup and `tool_slug` in execute items; do not replace these with guessed field names.
6. Confirm missing-key and invalid-session failures are fail-closed and do not expose the API key or presigned session URL.
7. Disable Composio and verify its apps/tools disappear from the registry while local providers continue to work.

### Write operations are a separate approval gate

The repository's Composio integration record states that live read/discovery was exercised, while real write actions (for example creating an issue, sending mail or posting to Slack) had not been performed and require explicit approval of the test repository, mailbox or channel.

Therefore this runbook does not authorize write testing. Do not call write-capable toolkit actions, send messages, create/update/delete remote records, or run a broad multi-execute request without explicit owner approval naming the disposable target and permitted action. Until that approval and a successful controlled rehearsal exist, mark write acceptance BLOCKED / NOT RUN. Historical mock tests or live discovery do not count as live write acceptance.

## 6. CLI auto-detection acceptance

The consent-gated detector in `packages/core/src/routerV30/cliAgentDetectV30.ts` declares Codex CLI, Claude Code, OpenCode, Gemini CLI, Aider and Cursor CLI. It detects binaries by invoking the CLI's version command; detection alone does not prove authentication or successful model execution.

1. On a test machine, record which supported binaries are intentionally installed and available on PATH. Do not install or authenticate a CLI merely to make the detection matrix green.
2. Confirm the user-consent state is initially false for a fresh profile. Without consent, detection must not invoke model execution through the CLI.
3. Grant consent explicitly in the UI, enable only the CLI sources selected for this test, and run detection. Compare detected/not-detected status and version output with the binaries intentionally present on PATH.
4. For a missing binary, confirm the result is a normal not-detected state rather than an application crash or an invented version.
5. Confirm account labels are user-entered labels or the generic CLI-login label; do not infer identity from local auth files.
6. Confirm detection does not read, copy or transmit CLI auth/config/session files. In particular, do not inspect the paths listed in `FORBIDDEN_CLI_PATHS_V30` as part of acceptance.
7. Only after detection and consent, exercise a harmless CLI-backed prompt for each selected source. Record detection and invocation as separate outcomes.
8. Revoke consent and verify CLI model execution is no longer available. Record per-source enablement and consent state without recording account secrets.

The older probe adapter in `packages/core/src/routerV2/cliProbeV2.ts` has a distinct adapter set and auth-status probing behavior. Do not conflate its results with the consent-gated V30 detector; record which UI/runtime path was actually exercised.

## 7. Regression and release gates

At repository root, the documented scripts include:

```bash
npm ci
npm run version:sync
npm run version:check
npm run build
npm run typecheck
npm test
```

On Linux, the repository testing guide specifies `xvfb-run -a npm test` for the full suite; Windows and macOS use `npm test`. Run focused tests for the touched provider/integration area before the full suite, then run the complete build, typecheck and full-suite gates on the exact candidate SHA. The commands above are real root scripts from `package.json`; use the operating-system-specific instructions in `docs/TESTING.md`.

A green focused test is not a substitute for build, typecheck, cross-platform CI or the full suite. Verify CI checks on the exact PR head SHA. Record raw pass/fail/skipped counts and explain every skip. Do not land with any unexplained failure or newly introduced skip.

## 8. Acceptance record

For each provider, Composio read-only path, Composio write gate and CLI source, record:

- Candidate commit SHA, app version, OS/build, architecture and operator.
- Provider/integration identity, selected model or toolkit/action class, and whether the check was mock, local or live.
- Prerequisites and consent state; never include secret values.
- Exact check performed, outcome (PASS / FAIL / BLOCKED / NOT RUN), UTC timestamp and sanitized error category.
- Focused test command/result, build/typecheck result, full-suite result and exact CI run/check links.
- Deviations, unresolved issues, owner and next action.

Overall Provider & Integration Acceptance is PASS only when every in-scope provider has an explicit outcome, required live paths have been exercised with dedicated credentials or clearly approved local fixtures, Composio read-only and consent/disable behavior pass, CLI consent and secret-boundary checks pass, and all required release gates are green on the exact candidate SHA.

If any provider is unconfigured, Composio write testing lacks explicit approval, CLI consent/security behavior is unverified, a required platform is untested, or a release gate is failing/unknown, overall status is HOLD. Do not represent BLOCKED or NOT RUN checks as passed.

This runbook is an acceptance procedure only. It does not add provider, Composio, CLI, backup, automatic failover or remote-write functionality, and it does not claim that any new live acceptance exercise has been performed.
