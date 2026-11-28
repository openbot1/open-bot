import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const runbook = fs.readFileSync(
  path.join(process.cwd(), 'docs', 'ops', 'RELEASE-ROLLBACK-FORWARD-FIX-REHEARSAL.md'),
  'utf8',
);

test('pins the procedure to the reviewed remote main snapshot', () => {
  assert.ok(runbook.includes('2d14cc1b73c3f9fecb4b92614c180fb15a404aec'));
  assert.ok(runbook.includes('controlled rehearsal'));
});

test('limits the scope to an already published release', () => {
  assert.ok(runbook.includes('already published open-bot release'));
  assert.ok(runbook.includes('withdrawn, rolled back where safe, or superseded by a forward-fix'));
  assert.ok(runbook.includes('decision authority, source and artifact identity'));
});

test('distinguishes tabletop simulation from real release actions', () => {
  assert.ok(runbook.includes('A rehearsal is a documented simulation'));
  assert.ok(runbook.includes('Do not publish, withdraw, overwrite or downgrade a release during a tabletop exercise'));
  assert.ok(runbook.includes('does not assume an automatic in-app updater'));
});

test('defines rehearsal objectives and explicit safety boundaries', () => {
  assert.ok(runbook.includes('protect local user data'));
  assert.ok(runbook.includes('Do not change production release state during a tabletop rehearsal'));
  assert.ok(runbook.includes('do not add features or bundle unrelated code changes'));
});

test('assigns decision authority and separates operational roles', () => {
  assert.ok(runbook.includes('Incident owner'));
  assert.ok(runbook.includes('Release owner'));
  assert.ok(runbook.includes('Technical patch owner'));
  assert.ok(runbook.includes('Data-safety reviewer'));
  assert.ok(runbook.includes('Independent verifier'));
  assert.ok(runbook.includes('Authorised maintainer / release approver'));
  assert.ok(runbook.includes('Communications owner'));
});

test('requires an authorised approver for production decisions', () => {
  assert.ok(runbook.includes('owns the final decision to publish a rollback or forward-fix'));
  assert.ok(runbook.includes('the independent verifier does not approve their own patch'));
  assert.ok(runbook.includes('If no authorised approver is available, keep the affected distribution paused'));
});

test('defines release failure and security triggers', () => {
  assert.ok(runbook.includes('published release is defective'));
  assert.ok(runbook.includes('material regression or data risk'));
  assert.ok(runbook.includes('security vulnerability'));
  assert.ok(runbook.includes('incorrect provenance/signing'));
});

test('records exact incident and release identity', () => {
  assert.ok(runbook.includes('Discovery time in UTC'));
  assert.ok(runbook.includes('Exact affected product version, release tag, source commit SHA'));
  assert.ok(runbook.includes('Artifact filename, byte size, SHA-256'));
  assert.ok(runbook.includes('Whether the release is available for download'));
});

test('defines containment options without destroying evidence', () => {
  assert.ok(runbook.includes('pausing new publication'));
  assert.ok(runbook.includes('marking an affected release as withdrawn'));
  assert.ok(runbook.includes('prevents additional harm without destroying evidence'));
});

test('defines the conditions for a safe rollback', () => {
  assert.ok(runbook.includes('Rollback is appropriate only when'));
  assert.ok(runbook.includes('prior release is verified as safe'));
  assert.ok(runbook.includes('compatible with data already written by the newer release'));
  assert.ok(runbook.includes('exact previously approved source SHA'));
});

test('defines when forward-fix is preferred', () => {
  assert.ok(runbook.includes('Forward-fix is preferred when'));
  assert.ok(runbook.includes('The previous release is vulnerable, compromised or otherwise unsafe'));
  assert.ok(runbook.includes('A narrow correction can be built and verified'));
  assert.ok(runbook.includes('Rollback would require destructive migration reversal'));
});

test('defines when distribution must remain paused', () => {
  assert.ok(runbook.includes('Pause distribution or use a mitigation when'));
  assert.ok(runbook.includes('Neither rollback nor forward-fix has yet passed required verification'));
  assert.ok(runbook.includes('prefer a reversible pause'));
});

test('requires SQLite, Vault and local-state compatibility review', () => {
  assert.ok(runbook.includes('SQLite database schema versions'));
  assert.ok(runbook.includes('WAL/checkpoint behaviour'));
  assert.ok(runbook.includes('Vault format/version'));
  assert.ok(runbook.includes('settings files and workspace state'));
});

test('requires explicit data-safety reviewer answers', () => {
  assert.ok(runbook.includes('The data-safety reviewer must answer all of these questions'));
  assert.ok(runbook.includes('Can the prior application version read the post-release data'));
  assert.ok(runbook.includes('Is a verified backup available'));
  assert.ok(runbook.includes('If compatibility is unknown, rollback is not approved'));
});

test('prohibits destructive testing on real user data', () => {
  assert.ok(runbook.includes("Do not test downgrade behaviour against a user's only copy of real data"));
  assert.ok(runbook.includes('Use synthetic fixtures or a disposable copy'));
  assert.ok(runbook.includes('Preserve the original backup unchanged'));
});

test('defines representative rehearsal scenarios', () => {
  assert.ok(runbook.includes('Application regression'));
  assert.ok(runbook.includes('Security vulnerability'));
  assert.ok(runbook.includes('Data migration incompatibility'));
  assert.ok(runbook.includes('Artifact or signing issue'));
  assert.ok(runbook.includes('Partial platform availability'));
});

test('labels exercise actions as simulated', () => {
  assert.ok(runbook.includes('SIMULATED label'));
  assert.ok(runbook.includes('confirms no production write action is authorised'));
});

test('specifies the rollback rehearsal steps and pass conditions', () => {
  assert.ok(runbook.includes('Rollback rehearsal procedure'));
  assert.ok(runbook.includes('Simulate installation/launch of the prior version'));
  assert.ok(runbook.includes('A rollback rehearsal passes only when'));
  assert.ok(runbook.includes('data compatibility is demonstrated on disposable state'));
});

test('specifies the forward-fix rehearsal steps and pass conditions', () => {
  assert.ok(runbook.includes('Forward-fix rehearsal procedure'));
  assert.ok(runbook.includes('Create a dedicated patch candidate'));
  assert.ok(runbook.includes('A forward-fix rehearsal passes only when'));
  assert.ok(runbook.includes('explicit approval from the authorised release approver'));
});

test('requires exact-SHA regression and full-suite verification', () => {
  assert.ok(runbook.includes('Run focused tests, build and typecheck'));
  assert.ok(runbook.includes('required full-suite gate on the exact candidate SHA'));
  assert.ok(runbook.includes('a skip is not a pass'));
  assert.ok(runbook.includes('Record unavailable platform checks as NOT RUN'));
});

test('requires exact artifact, signing and provenance evidence', () => {
  assert.ok(runbook.includes('artifact filename, platform, architecture, byte size, SHA-256'));
  assert.ok(runbook.includes('signature, certificate chain and provenance'));
  assert.ok(runbook.includes('uploaded bytes match the approved local artifact hashes'));
});

test('prohibits overwriting release tags and unsafe rollback selection', () => {
  assert.ok(runbook.includes('do not move or overwrite an existing tag'));
  assert.ok(runbook.includes('publish or point only to the exact safe prior artifact'));
  assert.ok(runbook.includes('If neither path is safe, keep distribution paused'));
});

test('requires updater behaviour to be described accurately', () => {
  assert.ok(runbook.includes('If the application requires manual download and installation, say so explicitly'));
  assert.ok(runbook.includes('do not promise automatic in-app installation'));
});

test('defines required user-facing notice contents', () => {
  assert.ok(runbook.includes('A user notice must state'));
  assert.ok(runbook.includes('Product version range and platforms confirmed affected'));
  assert.ok(runbook.includes('Whether users must manually download/install'));
  assert.ok(runbook.includes('Publication timestamp and private route'));
});

test('prevents unsafe user downgrade advice and false universal-fix claims', () => {
  assert.ok(runbook.includes('Do not state that all users are protected'));
  assert.ok(runbook.includes('Do not ask users to downgrade to a version that is still vulnerable'));
  assert.ok(runbook.includes('Avoid exposing exploit steps'));
});

test('defines restricted evidence and required hashes', () => {
  assert.ok(runbook.includes('Exercise identifier, scenario, START/STOP timestamps in UTC'));
  assert.ok(runbook.includes('Artifact filenames, byte sizes, SHA-256 hashes'));
  assert.ok(runbook.includes('Preserve originals unchanged'));
  assert.ok(runbook.includes('Do not place raw credentials'));
});

test('defines pass criteria, fail handling and closure authority', () => {
  assert.ok(runbook.includes('Record each criterion as PASS, FAIL, NOT RUN or SIMULATED'));
  assert.ok(runbook.includes('The rehearsal fails if decision authority is unclear'));
  assert.ok(runbook.includes('Repeat the affected scenario after the correction'));
  assert.ok(runbook.includes('the independent reviewer confirms evidence completeness'));
});

test('defines review triggers and avoids unsupported automation claims', () => {
  assert.ok(runbook.includes('Review this runbook after a real rollback/forward-fix incident'));
  assert.ok(runbook.includes('does not establish an automatic rollback service'));
  assert.ok(runbook.includes('authority to bypass release approval and verification controls'));
});
