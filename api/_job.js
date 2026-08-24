export function mapRunStatus(run) {
  if (run?.status !== 'completed') return run?.status === 'in_progress' ? 'running' : 'queued'
  if (run.conclusion === 'success') return 'completed'
  if (run.conclusion === 'cancelled') return 'stopped'
  return 'failed'
}

export function workflowKindFromRun(run) {
  const text = `${run?.name || ''} ${run?.display_title || ''}`
  const match = text.match(/\bowner-tool\s+(transfer|block|unblock|copy-drive)\b/i)
  return match ? match[1].toLowerCase() : undefined
}

export function cancelOutcome(run, response) {
  if (!run) return { status: 'queued', runner: 'github' }
  if (run.status === 'completed') return { status: mapRunStatus(run), runner: 'github' }
  if (!response?.ok) return null
  return { status: 'stopped', runner: 'github' }
}
