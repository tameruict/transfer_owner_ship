import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { google } from 'googleapis'
import { storeConfigured, readBundle, writeBundle, upsertAccount, removeAccount } from './_store.js'
import { oauthConfigured, callbackUrl, signState, verifyState, buildAuthUrl, exchangeCode } from './_oauth.js'

export const config = { api: { bodyParser: true } }

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const FOLDER_MIME = 'application/vnd.google-apps.folder'
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut'
const GOOGLE_SHEETS_MIME = 'application/vnd.google-apps.spreadsheet'
const VIDEO_PREFIX = 'video/'
const DEFAULT_FILE_EXTENSIONS = ['.pdf', '.doc', '.docx', '.rtf', '.txt', '.ppt', '.pptx', '.xls', '.xlsx', '.csv', '.mp3', '.wav', '.m4a', '.aac']
const DEFAULT_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.wmv', '.flv', '.mpeg', '.mpg']
const ALLOWED_EMAIL = (process.env.OWNER_TOOL_ALLOWED_EMAIL || 'tamatm6713@gmail.com').trim().toLowerCase()
const SESSION_COOKIE = 'owner_tool_session'
const SESSION_TTL_SECONDS = 60 * 60 * 12

// GitHub Actions dispatch mode. When GITHUB_REPO + GITHUB_DISPATCH_TOKEN are set,
// jobs run server-side on a GitHub runner (fire-and-forget, up to 6h) instead of
// inside this serverless request. Without these, the in-request fallback runs.
const GITHUB_REPO = (process.env.GITHUB_REPO || '').trim()
const GITHUB_TOKEN = (process.env.GITHUB_DISPATCH_TOKEN || '').trim()
const GITHUB_WORKFLOW = (process.env.GITHUB_WORKFLOW_FILE || 'owner-tool.yml').trim()
const GITHUB_REF = (process.env.GITHUB_REF || 'main').trim()
const DISPATCH_MODE = Boolean(GITHUB_REPO && GITHUB_TOKEN)

const jobs = globalThis.__ownerToolJobs || new Map()
globalThis.__ownerToolJobs = jobs
globalThis.__ownerToolActiveA = globalThis.__ownerToolActiveA || ''
const folderCreateLocks = globalThis.__ownerToolFolderCreateLocks || new Map()
globalThis.__ownerToolFolderCreateLocks = folderCreateLocks

function json(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

function methodNotAllowed(res) {
  json(res, 405, { message: 'Method not allowed' })
}

function redirect(res, location) {
  res.statusCode = 302
  res.setHeader('Location', location)
  res.end()
}

// Send the OAuth popup/tab back to the SPA with a status the frontend can read.
function redirectToApp(res, query) {
  redirect(res, `/?${query}`)
}

function readCookie(req, name) {
  const raw = req.headers.cookie || ''
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('=') || '')
  }
  return ''
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`]
  parts.push('Path=/')
  parts.push('HttpOnly')
  parts.push('SameSite=Lax')
  if (process.env.NODE_ENV === 'production') parts.push('Secure')
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`)
  return parts.join('; ')
}

function base64url(input) {
  return Buffer.from(input).toString('base64url')
}

function sign(value) {
  const secret = process.env.OWNER_TOOL_AUTH_SECRET
  if (!secret) throw new Error('OWNER_TOOL_AUTH_SECRET is missing')
  return crypto.createHmac('sha256', secret).update(value).digest('base64url')
}

function createSession(email) {
  const payload = base64url(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS }))
  return `${payload}.${sign(payload)}`
}

function verifySession(req) {
  try {
    const token = readCookie(req, SESSION_COOKIE)
    if (!token || !token.includes('.')) return null
    const [payload, signature] = token.split('.', 2)
    const expected = sign(payload)
    const actualBuffer = Buffer.from(signature)
    const expectedBuffer = Buffer.from(expected)
    if (actualBuffer.length !== expectedBuffer.length) return null
    if (!crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!data?.email || data.exp < Math.floor(Date.now() / 1000)) return null
    if (String(data.email).toLowerCase() !== ALLOWED_EMAIL) return null
    return { email: data.email }
  } catch {
    return null
  }
}

// Best-effort login throttle. Serverless instances aren't shared, so this only
// slows brute force within a warm instance — but for a single-user tool that's
// enough to blunt credential stuffing, and a successful login clears the counter
// so a legitimate user is never locked out.
const LOGIN_MAX_ATTEMPTS = 5
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const loginAttempts = globalThis.__ownerToolLoginAttempts || new Map()
globalThis.__ownerToolLoginAttempts = loginAttempts

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
  return fwd || req.socket?.remoteAddress || 'unknown'
}

function loginThrottle(ip) {
  const now = Date.now()
  const entry = loginAttempts.get(ip)
  if (!entry) return { blocked: false }
  if (now - entry.first > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip)
    return { blocked: false }
  }
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    return { blocked: true, retryAfter: Math.ceil((LOGIN_WINDOW_MS - (now - entry.first)) / 1000) }
  }
  return { blocked: false }
}

function recordLoginFailure(ip) {
  const now = Date.now()
  const entry = loginAttempts.get(ip)
  if (!entry || now - entry.first > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, first: now })
  } else {
    entry.count += 1
  }
}

function timingSafeTextEqual(left, right) {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function verifyPassword(password) {
  const plain = process.env.OWNER_TOOL_PASSWORD
  const hash = process.env.OWNER_TOOL_PASSWORD_HASH
  if (plain) return timingSafeTextEqual(password, plain)
  if (hash) {
    const [algorithm, salt, key] = hash.split(':')
    if (algorithm !== 'scrypt' || !salt || !key) return false
    const derived = crypto.scryptSync(String(password), salt, key.length / 2).toString('hex')
    return timingSafeTextEqual(derived, key)
  }
  throw new Error('OWNER_TOOL_PASSWORD or OWNER_TOOL_PASSWORD_HASH is missing')
}

function readJsonEnv(...names) {
  for (const name of names) {
    const value = process.env[name]
    if (!value) continue
    const raw = value.trim()
    try {
      return JSON.parse(raw)
    } catch {
      try {
        return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
      } catch {
        throw new Error(`${name} is not valid JSON/base64 JSON`)
      }
    }
  }
  return null
}

function normalizeToken(raw) {
  if (!raw) return null
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch {
      return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
    }
  }
  if (raw.token_b64) return JSON.parse(Buffer.from(raw.token_b64, 'base64').toString('utf8'))
  if (raw.token_json) return typeof raw.token_json === 'string' ? JSON.parse(raw.token_json) : raw.token_json
  if (raw.token) return raw.token
  return raw
}

function loadRegistry(registryFile) {
  const full = path.join(ROOT, registryFile)
  if (!fs.existsSync(full)) return { accounts: [], active_email: '' }
  const data = JSON.parse(fs.readFileSync(full, 'utf8'))
  const accounts = []
  for (const item of data.accounts || []) {
    if (!item.email || !item.token_path || !fs.existsSync(item.token_path)) continue
    accounts.push({
      email: item.email,
      display_name: item.display_name || '',
      token: JSON.parse(fs.readFileSync(item.token_path, 'utf8')),
    })
  }
  return { accounts, active_email: data.active_email || '' }
}

// Pull the live bundle from KV once per request and cache it on the instance so
// the otherwise-sync loadAccounts() can read it. Local/dev setups without KV
// still fall back to static env/local files below.
async function ensureStore() {
  const bundle = await readBundle()
  if (bundle === null) {
    globalThis.__ownerToolStoreLoaded = false
    return
  }
  globalThis.__ownerToolBundle = bundle
  globalThis.__ownerToolStoreLoaded = true
}

function loadAccounts() {
  // When KV is configured, it is the source of truth even if it is empty. This
  // avoids accidentally reviving stale token bundles from legacy env secrets.
  const bundled = globalThis.__ownerToolStoreLoaded
    ? globalThis.__ownerToolBundle
    : readJsonEnv('OWNER_TOOL_ACCOUNTS_JSON', 'OWNER_TOOL_ACCOUNTS_JSON_B64')
  let activeA = ''
  let accountsA = []
  let accountsB = []

  if (bundled) {
    activeA = bundled.active_a || bundled.active_email || ''
    accountsA = bundled.A || bundled.accountsA || bundled.account_a || []
    accountsB = bundled.B || bundled.accountsB || bundled.account_b || []
  } else {
    const envA = readJsonEnv('OWNER_TOOL_ACCOUNT_A_JSON', 'OWNER_TOOL_ACCOUNT_A_JSON_B64')
    const envB = readJsonEnv('OWNER_TOOL_ACCOUNT_B_JSON', 'OWNER_TOOL_ACCOUNT_B_JSON_B64')
    if (envA || envB) {
      accountsA = Array.isArray(envA) ? envA : (envA?.accounts || envA?.A || [])
      accountsB = Array.isArray(envB) ? envB : (envB?.accounts || envB?.B || [])
      activeA = envA?.active_email || envA?.active_a || ''
    } else {
      const localA = loadRegistry('account_a_accounts.json')
      const localB = loadRegistry('account_b_accounts.json')
      accountsA = localA.accounts
      accountsB = localB.accounts
      activeA = localA.active_email
    }
  }

  const normalize = (items, role) => (items || [])
    .map(item => ({
      role,
      email: String(item.email || '').trim(),
      display_name: item.display_name || item.displayName || '',
      token: normalizeToken(item),
    }))
    .filter(item => item.email && item.token)

  const A = normalize(accountsA, 'A')
  const B = normalize(accountsB, 'B')
  if (!activeA && A.length) activeA = A[0].email
  if (globalThis.__ownerToolActiveA) activeA = globalThis.__ownerToolActiveA
  return { A, B, activeA }
}

function publicAccount(account, active = false) {
  return { role: account.role, email: account.email, display_name: account.display_name || '', active }
}

function findAccount(role, email) {
  const accounts = loadAccounts()
  return (role === 'A' ? accounts.A : accounts.B).find(item => item.email.toLowerCase() === String(email).toLowerCase())
}

function driveFromToken(token) {
  const clientId = token.client_id || token.clientId
  const clientSecret = token.client_secret || token.clientSecret
  const redirectUri = 'urn:ietf:wg:oauth:2.0:oob'
  const auth = new google.auth.OAuth2(clientId, clientSecret, redirectUri)
  auth.setCredentials({
    access_token: token.access_token || token.token,
    refresh_token: token.refresh_token,
    token_type: token.token_type || 'Bearer',
    scope: Array.isArray(token.scopes) ? token.scopes.join(' ') : token.scope,
    expiry_date: token.expiry_date || (token.expiry ? Date.parse(token.expiry) : undefined),
  })
  return google.drive({ version: 'v3', auth })
}

function extractFolderId(value) {
  const text = String(value || '').trim()
  if (!text) throw new Error('Folder URL/ID cannot be blank')
  const patterns = [
    /\/folders\/([a-zA-Z0-9_-]+)/,
    /[?&]id=([a-zA-Z0-9_-]+)/,
    /\/d\/([a-zA-Z0-9_-]+)/,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) return match[1]
  }
  if (/^[a-zA-Z0-9_-]{10,}$/.test(text)) return text
  throw new Error(`Không nhận diện được Drive ID: ${text}`)
}

async function getFile(drive, fileId) {
  const { data } = await drive.files.get({
    fileId,
    fields: 'id,name,mimeType,owners(emailAddress),ownedByMe,copyRequiresWriterPermission,capabilities(canCopy)',
    supportsAllDrives: true,
  })
  return {
    id: data.id,
    name: data.name || data.id,
    mimeType: data.mimeType || '',
    owners: data.owners || [],
    ownedByMe: typeof data.ownedByMe === 'boolean' ? data.ownedByMe : undefined,
    canCopy: data.capabilities?.canCopy !== false,
  }
}

async function listChildren(drive, folderId) {
  const items = []
  let pageToken
  do {
    const { data } = await drive.files.list({
      q: `'${driveQueryText(folderId)}' in parents and trashed = false`,
      fields: 'nextPageToken,files(id,name,mimeType,owners(emailAddress),ownedByMe,capabilities(canCopy))',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })
    items.push(...(data.files || []))
    pageToken = data.nextPageToken
  } while (pageToken)
  return items.map(item => ({
    id: item.id,
    name: item.name || item.id,
    mimeType: item.mimeType || '',
    owners: item.owners || [],
    ownedByMe: typeof item.ownedByMe === 'boolean' ? item.ownedByMe : undefined,
    canCopy: item.capabilities?.canCopy !== false,
  }))
}

function driveQueryText(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function normalizeDriveName(name) {
  return String(name || '')
    .normalize('NFKC')
    .replace(/[\u00a0\u200b\u200c\u200d\ufeff]/g, char => (char === '\u00a0' ? ' ' : ''))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function looseDriveFolderName(name) {
  return normalizeDriveName(name)
    .replace(/[_|\u00a6\u2016\uff5c\-\u2010\u2011\u2012\u2013\u2014\u2015]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function findMatchingChild(items, name, mimeType = '') {
  let normalizedMatch = null
  let looseMatch = null
  let looseAmbiguous = false
  const normalizedName = normalizeDriveName(name)
  const looseName = mimeType === FOLDER_MIME ? looseDriveFolderName(name) : ''

  for (const item of items) {
    if (mimeType && item.mimeType !== mimeType) continue
    const itemName = String(item.name || '')
    if (itemName === name) return item
    if (!normalizedMatch && normalizeDriveName(itemName) === normalizedName) normalizedMatch = item
    if (looseName && looseDriveFolderName(itemName) === looseName) {
      if (!looseMatch) looseMatch = item
      else if (looseMatch.id !== item.id) looseAmbiguous = true
    }
  }

  if (normalizedMatch) return normalizedMatch
  if (looseAmbiguous) return null
  return looseMatch
}

async function withFolderCreateLock(parentId, name, fn) {
  const key = `${parentId}\0${looseDriveFolderName(name)}`
  const previous = folderCreateLocks.get(key) || Promise.resolve()
  let release
  const current = new Promise(resolve => { release = resolve })
  folderCreateLocks.set(key, current)
  await previous.catch(() => {})
  try {
    return await fn()
  } finally {
    release()
    if (folderCreateLocks.get(key) === current) folderCreateLocks.delete(key)
  }
}

function normalizeExtensions(items, fallback) {
  const input = Array.isArray(items) ? items : String(items || '').split(/[\s,;]+/)
  const out = input
    .map(item => String(item || '').trim().toLowerCase())
    .filter(Boolean)
    .map(item => (item.startsWith('.') ? item : `.${item}`))
  return out.length ? out : fallback
}

function copyFilterAccept(item, mode, fileExtensions, videoExtensions) {
  if (item.mimeType === FOLDER_MIME || item.mimeType === SHORTCUT_MIME) return false
  if (mode === 'all') return true
  const name = String(item.name || '').toLowerCase()
  const isVideoMime = String(item.mimeType || '').startsWith(VIDEO_PREFIX)
  const isGoogleDoc = String(item.mimeType || '').startsWith('application/vnd.google-apps.')
  if (mode === 'videos') return isVideoMime || videoExtensions.some(ext => name.endsWith(ext))
  if (mode === 'files') return !isVideoMime && (isGoogleDoc || fileExtensions.some(ext => name.endsWith(ext)))
  if (mode === 'custom') return [...fileExtensions, ...videoExtensions].some(ext => name.endsWith(ext))
  return true
}

async function findExistingChild(drive, parentId, name, mimeType = '') {
  let q = `'${driveQueryText(parentId)}' in parents and name='${driveQueryText(name)}' and trashed = false`
  if (mimeType) q += ` and mimeType='${driveQueryText(mimeType)}'`
  const { data } = await drive.files.list({
    q,
    fields: 'files(id,name,mimeType)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })
  if (data.files?.[0]?.id) return data.files[0].id

  const match = findMatchingChild(await listChildren(drive, parentId), name, mimeType)
  return match?.id || ''
}

async function ensureCopyFolder(drive, parentId, name, logs, dryRun) {
  return withFolderCreateLock(parentId, name, async () => {
    const existing = await findExistingChild(drive, parentId, name, FOLDER_MIME)
    if (existing) {
      logs.push(`[skip] folder exists ${name}`)
      return existing
    }
    if (dryRun) {
      logs.push(`[DRY]  folder ${name}`)
      return parentId
    }
    const { data } = await drive.files.create({
      requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId] },
      fields: 'id',
      supportsAllDrives: true,
    })
    logs.push(`[OK]   folder ${name}`)
    return data.id
  })
}

async function copyDriveFile(drive, item, destId, copiedIds, logs, dryRun) {
  if (copiedIds.has(item.id)) {
    logs.push(`[skip] checkpoint ${item.name}`)
    return ''
  }
  if (dryRun) {
    logs.push(`[DRY]  copy ${item.name}`)
    return `dry-file:${item.id}`
  }
  const existing = await findExistingChild(drive, destId, item.name)
  if (existing) {
    copiedIds.add(item.id)
    logs.push(`[skip] exists ${item.name}`)
    return existing
  }
  const { data } = await drive.files.copy({
    fileId: item.id,
    requestBody: { name: item.name, parents: [destId] },
    fields: 'id',
    supportsAllDrives: true,
  })
  copiedIds.add(item.id)
  logs.push(`[OK]   file ${item.name}`)
  return data.id
}

function ownerEmails(item) {
  return (item.owners || [])
    .map(owner => String(owner.emailAddress || '').trim())
    .filter(Boolean)
}

function ownerSkipReason(item, expectedOwnerEmail, alreadyOwnerEmail) {
  const expected = String(expectedOwnerEmail || '').trim().toLowerCase()
  if (!expected) return ''
  const owners = ownerEmails(item)
  if (!owners.length) return ''
  const lowered = owners.map(email => email.toLowerCase())
  if (lowered.includes(expected)) return ''
  const alreadyOwner = String(alreadyOwnerEmail || '').trim().toLowerCase()
  if (alreadyOwner && lowered.includes(alreadyOwner)) return `already owned by target ${alreadyOwnerEmail}`
  return `owner is ${owners.join(', ')}; expected ${expectedOwnerEmail}`
}

function isVideo(item) {
  return String(item.mimeType || '').startsWith(VIDEO_PREFIX)
}

function isBlockableFile(item) {
  const mime = String(item.mimeType || '')
  return mime !== FOLDER_MIME && mime !== SHORTCUT_MIME
}

function clampWorkers(value, fallback = 4) {
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.min(n, 16))
}

// Run `worker(item)` over items with at most `limit` in flight at once. Order of
// completion is irrelevant (each item is independent), so this is a plain
// bounded pool — much faster than the old sequential loop within the serverless
// time budget. The googleapis client is async/await safe to share concurrently.
async function runPool(items, limit, worker) {
  const queue = items.slice()
  const size = Math.max(1, Math.min(limit, queue.length || 1))
  const runners = Array.from({ length: size }, async () => {
    while (queue.length) {
      const item = queue.shift()
      await worker(item)
    }
  })
  await Promise.all(runners)
}

async function verifyOwner(drive, fileId, email) {
  const permission = await findPermission(drive, fileId, email)
  return Boolean(permission && permission.role === 'owner' && !permission.pendingOwner)
}

async function collectVideos(drive, folderIds, recursive, logs, accept = isVideo) {
  const matches = []
  const seen = new Set()
  const visitedFolders = new Set()
  for (const folderId of folderIds) {
    const root = await getFile(drive, folderId)
    if (root.mimeType !== FOLDER_MIME) {
      if (accept(root) && !seen.has(root.id)) {
        seen.add(root.id)
        matches.push(root)
      }
      continue
    }
    const queue = [root]
    while (queue.length) {
      const folder = queue.shift()
      if (visitedFolders.has(folder.id)) continue
      visitedFolders.add(folder.id)
      logs.push(`[scan] ${folder.name} — files=${matches.length}`)
      for (const child of await listChildren(drive, folder.id)) {
        if (child.mimeType === FOLDER_MIME) {
          if (recursive) queue.push(child)
          continue
        }
        if (child.mimeType === SHORTCUT_MIME) continue
        if (accept(child) && !seen.has(child.id)) {
          seen.add(child.id)
          matches.push(child)
        }
      }
    }
  }
  return matches
}

async function collectTransferItems(drive, folderIds, recursive, scope, logs) {
  const includeFiles = scope === 'videos' || scope === 'files' || scope === 'all'
  const includeFolders = scope === 'folders' || scope === 'all'
  const acceptFile = scope === 'videos' ? isVideo : isBlockableFile
  const files = []
  const folders = []
  const seenFiles = new Set()
  const seenFolders = new Set()
  for (const folderId of folderIds) {
    const root = await getFile(drive, folderId)
    if (root.mimeType !== FOLDER_MIME) {
      if (includeFiles && acceptFile(root) && !seenFiles.has(root.id)) {
        seenFiles.add(root.id)
        files.push(root)
      }
      continue
    }
    const queue = [{ item: root, depth: 0 }]
    while (queue.length) {
      const { item: folder, depth } = queue.shift()
      if (seenFolders.has(folder.id)) continue
      seenFolders.add(folder.id)
      if (includeFolders) folders.push({ depth, item: folder })
      logs.push(`[scan] ${folder.name} — files=${files.length} folders=${folders.length}`)
      for (const child of await listChildren(drive, folder.id)) {
        if (child.mimeType === FOLDER_MIME) {
          if (recursive) queue.push({ item: child, depth: depth + 1 })
          continue
        }
        if (child.mimeType === SHORTCUT_MIME) continue
        if (includeFiles && acceptFile(child) && !seenFiles.has(child.id)) {
          seenFiles.add(child.id)
          files.push(child)
        }
      }
    }
  }
  const folderItems = folders.sort((a, b) => b.depth - a.depth).map(entry => entry.item)
  if (scope === 'folders') return folderItems
  if (scope === 'all') return [...files, ...folderItems]
  return files
}

async function findPermission(drive, fileId, email) {
  let pageToken
  const target = String(email).toLowerCase()
  do {
    const { data } = await drive.permissions.list({
      fileId,
      fields: 'nextPageToken,permissions(id,emailAddress,type,role,pendingOwner)',
      pageSize: 100,
      pageToken,
      supportsAllDrives: true,
    })
    const found = (data.permissions || []).find(p => String(p.emailAddress || '').toLowerCase() === target)
    if (found) return found
    pageToken = data.nextPageToken
  } while (pageToken)
  return null
}

async function transferWorkspace(drive, fileId, email, notify) {
  const existing = await findPermission(drive, fileId, email)
  if (existing?.role === 'owner' && !existing.pendingOwner) return existing.id
  if (existing) {
    await drive.permissions.update({
      fileId,
      permissionId: existing.id,
      requestBody: { role: 'owner' },
      transferOwnership: true,
      sendNotificationEmail: notify,
      fields: 'id,emailAddress,role',
      supportsAllDrives: true,
    })
    return existing.id
  }
  const { data } = await drive.permissions.create({
    fileId,
    requestBody: { type: 'user', role: 'owner', emailAddress: email },
    transferOwnership: true,
    sendNotificationEmail: notify,
    fields: 'id,emailAddress,role',
    supportsAllDrives: true,
  })
  return data.id
}

async function transferConsumer(ownerDrive, acceptDrive, item, email, notify) {
  const existing = await findPermission(ownerDrive, item.id, email)
  if (existing?.role === 'owner' && !existing.pendingOwner) return existing.id
  let permissionId
  if (existing) {
    permissionId = existing.id
    await ownerDrive.permissions.update({
      fileId: item.id,
      permissionId,
      requestBody: { role: 'writer', pendingOwner: true },
      fields: 'id,emailAddress,role,pendingOwner',
      supportsAllDrives: true,
    })
  } else {
    const { data } = await ownerDrive.permissions.create({
      fileId: item.id,
      requestBody: { type: 'user', role: 'writer', emailAddress: email, pendingOwner: true },
      sendNotificationEmail: true,
      fields: 'id,emailAddress,role,pendingOwner',
      supportsAllDrives: true,
    })
    permissionId = data.id
  }
  if (!acceptDrive) return permissionId
  try {
    await acceptDrive.permissions.update({
      fileId: item.id,
      permissionId,
      requestBody: { role: 'owner' },
      transferOwnership: true,
      fields: 'id,emailAddress,role',
      supportsAllDrives: true,
    })
  } catch (error) {
    if (error?.code !== 404) throw error
    await acceptDrive.permissions.create({
      fileId: item.id,
      requestBody: { type: 'user', role: 'owner', emailAddress: email },
      transferOwnership: true,
      sendNotificationEmail: notify,
      fields: 'id,emailAddress,role',
      supportsAllDrives: true,
    })
  }
  return permissionId
}

async function setCopyRestriction(drive, fileId, restricted) {
  const { data } = await drive.files.update({
    fileId,
    requestBody: {
      downloadRestrictions: {
        itemDownloadRestriction: {
          restrictedForReaders: restricted,
          restrictedForWriters: restricted,
        },
      },
    },
    fields: 'id,copyRequiresWriterPermission,downloadRestrictions',
    supportsAllDrives: true,
  })
  const restrictions = data.downloadRestrictions || {}
  const effective = restrictions.effectiveDownloadRestrictionWithContext || {}
  const item = restrictions.itemDownloadRestriction || {}
  const readerRestricted = Boolean(effective.restrictedForReaders ?? item.restrictedForReaders)
  const writerRestricted = Boolean(effective.restrictedForWriters ?? item.restrictedForWriters)
  if (readerRestricted !== restricted || writerRestricted !== restricted) {
    throw new Error(`Drive did not apply restricted=${restricted} for readers and writers`)
  }
}

function isGoogleSheet(item) {
  return String(item.mimeType || '') === GOOGLE_SHEETS_MIME
}

function newJob(type, logs, status = 'completed', returnCode = 0) {
  const id = crypto.randomUUID()
  const job = {
    id,
    job_id: id,
    type,
    status,
    created_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    return_code: returnCode,
    logs,
    next_log_offset: logs.length,
    progress: status === 'completed' ? 100 : 0,
  }
  jobs.set(id, job)
  return job
}

async function githubFetch(pathStr, init = {}) {
  return fetch(`https://api.github.com${pathStr}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'owner-video-tool',
      ...(init.headers || {}),
    },
  })
}

function buildTransferPayload(body) {
  const accounts = loadAccounts()
  const owner = accounts.A.find(item => item.email.toLowerCase() === String(body.owner_email || '').toLowerCase())
  if (!owner) throw Object.assign(new Error('Account A chưa đăng ký'), { status: 400 })
  const rows = Array.isArray(body.rows) ? body.rows : []
  if (!rows.length) throw Object.assign(new Error('Cần ít nhất một dòng transfer'), { status: 422 })
  const outRows = rows.map(row => {
    const receiver = accounts.B.find(item => item.email.toLowerCase() === String(row.receiver_email || '').toLowerCase())
    if (!receiver) throw Object.assign(new Error(`Account B chưa đăng ký: ${row.receiver_email}`), { status: 400 })
    const folders = (row.folders || []).map(extractFolderId)
    if (!folders.length) throw Object.assign(new Error(`Dòng nhận ${row.receiver_email} chưa có folder`), { status: 422 })
    return { receiver_email: receiver.email, folders }
  })
  return {
    owner_email: owner.email,
    mode: body.mode === 'workspace' ? 'workspace' : 'consumer',
    scope: ['videos', 'files', 'folders', 'all'].includes(body.scope) ? body.scope : 'videos',
    no_recursive: body.recursive === false,
    no_notify: Boolean(body.no_notify),
    dry_run: Boolean(body.dry_run),
    workers: clampWorkers(body.workers),
    verify: Boolean(body.verify),
    rows: outRows,
  }
}

function buildBlockPayload(body) {
  const owner = findAccount('A', body.owner_email)
  if (!owner) throw Object.assign(new Error('Account A chưa đăng ký'), { status: 400 })
  const folders = (body.folders || []).map(extractFolderId)
  if (!folders.length) throw Object.assign(new Error('Cần ít nhất một folder'), { status: 422 })
  return {
    owner_email: owner.email,
    folders,
    recursive: body.recursive !== false,
    unblock: Boolean(body.unblock),
    target: ['videos', 'files', 'sheets'].includes(body.target)
      ? body.target
      : (body.unblock ? 'files' : 'videos'),
    dry_run: Boolean(body.dry_run),
    workers: clampWorkers(body.workers),
  }
}

function buildCopyDrivePayload(body) {
  const owner = findAccount('A', body.owner_email)
  if (!owner) throw Object.assign(new Error('Account A chưa đăng ký'), { status: 400 })
  const sources = (body.sources || []).map(extractFolderId)
  const dest = extractFolderId(body.dest || '')
  if (!sources.length) throw Object.assign(new Error('Cần ít nhất một link/id nguồn'), { status: 422 })
  return {
    owner_email: owner.email,
    sources: [...new Set(sources)],
    dest,
    recursive: body.recursive !== false,
    checkpoint: body.checkpoint !== false,
    dry_run: Boolean(body.dry_run),
    workers: clampWorkers(body.workers, 10),
    exclude: String(body.exclude || ''),
    sort: body.sort === 'stt' ? 'stt' : 'name',
    filter_mode: ['all', 'files', 'videos', 'custom'].includes(body.filter_mode) ? body.filter_mode : 'all',
    file_extensions: normalizeExtensions(body.file_extensions, DEFAULT_FILE_EXTENSIONS),
    video_extensions: normalizeExtensions(body.video_extensions, DEFAULT_VIDEO_EXTENSIONS),
  }
}

async function dispatchJob(kind, payload) {
  const jobId = crypto.randomUUID()
  const inputs = { kind, job_id: jobId, payload: JSON.stringify(payload) }
  const res = await githubFetch(`/repos/${GITHUB_REPO}/actions/workflows/${encodeURIComponent(GITHUB_WORKFLOW)}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref: GITHUB_REF, inputs }),
  })
  if (res.status !== 204) {
    const text = await res.text().catch(() => '')
    throw Object.assign(new Error(`GitHub dispatch lỗi (${res.status}): ${text || 'unknown'}`), { status: 502 })
  }
  return {
    id: jobId,
    job_id: jobId,
    type: kind,
    status: 'queued',
    runner: 'github',
    created_at: new Date().toISOString(),
    progress: 5,
    logs: ['Đã gửi job sang GitHub Actions. Runner đang khởi động (~20–40s)…'],
  }
}

function mapRunStatus(run) {
  if (run.status !== 'completed') return run.status === 'in_progress' ? 'running' : 'queued'
  if (run.conclusion === 'success') return 'completed'
  if (run.conclusion === 'cancelled') return 'stopped'
  return 'failed'
}

async function findRun(jobId) {
  const res = await githubFetch(`/repos/${GITHUB_REPO}/actions/runs?event=workflow_dispatch&per_page=40`)
  if (!res.ok) return null
  const data = await res.json().catch(() => ({}))
  const runs = data.workflow_runs || []
  return runs.find(run => `${run.name || ''} ${run.display_title || ''}`.includes(jobId)) || null
}

// Cache parsed run logs briefly so 1.5s frontend polling doesn't hammer the
// GitHub API or re-download the full job log on every tick.
const LOG_CACHE_TTL_MS = 5000
const logCache = globalThis.__ownerToolLogCache || new Map()
globalThis.__ownerToolLogCache = logCache

// Only these lines carry signal for the operator (per-item results, scan
// progress, summaries, errors). Everything else (pip install, checkout, cache…)
// is GitHub Actions setup noise and gets dropped.
const LOG_KEEP = /^\[(OK|ERR|DRY|WARN|AUTH ERR|scan|skip|checkpoint|report)\]|^\$ |^Done\.|^Resolved |^Found |^Copy Drive|^Hoàn tất|^Owner Video Tool|transferred=|blocked=|unblocked=|failed=|Transfer .*->|->|^BLOCK |^UNBLOCK |Traceback|Exception/

function cleanLogLine(line) {
  let text = line.replace(/\r$/, '')
  // Strip GitHub's leading ISO timestamp: 2024-06-29T12:00:00.1234567Z
  text = text.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, '')
  // Normalize GitHub workflow command markers (##[group], ##[error]…)
  const marker = text.match(/^##\[(group|endgroup|command|error|warning|notice|debug|section)\](.*)$/)
  if (marker) {
    const [, kind, rest] = marker
    if (kind === 'endgroup' || kind === 'debug') return null
    if (kind === 'error') return `[ERR]  ${rest.trim()}`
    if (kind === 'warning') return `[WARN] ${rest.trim()}`
    return rest.trim() || null
  }
  return text
}

function extractRelevantLogs(text) {
  const out = []
  for (const raw of text.split('\n')) {
    const line = cleanLogLine(raw)
    if (line === null) continue
    const trimmed = line.trim()
    if (!trimmed) continue
    if (LOG_KEEP.test(trimmed)) out.push(trimmed)
  }
  return out.slice(-400)
}

// Fetch and parse the actual runner logs for a finished/running job. Uses the
// per-job logs endpoint, which returns plain text (not a zip) so we can stream
// the [OK]/[ERR]/… lines straight into the web log panel.
async function githubRunLogs(runId, useCache = true) {
  const cached = logCache.get(runId)
  if (useCache && cached && Date.now() - cached.at < LOG_CACHE_TTL_MS) return cached.lines
  try {
    const jobsRes = await githubFetch(`/repos/${GITHUB_REPO}/actions/runs/${runId}/jobs`)
    if (!jobsRes.ok) return cached?.lines || []
    const jobsData = await jobsRes.json().catch(() => ({}))
    const lines = []
    for (const ghJob of jobsData.jobs || []) {
      const logRes = await githubFetch(`/repos/${GITHUB_REPO}/actions/jobs/${ghJob.id}/logs`)
      if (!logRes.ok) continue
      const text = await logRes.text().catch(() => '')
      if (text) lines.push(...extractRelevantLogs(text))
    }
    const result = lines.slice(-400)
    logCache.set(runId, { at: Date.now(), lines: result })
    return result
  } catch {
    return cached?.lines || []
  }
}

async function githubJobStatus(jobId) {
  const run = await findRun(jobId)
  if (!run) {
    return { id: jobId, job_id: jobId, status: 'queued', runner: 'github', progress: 5, logs: ['Đang chờ GitHub Actions nhận job…'] }
  }
  const status = mapRunStatus(run)
  const kindMatch = String(run.name || '').match(/owner-tool\s+(\w+)/)
  const progress = status === 'completed' ? 100 : status === 'running' ? 50 : status === 'queued' ? 10 : 100
  // Force a fresh log pull once the run is done so the final poll (after which
  // the frontend stops polling) always carries the complete [OK]/[ERR] output.
  const detail = await githubRunLogs(run.id, run.status !== 'completed')
  const header = [
    `GitHub Actions run #${run.run_number} · ${status}`,
    `Xem log trực tiếp tại: ${run.html_url}`,
  ]
  const logs = detail.length ? [...header, '──────── Log chi tiết ────────', ...detail] : header
  const errorLines = detail.filter(line => /^\[(ERR|AUTH ERR|WARN)\]/.test(line))
  const error = status === 'failed'
    ? (errorLines.slice(-12).join('\n') || 'Job thất bại trên GitHub Actions. Mở link bên dưới để xem log đầy đủ.')
    : undefined
  return {
    id: jobId,
    job_id: jobId,
    type: kindMatch ? kindMatch[1] : undefined,
    status,
    runner: 'github',
    run_id: run.id,
    run_url: run.html_url,
    created_at: run.created_at,
    finished_at: run.status === 'completed' ? run.updated_at : undefined,
    progress,
    return_code: status === 'completed' ? 0 : status === 'failed' ? 1 : undefined,
    logs,
    error,
  }
}

async function githubCancel(jobId) {
  const run = await findRun(jobId)
  if (!run) return { id: jobId, job_id: jobId, status: 'queued', runner: 'github' }
  if (run.status !== 'completed') {
    await githubFetch(`/repos/${GITHUB_REPO}/actions/runs/${run.id}/cancel`, { method: 'POST' }).catch(() => {})
  }
  return {
    id: jobId,
    job_id: jobId,
    status: 'stopped',
    runner: 'github',
    run_id: run.id,
    run_url: run.html_url,
    logs: ['Đã yêu cầu dừng job trên GitHub Actions.'],
  }
}

async function handleTransfer(body) {
  const logs = []
  const accounts = loadAccounts()
  const owner = accounts.A.find(item => item.email.toLowerCase() === String(body.owner_email || '').toLowerCase())
  if (!owner) throw Object.assign(new Error('Account A is not registered'), { status: 400 })
  const ownerDrive = driveFromToken(owner.token)
  const rows = Array.isArray(body.rows) ? body.rows : []
  if (!rows.length) throw Object.assign(new Error('Cần ít nhất một dòng transfer'), { status: 422 })
  const workers = clampWorkers(body.workers)
  const verify = Boolean(body.verify)
  let success = 0
  let skipped = 0
  let failed = 0
  for (const row of rows) {
    const receiver = accounts.B.find(item => item.email.toLowerCase() === String(row.receiver_email || '').toLowerCase())
    if (!receiver) throw Object.assign(new Error(`Account B is not registered: ${row.receiver_email}`), { status: 400 })
    const folderIds = (row.folders || []).map(extractFolderId)
    const acceptDrive = body.mode === 'consumer' && !body.dry_run ? driveFromToken(receiver.token) : null
    const items = await collectTransferItems(ownerDrive, folderIds, body.recursive !== false, body.scope || 'videos', logs)
    const fileCount = items.filter(item => item.mimeType !== FOLDER_MIME).length
    const folderCount = items.filter(item => item.mimeType === FOLDER_MIME).length
    logs.push(`Resolved ${folderIds.length} folder(s). Selected ${fileCount} file(s), ${folderCount} folder(s). scope=${body.scope || 'videos'} mode=${body.mode || 'consumer'} workers=${workers} verify=${verify} owner_filter=${owner.email} dry_run=${Boolean(body.dry_run)}`)
    await runPool(items, body.dry_run ? 1 : workers, async (item) => {
      const label = `${item.name} (${item.id})`
      const ownerReason = ownerSkipReason(item, owner.email, receiver.email)
      if (ownerReason) {
        skipped += 1
        logs.push(`[SKIP] ${label}: ${ownerReason}`)
        return
      }
      if (body.dry_run) {
        success += 1
        logs.push(`[DRY]  ${label}`)
        return
      }
      try {
        if (body.mode === 'workspace') await transferWorkspace(ownerDrive, item.id, receiver.email, !body.no_notify)
        else await transferConsumer(ownerDrive, acceptDrive, item, receiver.email, !body.no_notify)
        if (verify) {
          const checkDrive = acceptDrive || ownerDrive
          if (!(await verifyOwner(checkDrive, item.id, receiver.email))) {
            failed += 1
            logs.push(`[ERR]  ${label}: verify failed — ${receiver.email} is not the confirmed owner yet`)
            return
          }
        }
        success += 1
        logs.push(`[OK]   ${label}`)
      } catch (error) {
        failed += 1
        logs.push(`[ERR]  ${label}: ${error.message || error}`)
      }
    })
  }
  logs.push(`Done. transferred=${success}, skipped=${skipped}, failed=${failed}`)
  return newJob('transfer', logs, failed ? 'failed' : 'completed', failed ? 1 : 0)
}

async function handleBlock(body) {
  const logs = []
  const owner = findAccount('A', body.owner_email)
  if (!owner) throw Object.assign(new Error('Account A is not registered'), { status: 400 })
  const drive = driveFromToken(owner.token)
  const folderIds = (body.folders || []).map(extractFolderId)
  if (!folderIds.length) throw Object.assign(new Error('Cần ít nhất một folder'), { status: 422 })
  const workers = clampWorkers(body.workers)
  const restricted = !body.unblock
  const action = restricted ? 'BLOCK' : 'UNBLOCK'
  const target = ['videos', 'files', 'sheets'].includes(body.target) ? body.target : (restricted ? 'videos' : 'files')
  const accept = target === 'videos' ? isVideo : target === 'sheets' ? isGoogleSheet : isBlockableFile
  const targetLabel = target === 'videos' ? 'video(s)' : target === 'sheets' ? 'sheet(s)' : 'file(s)'
  const targets = await collectVideos(drive, folderIds, body.recursive !== false, logs, accept)
  logs.push(`Found ${targets.length} ${targetLabel} across ${folderIds.length} folder(s). target=${target} action=${action} workers=${workers} dry_run=${Boolean(body.dry_run)}`)
  let success = 0
  let failed = 0
  await runPool(targets, body.dry_run ? 1 : workers, async (item) => {
    const label = `${item.name} (${item.id})`
    if (body.dry_run) {
      success += 1
      logs.push(`[DRY]  ${action} ${label}`)
      return
    }
    try {
      await setCopyRestriction(drive, item.id, restricted)
      success += 1
      logs.push(`[OK]   ${action} ${label}`)
    } catch (error) {
      failed += 1
      logs.push(`[ERR]  ${label}: ${error.message || error}`)
    }
  })
  logs.push(`Done. ${action.toLowerCase()}ed=${success}, failed=${failed}`)
  return newJob(restricted ? 'block' : 'unblock', logs, failed ? 'failed' : 'completed', failed ? 1 : 0)
}

async function handleCopyDrive(body) {
  const payload = buildCopyDrivePayload(body)
  const logs = []
  const owner = findAccount('A', payload.owner_email)
  if (!owner) throw Object.assign(new Error('Account A is not registered'), { status: 400 })
  const drive = driveFromToken(owner.token)
  const dest = await getFile(drive, payload.dest)
  if (dest.mimeType !== FOLDER_MIME) throw Object.assign(new Error(`Drive đích không phải folder: ${payload.dest}`), { status: 422 })
  const copiedIds = new Set()
  const excluded = String(payload.exclude || '').split(/[,;\n]+/).map(x => x.trim().toLowerCase()).filter(Boolean)
  const filtered = item => copyFilterAccept(item, payload.filter_mode, payload.file_extensions, payload.video_extensions)
  const excludedByName = name => excluded.some(term => String(name || '').toLowerCase().includes(term))
  let copiedRoots = 0
  let blocked = 0
  let errors = 0

  if (payload.checkpoint) {
    logs.push('[WARN] Serverless fallback không lưu checkpoint. Bật GitHub Actions dispatch hoặc chạy local để dùng .clone_checkpoint.json.')
  }
  logs.push(`Copy Drive: account=${owner.email} sources=${payload.sources.length} dest=${dest.name} filter=${payload.filter_mode} dry_run=${payload.dry_run}`)

  async function copyTree(item, destId) {
    for (const child of await listChildren(drive, item.id)) {
      if (excludedByName(child.name)) {
        logs.push(`[skip] excluded ${child.name}`)
        continue
      }
      if (child.mimeType === FOLDER_MIME) {
        if (!payload.recursive) continue
        const nextDest = await ensureCopyFolder(drive, destId, child.name, logs, payload.dry_run)
        await copyTree(child, nextDest)
        continue
      }
      if (!filtered(child)) continue
      if (!child.canCopy) {
        blocked += 1
        logs.push(`[WARN] blocked/cannot copy ${child.name}`)
        continue
      }
      try {
        await copyDriveFile(drive, child, destId, copiedIds, logs, payload.dry_run)
      } catch (error) {
        errors += 1
        logs.push(`[ERR]  ${child.name}: ${error.message || error}`)
      }
    }
  }

  await runPool(payload.sources, payload.workers, async (sourceId) => {
    let item
    try {
      item = await getFile(drive, sourceId)
    } catch (error) {
      errors += 1
      logs.push(`[ERR]  ID ${sourceId}: ${error.message || error}`)
      return
    }
    logs.push(`[scan] ${item.name}`)
    if (excludedByName(item.name)) {
      logs.push(`[skip] excluded source ${item.name}`)
      return
    }
    try {
      if (item.mimeType === FOLDER_MIME) {
        const rootDest = await ensureCopyFolder(drive, payload.dest, item.name, logs, payload.dry_run)
        await copyTree(item, rootDest)
        copiedRoots += 1
        return
      }
      if (!filtered(item)) {
        logs.push(`[skip] filtered ${item.name}`)
        return
      }
      if (!item.canCopy) {
        blocked += 1
        logs.push(`[WARN] blocked/cannot copy ${item.name}`)
        return
      }
      const newId = await copyDriveFile(drive, item, payload.dest, copiedIds, logs, payload.dry_run)
      if (newId) copiedRoots += 1
    } catch (error) {
      errors += 1
      logs.push(`[ERR]  ${item.name}: ${error.message || error}`)
    }
  })

  logs.push(`Done. copied_roots=${copiedRoots} blocked=${blocked} errors=${errors}`)
  return newJob('copy-drive', logs, errors ? 'failed' : 'completed', errors ? 1 : 0)
}

async function getBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string' && req.body) return JSON.parse(req.body)
  return {}
}

export default async function handler(req, res) {
  try {
    const rawPath = (req.query && req.query.path) || []
    let parts = (Array.isArray(rawPath) ? rawPath : [rawPath]).filter(Boolean)
    // On Vercel the catch-all `path` param isn't always injected into req.query
    // (custom rewrites/functions config). Fall back to parsing req.url, which is
    // always the real request path, so route matching never silently fails.
    if (!parts.length) {
      const urlPath = String(req.url || '').split('?')[0]
      parts = urlPath.replace(/^\/+/, '').replace(/^api\/?/, '').split('/').filter(Boolean)
    }
    const route = `/${parts.join('/')}`

    if (route === '/health') return json(res, 200, { ok: true, service: 'owner-video-tool-node' })

    if (route === '/auth/session' && req.method === 'GET') {
      const user = verifySession(req)
      return json(res, 200, { authenticated: Boolean(user), user })
    }

    if (route === '/auth/login' && req.method === 'POST') {
      const ip = clientIp(req)
      const throttle = loginThrottle(ip)
      if (throttle.blocked) {
        res.setHeader('Retry-After', String(throttle.retryAfter))
        return json(res, 429, { message: `Quá nhiều lần đăng nhập sai. Thử lại sau ${Math.ceil(throttle.retryAfter / 60)} phút.` })
      }
      const body = await getBody(req)
      const email = String(body.email || ALLOWED_EMAIL).trim().toLowerCase()
      if (email !== ALLOWED_EMAIL || !verifyPassword(String(body.password || ''))) {
        recordLoginFailure(ip)
        return json(res, 401, { message: 'Email hoặc mật khẩu không đúng' })
      }
      loginAttempts.delete(ip)
      res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, createSession(email), { maxAge: SESSION_TTL_SECONDS }))
      return json(res, 200, { user: { email } })
    }

    if (route === '/auth/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAge: 0 }))
      return json(res, 200, { ok: true })
    }

    // Web OAuth: kick off Google login. Requires an app session (the user
    // clicked "Connect" from the UI, so the Lax cookie rides the top-level GET).
    if (route === '/oauth/start' && req.method === 'GET') {
      if (!verifySession(req)) return json(res, 401, { message: 'Vui lòng đăng nhập lại' })
      if (!oauthConfigured()) {
        return json(res, 501, { message: 'Chưa cấu hình GOOGLE_WEB_CLIENT_ID/SECRET trên Vercel.' })
      }
      const role = String(new URL(req.url, 'http://x').searchParams.get('role') || 'A').toUpperCase() === 'B' ? 'B' : 'A'
      return redirect(res, buildAuthUrl(callbackUrl(req), signState(role)))
    }

    // Web OAuth: Google redirects back here with ?code&state. State (signed,
    // role-bearing, time-limited) is the CSRF guard; the captured token is
    // merged into the encrypted KV bundle that Vercel + GitHub Actions read.
    if (route === '/oauth/callback' && req.method === 'GET') {
      const params = new URL(req.url, 'http://x').searchParams
      const oauthError = params.get('error')
      if (oauthError) return redirectToApp(res, `oauth=error&reason=${encodeURIComponent(oauthError)}`)
      const stateData = verifyState(params.get('state'))
      const code = params.get('code')
      if (!code || !stateData) return redirectToApp(res, 'oauth=error&reason=invalid_state')
      try {
        const account = await exchangeCode(callbackUrl(req), code)
        await ensureStore()
        const bundle = upsertAccount(globalThis.__ownerToolBundle || { version: 1, active_a: '', A: [], B: [] }, stateData.role, account)
        await writeBundle(bundle)
        globalThis.__ownerToolBundle = bundle
        return redirectToApp(res, `oauth=ok&role=${stateData.role}&email=${encodeURIComponent(account.email)}`)
      } catch (error) {
        return redirectToApp(res, `oauth=error&reason=${encodeURIComponent(error.message || 'unknown')}`)
      }
    }

    const user = verifySession(req)
    if (!user) return json(res, 401, { message: 'Vui lòng đăng nhập lại' })

    // All routes below read accounts; refresh the KV-backed bundle first.
    await ensureStore()

    if (route === '/accounts' && req.method === 'GET') {
      const accounts = loadAccounts()
      const publicA = accounts.A.map(item => publicAccount(item, item.email.toLowerCase() === accounts.activeA.toLowerCase()))
      const publicB = accounts.B.map(item => publicAccount(item))
      return json(res, 200, { A: publicA, B: publicB, active_a: accounts.activeA || null, accounts: [...publicA, ...publicB] })
    }

    if (route === '/accounts/oauth' && req.method === 'POST') {
      if (!oauthConfigured() || !storeConfigured()) {
        return json(res, 501, { message: 'Chưa cấu hình OAuth web + KV store. Xem docs/ADD_ACCOUNT_OAUTH.md.' })
      }
      const body = await getBody(req)
      const role = String(body.role || 'A').toUpperCase() === 'B' ? 'B' : 'A'
      // The browser navigates to this same-origin URL, which 302s to Google.
      return json(res, 200, { url: `/api/oauth/start?role=${role}`, redirect: true })
    }

    if (parts[0] === 'oauth' && parts[1] && req.method === 'GET') {
      // Legacy local poll endpoint (/oauth/{id}); the web flow no longer polls.
      return json(res, 404, { message: 'OAuth web không dùng polling — đợi cửa sổ Google đóng lại.' })
    }

    // Delete an account (A or B). Persisted to the shared KV store so the GitHub
    // Actions runner stops seeing it too. Requires KV — the static
    // env/local fallback bundle is read-only at runtime.
    if (parts[0] === 'accounts' && parts[1] && parts[2] && parts.length === 3 && req.method === 'DELETE') {
      const role = String(parts[1] || '').toUpperCase()
      const email = decodeURIComponent(parts[2] || '')
      if (role !== 'A' && role !== 'B') return json(res, 400, { message: 'Vai trò không hợp lệ (chỉ A hoặc B)' })
      const account = findAccount(role, email)
      if (!account) return json(res, 404, { message: `Account ${role} không tồn tại: ${email}` })
      if (!storeConfigured()) {
        return json(res, 501, { message: 'Xóa tài khoản cần KV store (đặt KV_REST_API_URL, KV_REST_API_TOKEN, OWNER_TOOL_STORE_KEY).' })
      }
      const bundle = removeAccount(globalThis.__ownerToolBundle || { version: 1, active_a: '', A: [], B: [] }, role, account.email)
      await writeBundle(bundle)
      globalThis.__ownerToolBundle = bundle
      if (role === 'A' && String(globalThis.__ownerToolActiveA || '').toLowerCase() === account.email.toLowerCase()) {
        globalThis.__ownerToolActiveA = bundle.active_a || ''
      }
      return json(res, 200, { ok: true, role, email: account.email, active_a: bundle.active_a || null })
    }

    if (parts[0] === 'accounts' && parts[3] === 'activate' && req.method === 'POST') {
      const role = String(parts[1] || '').toUpperCase()
      const email = decodeURIComponent(parts[2] || '')
      if (role !== 'A') return json(res, 400, { message: 'Only account A can be activated' })
      const account = findAccount('A', email)
      if (!account) return json(res, 404, { message: 'Account A not found' })
      globalThis.__ownerToolActiveA = account.email
      // Persist the active choice to KV so GitHub Actions sees it too.
      if (storeConfigured()) {
        const bundle = { ...(globalThis.__ownerToolBundle || { version: 1, A: [], B: [] }), active_a: account.email }
        await writeBundle(bundle)
        globalThis.__ownerToolBundle = bundle
      }
      return json(res, 200, publicAccount(account, true))
    }

    if (route === '/jobs/transfer' && req.method === 'POST') {
      const body = await getBody(req)
      if (DISPATCH_MODE) return json(res, 202, await dispatchJob('transfer', buildTransferPayload(body)))
      return json(res, 202, await handleTransfer(body))
    }

    if (route === '/jobs/block' && req.method === 'POST') {
      const body = await getBody(req)
      const payload = buildBlockPayload(body)
      if (DISPATCH_MODE) return json(res, 202, await dispatchJob(payload.unblock ? 'unblock' : 'block', payload))
      return json(res, 202, await handleBlock(payload))
    }

    if (route === '/jobs/copy-drive' && req.method === 'POST') {
      const body = await getBody(req)
      if (DISPATCH_MODE) return json(res, 202, await dispatchJob('copy-drive', buildCopyDrivePayload(body)))
      return json(res, 202, await handleCopyDrive(body))
    }

    if (parts[0] === 'jobs' && parts[1] && parts[2] === 'stop' && req.method === 'POST') {
      if (DISPATCH_MODE) return json(res, 200, await githubCancel(parts[1]))
      const job = jobs.get(parts[1])
      if (!job) return json(res, 404, { message: 'Job not found' })
      return json(res, 200, { ...job, status: job.status === 'running' ? 'stopped' : job.status })
    }

    if (parts[0] === 'jobs' && parts[1] && req.method === 'GET') {
      if (DISPATCH_MODE) return json(res, 200, await githubJobStatus(parts[1]))
      const job = jobs.get(parts[1])
      if (!job) return json(res, 404, { message: 'Job not found' })
      return json(res, 200, job)
    }

    return methodNotAllowed(res)
  } catch (error) {
    const status = error.status || error.code || 500
    return json(res, Number.isInteger(status) && status >= 400 && status < 600 ? status : 500, {
      message: error.message || 'Server error',
    })
  }
}
