import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from './api'
import { Accounts } from './components/Accounts'
import { BlockForm } from './components/BlockForm'
import { CopyDriveForm } from './components/CopyDriveForm'
import { History } from './components/History'
import { JobLog } from './components/JobLog'
import { LoginScreen } from './components/LoginScreen'
import { Shell } from './components/Shell'
import { TransferForm } from './components/TransferForm'
import type { Account, Job, Role, View } from './types'

const JOB_STORAGE_KEY = 'owner-tool-jobs'

function readStoredJobs(): Job[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(JOB_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter(item => item && typeof item.id === 'string') : []
  } catch {
    return []
  }
}

export default function App() {
  const [view, setView] = useState<View>('transfer')
  const [accounts, setAccounts] = useState<Account[]>([])
  const [connected, setConnected] = useState(false)
  const [loading, setLoading] = useState(false)
  const [jobs, setJobs] = useState<Job[]>(readStoredJobs)
  const [job, setJob] = useState<Job | undefined>(() => readStoredJobs()[0])
  const [logsOpen, setLogsOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [userEmail, setUserEmail] = useState('')
  const [authReady, setAuthReady] = useState(false)
  const activeA = useMemo(() => accounts.find(a => a.role === 'A' && a.active) || accounts.find(a => a.role === 'A'), [accounts])

  useEffect(() => {
    try {
      if (jobs.length) window.localStorage.setItem(JOB_STORAGE_KEY, JSON.stringify(jobs.slice(0, 50)))
      else window.localStorage.removeItem(JOB_STORAGE_KEY)
    } catch { /* storage can be unavailable in private/restricted browsers */ }
  }, [jobs])

  const refreshAccounts = useCallback(async () => { try { setAccounts(await api.accounts()) } catch (error) { setNotice((error as Error).message) } }, [])
  useEffect(() => {
    api.health().then(() => setConnected(true)).catch(() => setConnected(false))
    api.session()
      .then(session => {
        if (session.authenticated && session.user?.email) {
          setUserEmail(session.user.email)
          refreshAccounts()
        }
      })
      .catch(() => setUserEmail(''))
      .finally(() => setAuthReady(true))
  }, [refreshAccounts])
  useEffect(() => {
    // Handle the full-page-redirect fallback: Google sent us back to /?oauth=…
    const params = new URLSearchParams(window.location.search)
    const status = params.get('oauth')
    if (!status) return
    if (status === 'ok') setNotice(`Đã kết nối ${params.get('email') || 'tài khoản'} (vai trò ${params.get('role') || ''}).`)
    else setNotice(`Kết nối Google thất bại: ${params.get('reason') || 'unknown'}`)
    window.history.replaceState({}, '', window.location.pathname)
    refreshAccounts()
  }, [refreshAccounts])
  useEffect(() => {
    if (!job?.id || !['queued', 'running'].includes(job.status || '')) return
    const timer = window.setInterval(async () => { try { const next = await api.job(job.id); setJob(prev => prev ? { ...prev, ...next, type: next.type || prev.type } : next); setJobs(all => all.map(item => item.id === next.id ? { ...item, ...next, type: next.type || item.type } : item)) } catch (error) { setNotice((error as Error).message) } }, 1500)
    return () => window.clearInterval(timer)
  }, [job?.id, job?.status])

  const startJob = async (kind: 'transfer' | 'block' | 'unblock' | 'copy-drive', payload: unknown) => {
    const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
    if (data.dry_run === false) {
      const labels: Record<string, string> = { transfer: 'chuyển ownership', block: 'chặn tải xuống', unblock: 'mở tải xuống', 'copy-drive': 'copy Drive' }
      const confirmed = window.confirm(`Xác nhận ${labels[kind] || kind} thật? Thay đổi sẽ được ghi trực tiếp vào Google Drive.`)
      if (!confirmed) return
    }
    setLoading(true); setNotice(''); try { const next = kind === 'transfer' ? await api.startTransfer(payload) : kind === 'copy-drive' ? await api.startCopyDrive(payload) : await api.startBlock(payload); const normalized = { ...next, type: next.type || kind }; setJob(normalized); setJobs(all => [normalized, ...all.filter(item => item.id !== normalized.id)]); setLogsOpen(true) } catch (error) { setNotice((error as Error).message) } finally { setLoading(false) }
  }
  const connectAccount = (role: Role) => {
    setNotice('')
    // Redirect-based Google web OAuth. /api/oauth/start 302s to Google; after
    // consent the server writes the token to the encrypted KV store and sends the tab
    // back to /?oauth=ok. We watch the popup land back on our origin, then close
    // it and refresh. If the popup is blocked, fall back to a full-page redirect.
    const url = `/api/oauth/start?role=${role}`
    const popup = window.open(url, 'owner_tool_oauth', 'width=520,height=680')
    if (!popup) { window.location.assign(url); return }
    const timer = window.setInterval(() => {
      let done = false
      try {
        if (popup.closed) done = true
        else if (popup.location.search.includes('oauth=')) { done = true; popup.close() }
      } catch { /* still on accounts.google.com (cross-origin) — keep waiting */ }
      if (done) { window.clearInterval(timer); refreshAccounts() }
    }, 800)
    window.setTimeout(() => window.clearInterval(timer), 180000)
  }
  const activate = async (account: Account) => { try { await api.activate(account.role, account.email); await refreshAccounts() } catch (error) { setNotice((error as Error).message) } }
  const removeAccount = async (account: Account) => { if (!window.confirm(`Xóa tài khoản ${account.role} "${account.email}"? Token sẽ bị gỡ khỏi hệ thống.`)) return; setNotice(''); try { await api.remove(account.role, account.email); setNotice(`Đã xóa tài khoản ${account.role}: ${account.email}`); await refreshAccounts() } catch (error) { setNotice((error as Error).message) } }
  const stop = async () => { if (!job?.id) return; try { const next = await api.stop(job.id); setJob(next); setJobs(all => all.map(item => item.id === next.id ? next : item)) } catch (error) { setNotice((error as Error).message) } }
  const login = async (password: string) => { setLoading(true); setNotice(''); try { const result = await api.login(password); setUserEmail(result.user.email); await refreshAccounts() } catch (error) { setNotice((error as Error).message) } finally { setLoading(false) } }
  const logout = async () => { try { await api.logout() } finally { setUserEmail(''); setAccounts([]); setJob(undefined); setJobs([]); setLogsOpen(false) } }

  if (!authReady) return <div className="boot-screen">Đang mở Owner Tool…</div>
  if (!userEmail) return <LoginScreen busy={loading} notice={notice} onClearNotice={() => setNotice('')} onLogin={login} />

  return <Shell view={view} onView={setView} account={activeA} accountsA={accounts.filter(a => a.role === 'A')} onAccount={activate} connected={connected} logsOpen={logsOpen} onLogs={() => setLogsOpen(v => !v)} userEmail={userEmail} onLogout={logout}>
    <div className={`workspace ${logsOpen ? 'logs-visible' : ''}`}>
      <div className="content-area">
        {notice && <div className="notice" role="alert"><span>{notice}</span><button onClick={() => setNotice('')}>×</button></div>}
        {view === 'transfer' && <TransferForm accounts={accounts} ownerEmail={activeA?.email || ''} busy={loading} onSubmit={payload => startJob('transfer', payload)} />}
        {view === 'copy-drive' && <CopyDriveForm ownerEmail={activeA?.email || ''} busy={loading} onSubmit={payload => startJob('copy-drive', payload)} />}
        {view === 'block' && <BlockForm key="block" ownerEmail={activeA?.email || ''} busy={loading} onSubmit={payload => startJob('block', payload)} />}
        {view === 'unblock' && <BlockForm mode="allow" ownerEmail={activeA?.email || ''} busy={loading} onSubmit={payload => startJob('unblock', payload)} />}
        {view === 'accounts' && <Accounts accounts={accounts} loading={loading} onConnect={connectAccount} onActivate={activate} onDelete={removeAccount} />}
        {view === 'history' && <History jobs={jobs} onSelect={selected => { setJob(selected); setLogsOpen(true) }} />}
      </div>
      <div className="log-backdrop" onClick={() => setLogsOpen(false)} />
      <JobLog job={job} open={logsOpen} onClose={() => setLogsOpen(false)} onStop={stop} />
    </div>
  </Shell>
}
