import { Ban, CirclePlay } from 'lucide-react'
import { useState } from 'react'
import { Panel, RadioGroup, Toggle } from './Controls'

export function BlockForm({ ownerEmail, busy, onSubmit }: { ownerEmail: string; busy: boolean; onSubmit: (payload: unknown) => void }) {
  const [folders, setFolders] = useState('')
  const [recursive, setRecursive] = useState(true)
  const [workers, setWorkers] = useState('4')
  const [unblock, setUnblock] = useState(false)
  const [dryRun, setDryRun] = useState(true)
  return <div className="screen-form narrow">
    <div className="screen-heading"><div><h1>Chặn tải xuống</h1><p>Chỉ chặn tải video (.mp4 và các định dạng video). PDF, MP3… không bị ảnh hưởng.</p></div><span className="heading-icon"><Ban size={24} /></span></div>
    <Panel className="block-panel">
      <label className="field-label">Folder URLs / IDs</label>
      <textarea className="large-input" placeholder="Nhập mỗi URL hoặc ID trên một dòng" value={folders} onChange={e => setFolders(e.target.value)} />
      <div className="settings-panel compact">
        <RadioGroup label="Số luồng" value={workers} onChange={setWorkers} options={[{ value: '1', label: '1' }, { value: '4', label: '4' }, { value: '8', label: '8' }, { value: '16', label: '16' }]} />
        <Toggle label="Quét thư mục con" checked={recursive} onChange={setRecursive} />
        <Toggle label="Cho phép tải lại" checked={unblock} onChange={setUnblock} />
        <Toggle label="Chạy thử" checked={dryRun} onChange={setDryRun} />
      </div>
      {!dryRun && <p className="risk-notice">Chế độ áp dụng thật đang bật. Thay đổi sẽ được ghi vào Google Drive.</p>}
    </Panel>
    <button className="primary-action" disabled={busy || !ownerEmail || !folders.trim()} onClick={() => onSubmit({ owner_email: ownerEmail, folders: folders.split(/\r?\n|,/).map(v => v.trim()).filter(Boolean), recursive, workers: Number(workers), unblock, dry_run: dryRun })}><CirclePlay size={19} />{busy ? 'Đang xử lý…' : dryRun ? 'Chạy thử' : unblock ? 'Áp dụng cho phép tải' : 'Áp dụng chặn tải'}</button>
  </div>
}
