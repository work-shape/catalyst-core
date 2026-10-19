import assert from "node:assert/strict";

export function appOracle(o) {
  assert.equal(o.invalidRows, 0, "invalid submit wrote a request");
  for (const key of ["validRows", "reloadedRows", "freshRows"])
    assert.equal(o[key], 1, `${key}: exactly one request must persist`);
  assert.equal(o.otherRows, 0, "private request leaked to another person");
  assert.equal(o.storageCommitted, true, "no successful persistence receipt");
  assert.equal(o.errors, 0, "form/storage/browser error");
}
export function workflowOracle(o) {
  assert.equal(o.status, "done");
  assert.equal(o.mode, "test");
  assert.equal(o.revision, o.expectedRevision, "tested wrong draft");
  assert.equal(o.tester, o.expectedTester, "test must record its ordinary actor");
  assert.equal(o.total, 42, "calculation output is wrong");
  assert.ok(o.notify.length > 0, "notify was omitted");
  for (const s of o.notify) {
    assert.equal(s.status, "done");
    assert.equal(s.target, "dry_run");
    assert.equal(s.operation, "notify", "notify did not record wouldHaveDone");
  }
  assert.equal(o.deliveries, 0, "test run delivered a notice/mail/job/attempt");
  assert.equal(o.published, false, "scenario published a Workflow");
  assert.equal(o.liveRuns, 0, "scenario started a live run");
}
export function consentOracle(o) {
  for (const key of [
    "beforeAssets",
    "beforeRevisions",
    "beforeFiles",
    "reconnectAssets",
    "reconnectRevisions",
    "reconnectFiles",
    "deniedAssets",
    "deniedRevisions",
    "deniedFiles"
  ])
    assert.equal(o[key], 0, `premature live write: ${key}`);
  assert.equal(o.pendingStatus, "pending_confirmation");
  assert.equal(o.deniedStatus, "denied");
  assert.equal(o.allowedAssets, 1);
  assert.equal(o.allowedRevisions, 1);
  assert.equal(o.allowedExecutions, 1);
  assert.equal(o.replayRevisions, 1);
  assert.equal(o.replayExecutions, 1);
  assert.equal(o.instructionMatches, true);
  assert.equal(o.ownerMatches, true);
}
export function createdOracle(row, { actorId, conversationId, runId, startedAt, seededIds, kind }) {
  assert.ok(row, "no generated asset creation receipt");
  assert.equal(row.kind, kind);
  assert.equal(row.actorId, actorId);
  assert.equal(row.conversationId, conversationId);
  assert.equal(row.runId, runId);
  assert.ok(
    new Date(row.createdAt).getTime() >= new Date(startedAt).getTime(),
    "asset predates scenario"
  );
  assert.ok(!seededIds.includes(row.id), "seeded asset cannot pass");
}
