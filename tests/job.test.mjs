import test from 'node:test'
import assert from 'node:assert/strict'
import { cancelOutcome, mapRunStatus, workflowKindFromRun } from '../api/_job.js'

test('maps GitHub conclusions to UI statuses', () => {
  assert.equal(mapRunStatus({ status: 'queued' }), 'queued')
  assert.equal(mapRunStatus({ status: 'in_progress' }), 'running')
  assert.equal(mapRunStatus({ status: 'completed', conclusion: 'success' }), 'completed')
  assert.equal(mapRunStatus({ status: 'completed', conclusion: 'cancelled' }), 'stopped')
  assert.equal(mapRunStatus({ status: 'completed', conclusion: 'failure' }), 'failed')
})

test('preserves the complete copy-drive job kind', () => {
  assert.equal(workflowKindFromRun({ name: 'owner-tool copy-drive 123' }), 'copy-drive')
  assert.equal(workflowKindFromRun({ display_title: 'owner-tool transfer 123' }), 'transfer')
  assert.equal(workflowKindFromRun({ name: 'unrelated workflow' }), undefined)
})

test('does not claim a completed or rejected run was stopped', () => {
  assert.deepEqual(
    cancelOutcome({ status: 'completed', conclusion: 'success' }, { ok: true }),
    { status: 'completed', runner: 'github' },
  )
  assert.equal(cancelOutcome({ status: 'in_progress' }, { ok: false }), null)
  assert.deepEqual(
    cancelOutcome({ status: 'in_progress' }, { ok: true }),
    { status: 'stopped', runner: 'github' },
  )
})
