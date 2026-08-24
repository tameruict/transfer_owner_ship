import { CirclePlay, Plus, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { Account, TransferRow } from '../types'
import { Panel, RadioGroup, Toggle } from './Controls'

const newRow = (): TransferRow => ({ id: crypto.randomUUID(), folders: '', receiver_email: '' })

export function TransferForm({ accounts, ownerEmail, busy, onSubmit }: { accounts: Account[]; ownerEmail: string; busy: boolean; onSubmit: (payload: unknown) => void }) {
  const [rows, setRows] = useState<TransferRow[]>([newRow()])
  const [mode, setMode] = useState('consumer')
  const [scope, setScope] = useState('videos')
  const [recursive, setRecursive] = useState(true)
  const [noNotify, setNoNotify] = useState(false)
  const [verify, setVerify] = useState(false)
  const [workers, setWorkers] = useState('4')
  const [dryRun, setDryRun] = useState(true)
  const receivers = useMemo(() => accounts.filter(a => a.role === 'B'), [accounts])
  const update = (id: string, patch: Partial<TransferRow>) => setRows(value => value.map(row => row.id === id ? { ...row, ...patch } : row))
  const submit = () => onSubmit({ owner_email: ownerEmail, rows: rows.map(row => ({ folders: row.folders.split(/\r?\n|,/).map(v => v.trim()).filter(Boolean), receiver_email: row.receiver_email })), mode, scope, recursive, no_notify: noNotify, verify, workers: Number(workers), dry_run: dryRun })

  return <div className="screen-form">
    <div className="screen-heading"><div><h1>Chuyển ownership</h1><p>Chuyển quyền sở hữu video, file (word/pdf/docx…) và thư mục Drive sang Account B.</p></div></div>
    <Panel className="transfer-table">
      <div className="table-head"><span>Folder URLs / IDs</span><span>Account B nhận owner</span></div>
      {rows.map((row, index) => <div className="transfer-row" key={row.id}>
        <span className="row-number">{index + 1}</span>
        <textarea aria-label={`Folder dòng ${index + 1}`} placeholder={'Mỗi URL hoặc ID một dòng'} value={row.folders} onChange={e => update(row.id, { folders: e.target.value })} />
        <select aria-label={`Account B dòng ${index + 1}`} value={row.receiver_email} onChange={e => update(row.id, { receiver_email: e.target.value })}><option value="">Chọn Account B</option>{receivers.map(a => <option key={a.email}>{a.email}</option>)}</select>
        <button className="delete-row" onClick={() => setRows(v => v.length === 1 ? [newRow()] : v.filter(item => item.id !== row.id))} aria-label="Xóa dòng"><Trash2 size={19} /></button>
      </div>)}
      <button className="add-row" onClick={() => setRows(v => [...v, newRow()])}><Plus size={19} />Thêm dòng</button>
    </Panel>
    <Panel className="settings-panel">
      <RadioGroup label="Chế độ" value={mode} onChange={value => { setMode(value); if (value === 'consumer') setNoNotify(false) }} options={[{ value: 'consumer', label: 'Consumer' }, { value: 'workspace', label: 'Workspace' }]} />
      <RadioGroup label="Phạm vi" value={scope} onChange={setScope} options={[{ value: 'videos', label: 'Videos' }, { value: 'files', label: 'Mọi file' }, { value: 'folders', label: 'Folders' }, { value: 'all', label: 'Tất cả' }]} />
      <RadioGroup label="Số luồng" value={workers} onChange={setWorkers} options={[{ value: '1', label: '1' }, { value: '4', label: '4' }, { value: '8', label: '8' }, { value: '16', label: '16' }]} />
      <Toggle label="Quét thư mục con" checked={recursive} onChange={setRecursive} />
      <Toggle label="Xác minh sau khi chuyển" checked={verify} onChange={setVerify} />
      <Toggle label="Không gửi email (Workspace)" checked={noNotify} onChange={setNoNotify} disabled={mode === 'consumer'} />
      <Toggle label="Chạy thử" checked={dryRun} onChange={setDryRun} />
    </Panel>
    <button className="primary-action" disabled={busy || !ownerEmail || rows.some(r => !r.folders || !r.receiver_email)} onClick={submit}><CirclePlay size={19} />{busy ? 'Đang xử lý…' : 'Kiểm tra & chạy'}</button>
  </div>
}
