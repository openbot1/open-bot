# Runtime Stability & Shutdown Verification Runbook

Reviewed repository base snapshot: 2d14cc1b73c3f9fecb4b92614c180fb15a404aec.

This runbook defines an operator acceptance procedure for runtime stability and orderly shutdown of the existing Electron desktop application. It is a verification plan, not evidence that a soak, shutdown rehearsal, or platform test has already passed. It does not change application behavior.

## 1. Scope and acceptance vocabulary

Verify the exact candidate build on each target operating system. Keep these outcomes distinct:

- **PASS** — the check was performed on the recorded candidate and met its observable criterion.
- **FAIL** — the check was performed and did not meet its criterion.
- **BLOCKED** — a required prerequisite or safe test environment was unavailable.
- **NOT RUN** — no execution evidence was collected.

A clean window close is not necessarily an application shutdown. On macOS, closing the last window leaves the app available for reactivation; explicitly choose Quit (or Cmd+Q) to test process shutdown. On Windows and Linux, the current main-process handler calls app.quit() after all windows close.

This runbook covers startup, idle and active runtime, optional background services, repeated window lifecycle, graceful quit, process exit, child-process cleanup and evidence collection. It does not authorize destructive external actions or production workload testing.

## 2. Candidate identity and safe test environment

1. Record the full source commit SHA, root product version, build/package identifier, artifact filename and SHA-256, OS version/build, architecture, Node.js/npm versions where relevant, and operator.
2. Use a disposable OS account or test profile with non-production data. Keep the candidate build and userData directory fixed for the entire test cycle.
3. Record whether the build is a packaged release artifact or a source/dev launch. Do not combine results from different build types or SHAs.
4. Use only dedicated test credentials and harmless workloads. Do not include API keys, OAuth tokens, session URLs, raw Vault contents, personal data or prompt secrets in logs or screenshots.
5. Before testing, record baseline CPU, memory, process count, open file/handle count where available, and listening ports attributable to the app. Capture the measurement method and timestamp.
6. Ensure no other open-bot instance is running. The application uses a single-instance lock; a second launch may hand off to the existing instance instead of creating an independent runtime.

## 3. Repository lifecycle references

Use the candidate's checked-in source as the implementation reference:

- Electron main-process bootstrap and application lifecycle: \`apps/desktop/src/main/main.ts\`.
- Main-process settings, startup phases, window lifecycle and \`before-quit\` cleanup are in that file.
- Root build, typecheck and test scripts: \`package.json\`.
- Test environment, Linux virtual-display requirement and CI matrix: \`docs/TESTING.md\`.

The current main-process lifecycle has two bootstrap phases. It initializes the Vault/settings/profile first, then initializes the model registry, automations, harness, Composio state, optional Local API, file watcher, IPC and the main window. Startup logs report phase durations; do not infer successful readiness from process existence alone.

The current \`before-quit\` handler saves settings, closes the splash window, stops the update service and automation scheduler, requests Local API shutdown, clears dream/project-update timers, closes registered file watchers, and requests coordinator/fleet disposal. Some asynchronous cleanup is explicitly fire-and-forget: Local API stop and coordinator/fleet disposal are not awaited by the event handler. Therefore, source inspection alone does not prove that shutdown completed cleanly; verify actual process exit, child processes and released resources on the candidate.

## 4. Startup and readiness checks

For each OS/build combination:

1. Start the app from a fully stopped state. Record launch command or UI action, timestamp, process ID and candidate identity.
2. Observe both startup phases. Confirm the main window appears and the renderer finishes loading without a persistent blank window, crash dialog, uncaught exception or repeated restart.
3. Record the startup phase duration messages when present. Treat missing timing output as NOT RUN for timing, not proof of failure.
4. Confirm the app remains responsive: open Settings, navigate between primary views, and return to the main view. Use a harmless local interaction; do not require a cloud provider.
5. Close and relaunch the app at least three times from a fully stopped state. Record each launch result and any accumulating delay, stale lock, orphan process, port conflict or unexpected state.
6. Verify a second launch while the first instance is running follows the single-instance behavior and does not create an unintended second main runtime.

A launch is not accepted merely because an Electron process appears. The UI must become usable and remain responsive for the observation interval.

## 5. Runtime stability and soak procedure

Run a minimum 30-minute idle soak, followed by a minimum 30-minute controlled-activity soak, on each required OS. If release policy requires a longer soak, use that longer duration and record it.

### Idle soak

- Leave the app open with the main window visible and no active chat.
- Record CPU, memory, process count, open handles/files and app-owned listening ports at start, 5-minute intervals and end.
- Confirm no repeated error loop, crash, unbounded resource growth, unexpected network listener or unexplained child-process churn.
- Record scheduled/background activity that is expected for the configured profile. Do not interpret a single transient spike as a leak without repeated measurements.

### Controlled-activity soak

- Use a disposable bot/workspace and harmless local or explicitly authorized test input.
- Exercise ordinary navigation, a short chat turn, cancellation where available, and return to idle. Record whether the UI remains responsive and whether active work settles.
- If Local API is enabled for the test, use only loopback and a dedicated test token; verify a harmless request and record the bound port. Repeat the scenario with Local API disabled when that configuration is in scope.
- If Composio, automations, webhooks, voice, fleet or other optional background services are enabled, test only the configured, authorized, non-destructive path. Record each service as enabled, disabled, blocked or not run.
- Do not enable optional integrations merely to increase test coverage. Do not send email, post messages, modify remote records or trigger other external writes without explicit owner approval for the disposable target.

At the end of each soak, compare measurements with the baseline and explain sustained growth, persistent listeners, stuck work or unexpected child processes. Do not invent a universal CPU or memory threshold; use release-owner thresholds if defined and record them.

## 6. Window lifecycle versus application quit

Perform these checks separately:

1. Close the main window using the window close control. Record whether the process remains alive and whether the platform behavior matches the expected OS lifecycle.
2. On macOS, confirm the app remains available after the last window closes, then use the application menu's Quit command or Cmd+Q. Reopen it through the Dock and verify a fresh window can be created.
3. On Windows and Linux, verify closing the last window initiates app.quit() as implemented by the current main-process handler.
4. Test an explicit application Quit command on each platform. Record the UI action and whether the app exits without force-kill.
5. Distinguish window closure, app quit request, main-process exit and operating-system process disappearance. They are separate observations.

Do not mark shutdown PASS based only on a window disappearing.

## 7. Graceful shutdown verification

Before each graceful-quit rehearsal, record active workload and enabled optional services. Stop or settle the workload using the app's supported controls, then explicitly quit the app.

Verify the following observable outcomes:

- The main and splash windows close; no app-owned window remains.
- The main Electron process exits within the release owner's documented shutdown timeout. If no timeout is defined, record the measured duration and mark the timeout criterion BLOCKED rather than inventing a threshold.
- Any coordinator or other app-owned child process exits. Check the process tree, not just the parent PID.
- When Local API was enabled, its loopback listener releases the recorded port and no new retry/listener appears after quit.
- Registered file watchers no longer hold the process open or continue producing activity.
- Update and automation schedulers, dream/project-update timers and other configured background work stop; no new work is observed after process exit.
- No orphaned app-owned process, stale listener, repeated crash loop or unexpected restart remains.
- A subsequent launch succeeds and can reopen the same test profile without an unexplained lock, corruption warning or lost settings.

The implementation requests coordinator and fleet disposal asynchronously and does not await those promises in \`before-quit\`. Record whether their processes/resources actually terminate. A swallowed cleanup rejection or parent exit is not evidence that a child completed graceful disposal.

## 8. Failure, hang and forced-termination handling

If the app hangs during a graceful quit:

1. Capture the timestamp, visible state, main PID, child process tree, CPU/memory, open ports and relevant sanitized logs before intervening.
2. Wait only for the approved shutdown timeout. If no timeout is approved, do not silently choose one; mark the timeout policy BLOCKED and preserve the observed duration.
3. Use OS force-quit/termination only after evidence capture and only on the disposable test profile. Record the exact signal/action, exit status and whether child processes remained.
4. Mark the graceful-shutdown check FAIL. A forced kill is a separate recovery observation and never converts graceful shutdown to PASS.
5. Relaunch only after confirming no app-owned process or listener remains. Check the test profile for recoverable state and record any startup recovery, data loss or corruption.
6. Escalate repeatable hangs, orphan processes, listener leaks, settings/Vault write failures or data corruption to the runtime/release owner with the exact candidate SHA and reproduction steps.

Do not repeatedly force-kill a process before collecting evidence. Do not use production data or credentials in fault-injection or forced-termination rehearsals.

## 9. Cross-platform and regression gates

Run the repository's documented gates on the exact candidate SHA, using the OS-specific instructions in \`docs/TESTING.md\`:

\`\`\`bash
npm ci
npm run version:sync
npm run version:check
npm run build
npm run typecheck
\`\`\`

Full-suite test command:

\`\`\`bash
# Linux
xvfb-run -a npm test

# Windows / macOS
npm test
\`\`\`

The root scripts are declared in \`package.json\`. The CI workflow declares Ubuntu, Windows and macOS jobs, but workflow configuration is not evidence that a particular candidate passed. Inspect checks for the exact PR head SHA and record each required job's result.

For every run, record command, exit code, OS, Node/npm versions, exact SHA, pass/fail/skipped counts and explanations for skips. A green build or unit suite does not replace native runtime and shutdown verification on the target OS.

## 10. Acceptance record and HOLD criteria

For each OS and candidate build, record:

- Candidate SHA, product version, artifact identity/hash, OS/build, architecture, operator and UTC timestamps.
- Startup count, startup phase durations, UI readiness observations and single-instance behavior.
- Idle/active soak duration and periodic CPU, memory, process, handle and port measurements.
- Optional services enabled/disabled and the exact harmless action performed.
- Window-close and explicit-quit behavior, main-process exit duration, child-process exit and listener release.
- Any timeout, force-quit, crash, restart, orphan process, data recovery or deviation.
- Exact build/typecheck/test/CI evidence for the same candidate SHA, including raw pass/fail/skip counts.
- Sanitized logs and screenshots with secrets, personal data and sensitive paths removed.

Overall Runtime Stability & Shutdown Verification is PASS only when every required platform completes the defined startup, soak, window lifecycle and graceful-shutdown checks with no unexplained failure, orphan process or resource leak, and required release gates pass on the same candidate SHA.

Set overall status to HOLD if a required OS was not exercised, the app crashes or hangs, graceful quit requires force-kill, a child process or listener remains, resource growth is unexplained, evidence is incomplete, or any required gate is failing/unknown. Record BLOCKED or NOT RUN honestly; do not convert them to PASS.

This runbook is an operator procedure only. It does not claim that any runtime soak, shutdown rehearsal, native platform test or release gate has been performed on a new candidate.
