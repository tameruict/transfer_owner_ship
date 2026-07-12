import { Ban, Clock3, Copy, FolderKey, LogOut, Menu, Repeat2, UsersRound, X } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Account, View } from '../types'

const items: Array<{ id: View; label: string; icon: typeof Repeat2 }> = [
  { id: 'copy-drive', label: 'Copy Drive', icon: Copy },
  { id: 'transfer', label: 'Chuyển owner', icon: Repeat2 },
  { id: 'block', label: 'Chặn tải xuống', icon: Ban },
  { id: 'accounts', label: 'Tài khoản', icon: UsersRound },
  { id: 'history', label: 'Lịch sử', icon: Clock3 },
]

export function Shell({ children, view, onView, account, accountsA, onAccount, connected, logsOpen, onLogs, userEmail, onLogout }: { children: ReactNode; view: View; onView: (v: View) => void; account?: Account; accountsA: Account[]; onAccount: (account: Account) => void; connected: boolean; logsOpen: boolean; onLogs: () => void; userEmail: string; onLogout: () => void }) {
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><FolderKey size={19} /></span><span>Owner Video Tool</span></div>
      <nav>{items.map(({ id, label, icon: Icon }) => <button key={id} className={view === id ? 'active' : ''} onClick={() => onView(id)}><Icon size={20} /><span>{label}</span></button>)}</nav>
      <div className="local-status"><i className={connected ? 'online' : ''} />{connected ? 'Đã kết nối máy chủ' : 'Mất kết nối'}<small>API Node/Vercel đã khóa đăng nhập</small></div>
    </aside>
    <header className="topbar">
      <div className="mobile-brand"><span className="brand-mark"><FolderKey size={18} /></span><strong>Owner Tool</strong></div>
      <label className="account-picker"><span>Account A nguồn</span><div><span className="avatar">{account?.email?.slice(0, 2).toUpperCase() || 'A'}</span><select value={account?.email || ''} onChange={event => { const selected = accountsA.find(item => item.email === event.target.value); if (selected) onAccount(selected) }}><option value="">Chọn Account A</option>{accountsA.map(item => <option key={item.email} value={item.email}>{item.email}</option>)}</select></div></label>
      <div className="top-account"><span className={`status-dot ${connected ? 'ok' : ''}`}>{connected ? 'Đã kết nối' : 'Ngoại tuyến'}</span><small>{userEmail}</small></div>
      <button className="icon-button log-toggle" onClick={onLogs} aria-label={logsOpen ? 'Đóng nhật ký' : 'Mở nhật ký'}>{logsOpen ? <X size={20} /> : <Menu size={20} />}<span>Nhật ký</span></button>
      <button className="icon-button logout-button" onClick={onLogout} aria-label="Đăng xuất"><LogOut size={20} /><span>Đăng xuất</span></button>
    </header>
    <main>{children}</main>
    <nav className="bottom-nav">{items.map(({ id, label, icon: Icon }) => <button key={id} className={view === id ? 'active' : ''} onClick={() => onView(id)}><Icon size={20} /><span>{label.replace('Chuyển owner', 'Chuyển')}</span></button>)}</nav>
  </div>
}
