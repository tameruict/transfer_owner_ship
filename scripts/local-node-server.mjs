import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import handler from '../api/index.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'web', 'dist')
const PORT = Number(process.env.PORT || process.env.OWNER_TOOL_PORT || 3000)
const HOST = process.env.OWNER_TOOL_HOST || '127.0.0.1'
const MAX_BODY_BYTES = 2 * 1024 * 1024

function loadEnvLocal() {
  const file = path.join(ROOT, '.env.local')
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    const key = trimmed.slice(0, index).trim()
    const value = trimmed.slice(index + 1).trim()
    if (!process.env[key]) process.env[key] = value
  }
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.html') return 'text/html; charset=utf-8'
  if (ext === '.js') return 'text/javascript; charset=utf-8'
  if (ext === '.css') return 'text/css; charset=utf-8'
  if (ext === '.svg') return 'image/svg+xml'
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.ico') return 'image/x-icon'
  return 'application/octet-stream'
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      throw Object.assign(new Error('Request body quá lớn'), { status: 413 })
    }
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return undefined
  const type = req.headers['content-type'] || ''
  if (type.includes('application/json')) return JSON.parse(raw)
  return raw
}

async function serveApi(req, res, url) {
  const apiReq = Object.assign(req, {
    query: { path: url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean) },
    body: await readBody(req),
  })
  if (process.env.OWNER_TOOL_DEBUG_AUTH === '1' && url.pathname === '/api/auth/login') {
    console.log(JSON.stringify({
      loginBodyType: typeof apiReq.body,
      loginBodyKeys: apiReq.body && typeof apiReq.body === 'object' ? Object.keys(apiReq.body) : [],
      passwordLength: typeof apiReq.body?.password === 'string' ? apiReq.body.password.length : null,
      envPasswordLength: typeof process.env.OWNER_TOOL_PASSWORD === 'string' ? process.env.OWNER_TOOL_PASSWORD.length : null,
      hasPasswordHash: Boolean(process.env.OWNER_TOOL_PASSWORD_HASH),
    }))
  }
  apiReq.cookies = {}
  res.status = code => {
    res.statusCode = code
    return res
  }
  const originalSetHeader = res.setHeader.bind(res)
  res.setHeader = (key, value) => {
    originalSetHeader(key, value)
    return res
  }
  await handler(apiReq, res)
}

function serveStatic(req, res, url) {
  const requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
  const candidate = path.resolve(DIST, `.${requested}`)
  const distRoot = path.resolve(DIST)
  const relative = path.relative(distRoot, candidate)
  const insideDist = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  const file = insideDist && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    ? candidate
    : path.join(DIST, 'index.html')
  if (!fs.existsSync(file)) {
    sendJson(res, 404, { message: 'web/dist chưa có. Chạy npm run build trước.' })
    return
  }
  res.writeHead(200, { 'Content-Type': contentType(file) })
  fs.createReadStream(file).pipe(res)
}

loadEnvLocal()

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`)
    if (url.pathname.startsWith('/api/')) {
      await serveApi(req, res, url)
      return
    }
    serveStatic(req, res, url)
  } catch (error) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500
    sendJson(res, status, { message: error.message || 'Local server error' })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`Owner Video Tool Node local: http://${HOST}:${PORT}`)
  console.log(`Auth password: ${process.env.OWNER_TOOL_PASSWORD || process.env.OWNER_TOOL_PASSWORD_HASH ? 'configured' : 'missing'}`)
})
