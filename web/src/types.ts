export type Role = 'A' | 'B'
export type View = 'transfer' | 'copy-drive' | 'block' | 'accounts' | 'history'

export interface Account {
  role: Role
  email: string
  active?: boolean
}

export interface Job {
  id: string
  type?: string
  status?: 'queued' | 'running' | 'completed' | 'failed' | 'stopped' | string
  progress?: number
  logs?: Array<string | { message?: string; level?: string; timestamp?: string }>
  error?: string
  created_at?: string
  runner?: string
  run_url?: string
  run_id?: number
}

export interface TransferRow {
  id: string
  folders: string
  receiver_email: string
}
