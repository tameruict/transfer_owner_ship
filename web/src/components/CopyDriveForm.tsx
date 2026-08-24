import { CirclePlay, Copy, FileVideo2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Panel, RadioGroup, Toggle } from './Controls'

const defaultFileExtensions = '.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.csv,.mp3,.wav,.m4a'
const defaultVideoExtensions = '.mp4,.mov,.mkv,.avi,.webm,.m4v,.wmv'

const splitLines = (value: string) => value.split(/\r?\n|,/).map(item => item.trim()).filter(Boolean)
const splitExtensions = (value: string) => splitLines(value).map(item => item.startsWith('.') ? item : `.${item}`)

export function CopyDriveForm({ ownerEmail, busy, onSubmit }: { ownerEmail: string; busy: boolean; onSubmit: (payload: unknown) => void }) {
  const [dest, setDest] = useState('')
  const [sources, setSources] = useState('')
  const [filterMode, setFilterMode] = useState('all')
  const [fileExtensions, setFileExtensions] = useState(defaultFileExtensions)
  const [videoExtensions, setVideoExtensions] = useState(defaultVideoExtensions)
  const [exclude, setExclude] = useState('')
  const [sort, setSort] = useState('name')
  const [workers, setWorkers] = useState('10')
  const [recursive, setRecursive] = useState(true)
  const [checkpoint, setCheckpoint] = useState(true)
  const [dryRun, setDryRun] = useState(true)
  const sourceCount = useMemo(() => splitLines(sources).length, [sources])
  const canSubmit = Boolean(ownerEmail && dest.trim() && sourceCount > 0 && !busy)
  const showFileExtensions = filterMode === 'files' || filterMode === 'custom'
  const showVideoExtensions = filterMode === 'videos' || filterMode === 'custom'
  const submit = () => onSubmit({
    owner_email: ownerEmail,
    dest,
    sources: splitLines(sources),
    filter_mode: filterMode,
    file_extensions: splitExtensions(fileExtensions),
    video_extensions: splitExtensions(videoExtensions),
    exclude,
    sort,
    workers: Number(workers),
    recursive,
    checkpoint,
    dry_run: dryRun,
  })

  return <div className="screen-form narrow">
    <div className="screen-heading">
      <div>
        <h1>Copy Drive</h1>
        <p>Copy file/folder từ Drive nguồn sang folder đích bằng token Account A đang chọn, có checkpoint và lọc theo định dạng.</p>
      </div>
      <span className="heading-icon"><Copy size={24} /></span>
    </div>
    <Panel className="copy-drive-panel">
      <label className="field-label">Link folder đích</label>
      <textarea className="medium-input" placeholder="Dán link folder đích hoặc ID folder đích" value={dest} onChange={event => setDest(event.target.value)} />
      <label className="field-label with-gap">Link nguồn</label>
      <textarea className="large-input" placeholder="Mỗi link/ID nguồn một dòng. Có thể là folder hoặc file." value={sources} onChange={event => setSources(event.target.value)} />
      <p className="helper-copy"><FileVideo2 size={15} />Đã nhận {sourceCount} nguồn. Account chạy: {ownerEmail || 'chưa chọn Account A'}.</p>
    </Panel>
    <Panel className="settings-panel">
      <RadioGroup label="Lọc copy" value={filterMode} onChange={setFilterMode} options={[
        { value: 'all', label: 'Tất cả' },
        { value: 'files', label: 'File' },
        { value: 'videos', label: 'Video' },
        { value: 'custom', label: 'Tùy chọn' },
      ]} />
      <RadioGroup label="Sắp xếp báo cáo" value={sort} onChange={setSort} options={[{ value: 'name', label: 'Theo tên' }, { value: 'stt', label: 'Theo STT gốc' }]} />
      <RadioGroup label="Số luồng" value={workers} onChange={setWorkers} options={[{ value: '1', label: '1' }, { value: '4', label: '4' }, { value: '10', label: '10' }, { value: '16', label: '16' }]} />
      <Toggle label="Quét thư mục con" checked={recursive} onChange={setRecursive} />
      <Toggle label="Dùng checkpoint" checked={checkpoint} onChange={setCheckpoint} />
      <Toggle label="Chạy thử" checked={dryRun} onChange={setDryRun} />
    </Panel>
    {(showFileExtensions || showVideoExtensions) && <Panel className="copy-extension-panel">
      {showFileExtensions && <label><span>Đuôi file</span><textarea value={fileExtensions} onChange={event => setFileExtensions(event.target.value)} placeholder=".pdf,.docx,.mp3" /></label>}
      {showVideoExtensions && <label><span>Đuôi video</span><textarea value={videoExtensions} onChange={event => setVideoExtensions(event.target.value)} placeholder=".mp4,.mov,.mkv" /></label>}
    </Panel>}
    <Panel className="copy-extra-panel">
      <label><span>Từ khóa loại trừ</span><input value={exclude} onChange={event => setExclude(event.target.value)} placeholder="demo, trailer, draft..." /></label>
    </Panel>
    <button className="primary-action" disabled={!canSubmit} onClick={submit}><CirclePlay size={19} />{busy ? 'Đang xử lý…' : dryRun ? 'Chạy thử copy' : 'Bắt đầu copy'}</button>
  </div>
}
