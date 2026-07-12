import type { Account, Job, Role } from './types'

type RawAccount = string | { email?: string; active?: boolean }
type AccountsResponse = Account[] | { accounts?: Account[]; A?: RawAccount[]; B?: RawAccount[]; active_a?: string }
type RawJob = Job & { job_id?: string }

const normalizeJob = (data: RawJob): Job => ({ ...data, id: data.id || data.job_id || '' })
const normalizeAccounts = (data: AccountsResponse): Account[] => {
  if (Array.isArray(data)) return data
  if (data.accounts) return data.accounts
  const unpack = (items: RawAccount[] | undefined, role: Role) => (items || []).map(item => ({
    role,
    email: typeof item === 'string' ? item : item.email || '',
    active: typeof item === 'string' ? role === 'A' && item === data.active_a : item.active || (role === 'A' && item.email === data.active_a),
  })).filter(item => item.email)
  return [...unpack(data.A, 'A'), ...unpack(data.B, 'B')]
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.detail || data.message || `Lỗi máy chủ (${response.status})`)
  return data as T
}

export const api = {
  health: () => request<{ ok?: boolean; status?: string }>('/api/health'),
  session: () => request<{ authenticated: boolean; user?: { email: string } | null }>('/api/auth/session'),
  login: (password: string) => request<{ user: { email: string } }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  accounts: async () => {
    const data = await request<AccountsResponse>('/api/accounts')
    return normalizeAccounts(data)
  },
  oauth: (role: Role) => request<{ id?: string; oauth_id?: string; url?: string; authorization_url?: string }>('/api/accounts/oauth', { method: 'POST', body: JSON.stringify({ role }) }),
  oauthStatus: (id: string) => request<Record<string, unknown>>(`/api/oauth/${id}`),
  activate: (role: Role, email: string) => request<Account>(`/api/accounts/${role}/${encodeURIComponent(email)}/activate`, { method: 'POST' }),
  remove: (role: Role, email: string) => request<{ ok: boolean; active_a?: string | null }>(`/api/accounts/${role}/${encodeURIComponent(email)}`, { method: 'DELETE' }),
  startTransfer: async (body: unknown) => normalizeJob(await request<RawJob>('/api/jobs/transfer', { method: 'POST', body: JSON.stringify(body) })),
  startBlock: async (body: unknown) => normalizeJob(await request<RawJob>('/api/jobs/block', { method: 'POST', body: JSON.stringify(body) })),
  startCopyDrive: async (body: unknown) => normalizeJob(await request<RawJob>('/api/jobs/copy-drive', { method: 'POST', body: JSON.stringify(body) })),
  job: async (id: string) => normalizeJob(await request<RawJob>(`/api/jobs/${id}`)),
  stop: async (id: string) => normalizeJob(await request<RawJob>(`/api/jobs/${id}/stop`, { method: 'POST' })),
}
