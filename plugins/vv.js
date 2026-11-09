import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { downloadMediaMessage, normalizeMessageContent } from '@whiskeysockets/baileys'
import pino from 'pino'

const logger = pino({ level: 'silent' })
const MEDIA_TYPES = ['imageMessage', 'videoMessage', 'audioMessage']
const DIR = path.join(os.tmpdir(), 'raza-vv')
const MAX_ENTRIES = 100
const MAX_BYTES = 50 * 1024 * 1024
const TTL_MS = 12 * 60 * 60 * 1000

function toSmallCaps(text) {
  const map = {
    a: '\u1D00', b: '\u0299', c: '\u1D04', d: '\u1D05', e: '\u1D07',
    f: '\u0493', g: '\u0262', h: '\u029C', i: '\u026A', j: '\u1D0A',
    k: '\u1D0B', l: '\u029F', m: '\u1D0D', n: '\u0274', o: '\u1D0F',
    p: '\u1D18', q: '\u01EB', r: '\u0280', s: 's', t: '\u1D1B',
    u: '\u1D1C', v: '\u1D20', w: '\u1D21', x: 'x', y: '\u028F',
    z: '\u1D22'
  }
  return String(text || '').toLowerCase().split('').map((c) => map[c] || c).join('')
}

// ---------- store (survives plugin reloads) ----------
if (!globalThis.__vvStore) {
  try { fs.rmSync(DIR, { recursive: true, force: true }) } catch { /* ignore */ }
  globalThis.__vvStore = new Map()
  globalThis.__vvPending = new Set()
}
fs.mkdirSync(DIR, { recursive: true })
const store = globalThis.__vvStore
const pending = globalThis.__vvPending

function removeEntry(id) {
  const e = store.get(id)
  if (e) fs.promises.unlink(e.file).catch(() => {})
  store.delete(id)
}

function getEntry(id) {
  const e = store.get(id)
  if (!e) return null
  if (Date.now() - e.time > TTL_MS || !fs.existsSync(e.file)) { removeEntry(id); return null }
  return e
}

function findViewOnce(message) {
  if (!message) return null
  const raw = message.ephemeralMessage?.message || message
  const wrapped = raw.viewOnceMessage || raw.viewOnceMessageV2 || raw.viewOnceMessageV2Extension
  const inner = normalizeMessageContent(message)
  const type = Object.keys(inner || {}).find((k) => MEDIA_TYPES.includes(k))
  if (!type) return null
  if (wrapped || inner[type]?.viewOnce) return { inner, type }
  return null
}

// ---------- capture: runs for every incoming message ----------
async function captureOne(m) {
  const id = m?.key?.id
  if (!id || store.has(id) || pending.has(id)) return
  const found = findViewOnce(m.message)
  if (!found) return

  pending.add(id)
  try {
    const buffer = await downloadMediaMessage({ key: m.key, message: found.inner }, 'buffer', {}, { logger })
    if (!buffer?.length) throw new Error('empty buffer')
    if (buffer.length > MAX_BYTES) throw new Error('file too large to cache')

    const node = found.inner[found.type]
    const file = path.join(DIR, id.replace(/[^\w-]/g, '_'))
    await fs.promises.writeFile(file, buffer)
    store.set(id, {
      file,
      type: found.type,
      mimetype: node?.mimetype || '',
      caption: node?.caption || '',
      ptt: Boolean(node?.ptt),
      time: Date.now(),
    })
    while (store.size > MAX_ENTRIES) removeEntry(store.keys().next().value)
    console.log(`[VIEWONCE] captured ${found.type} (${(buffer.length / 1024).toFixed(0)} KB) id=${id}`)
  } catch (err) {
    console.error(`[VIEWONCE] capture failed for ${id}:`, err.message,
      '(if this says "media key", WhatsApp did not send the media to this bot)')
  } finally {
    pending.delete(id)
  }
}

globalThis.__vvCapture = (upsert) => {
  for (const m of upsert?.messages || []) captureOne(m).catch(() => {})
}

// Automatic hook: Baileys sends every event through EventEmitter 'event'.
// Patched once, so no changes to index.js are needed.
if (!EventEmitter.prototype.__vvPatched) {
  Object.defineProperty(EventEmitter.prototype, '__vvPatched', { value: true })
  const originalEmit = EventEmitter.prototype.emit
  EventEmitter.prototype.emit = function (event, ...args) {
    if (event === 'event') {
      const upsert = args[0]?.['messages.upsert']
      if (upsert) { try { globalThis.__vvCapture?.(upsert) } catch { /* never break the bot */ } }
    }
    return originalEmit.call(this, event, ...args)
  }
}

// Optional manual hook, only if you want to call it from index.js
export function captureViewOnce(sock, m) {
  return captureOne(m)
}

// Extra hook through the socket the first time .vv runs
const hooked = new WeakSet()
function hookSock(sock) {
  if (hooked.has(sock)) return
  hooked.add(sock)
  sock.ev.on('messages.upsert', (u) => globalThis.__vvCapture?.(u))
}

export default {
  command: ['vv'],
  category: 'tools',
  description: 'Retrieve and reveal view once media messages',

  async run({ sock, message }) {
    const jid = message.key.remoteJid
    const send = (text) => sock.sendMessage(jid, { text }, { quoted: message })
    hookSock(sock)

    const content = normalizeMessageContent(message.message)
    const ctxInfo = Object.values(content || {}).map((v) => v?.contextInfo).find(Boolean)
    const quotedMsg = ctxInfo?.quotedMessage
    if (!quotedMsg) return send(`⚠️ ${toSmallCaps('please reply to a view once message.')}`)

    let buffer = null
    let type = null
    let mimetype = ''
    let caption = ''
    let ptt = false

    // 1) Cached copy (saved when the message arrived)
    const entry = getEntry(ctxInfo.stanzaId)
    if (entry) {
      try {
        buffer = await fs.promises.readFile(entry.file)
        ;({ type, mimetype, caption, ptt } = entry)
      } catch (err) {
        console.error('[VIEWONCE] cache read failed:', err.message)
      }
    }

    // 2) Fallback: download from the quoted message
    if (!buffer) {
      const inner = normalizeMessageContent(quotedMsg)
      const qType = Object.keys(inner || {}).find((k) => MEDIA_TYPES.includes(k))
      if (!qType) return send(`❌ ${toSmallCaps('the quoted message is not a valid view once media.')}`)
      try {
        buffer = await downloadMediaMessage(
          {
            key: { remoteJid: jid, id: ctxInfo.stanzaId, participant: ctxInfo.participant, fromMe: false },
            message: inner,
          },
          'buffer',
          {},
          { logger, reuploadRequest: (m) => sock.updateMediaMessage(m) }
        )
        const node = inner[qType]
        type = qType
        mimetype = node?.mimetype || ''
        caption = node?.caption || ''
        ptt = Boolean(node?.ptt)
      } catch (err) {
        console.error('[VIEWONCE] quoted download failed:', err.message)
      }
    }

    if (!buffer?.length) {
      return send(`❌ ${toSmallCaps('this view once was not captured. it must arrive while the bot is online, and the bot must be in that chat. send a new one and try again.')}`)
    }

    try {
      const cap = caption || `🔓 *${toSmallCaps('view once revealed')}*`
      if (type === 'audioMessage') {
        return await sock.sendMessage(jid, { audio: buffer, ptt, mimetype: mimetype || 'audio/mp4' }, { quoted: message })
      }
      if (type === 'videoMessage') {
        return await sock.sendMessage(jid, { video: buffer, caption: cap, mimetype: mimetype || 'video/mp4' }, { quoted: message })
      }
      await sock.sendMessage(jid, { image: buffer, caption: cap }, { quoted: message })
    } catch (err) {
      console.error('[VIEWONCE] send failed:', err)
      await send(`❌ ${toSmallCaps('failed to send the media.')}`)
    }
  }
}
