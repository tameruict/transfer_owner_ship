import { CheckCircle2, Clock3, LoaderCircle, XCircle } from 'lucide-react'
import type { Job } from '../types'
import { Panel } from './Controls'

const jobLabel = (type?: string) => type === 'block' ? 'Chặn tải xuống' : type === 'unblock' ? 'Cho phép tải xuống' : type === 'copy-drive' ? 'Copy Drive' : 'Chuyển ownership'

export function History({ jobs, onSelect }: { jobs: Job[]; onSelect: (job: Job) => void }) {
  return <div className="screen-form narrow"><div className="screen-heading"><div><h1>Lịch sử phiên này</h1><p>Các tác vụ đã thực hiện từ khi bạn mở ứng dụng.</p></div></div><Panel className="history-list">{jobs.length === 0 ? <div className="history-empty"><Clock3 size={34} /><strong>Chưa có tác vụ</strong><span>Chạy một tác vụ để xem trạng thái tại đây.</span></div> : jobs.map(job => <button className="history-item" key={job.id} onClick={() => onSelect(job)}>{job.status === 'completed' ? <CheckCircle2 className="success" /> : job.status === 'failed' ? <XCircle className="danger" /> : <LoaderCircle className="spin" />}<span><strong>{jobLabel(job.type)}</strong><small>{job.created_at ? new Date(job.created_at).toLocaleString('vi-VN') : job.id}</small></span><i className={`job-status ${job.status}`}>{job.status}</i></button>)}</Panel></div>
}
