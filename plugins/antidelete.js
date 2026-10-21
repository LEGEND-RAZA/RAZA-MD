import { downloadMediaMessage, getContentType } from '@whiskeysockets/baileys'
import { getDb, saveDb } from '../database/index.js'
import pino from 'pino'

const SETTINGS_FILE = 'antidelete-settings.json'
const DEFAULT_SETTINGS = { enabled: true, targetJid: '' }

const CACHE_TTL_MIN = Number(process.env.ANTIDELETE_CACHE_TTL_MIN) || 30
const CACHE_TTL_MS = CACHE_TTL_MIN * 60 * 1000
const MAX_CACHE = Number(process.env.ANTIDELETE_MAX_CACHE) || 2000
const HARD_LIMIT = Number(process.env.ANTIDELETE_HARD_LIMIT) || MAX_CACHE * 2
const PRUNE_INTERVAL_MIN = Number(process.env.ANTIDELETE_PRUNE_MIN) || 3
const PRUNE_INTERVAL_MS = PRUNE_INTERVAL_MIN * 60 * 1000

const SKIP_TYPES = new Set(
  (process.env.ANTIDELETE_SKIP || '').split(',').map(s => s.trim()).filter(Boolean)
)

const PRE_DOWNLOAD = process.env.ANTIDELETE_PRE_DOWNLOAD === 'true'
const PRE_DOWNLOAD_MAX_BYTES = (Number(process.env.ANTIDELETE_PRE_MAX_MB) || 5) * 1024 * 1024

const logger = pino({ level: 'silent' })
const messageCache = new Map()
const processedRevokes = new Set()
const lidToPn = new Map()
const pnToLid = new Map()

let pruneIntervalStarted = false
let updateHandlerRegistered = false

/* ============ SETTINGS ============ */
async function loadSettings() {
  try {
    const saved = await getDb(SETTINGS_FILE, {})
    return { ...DEFAULT_SETTINGS, ...(saved && typeof saved === 'object' ? saved : {}) }
  } catch (e) {
    console.error('[ANTIDELETE] Settings load failed:', e?.message || e)
    return { ...DEFAULT_SETTINGS }
  }
}
async function saveSettings(s) {
  try { await saveDb(SETTINGS_FILE, s) } catch (e) {
    console.error('[ANTIDELETE] Settings save failed:', e?.message || e)
  }
}
function resolveTarget(settings, sock) {
  if (settings.targetJid) return settings.targetJid
  if (!sock?.user?.id) return null
  return sock.user.id.split(':')[0] + '@s.whatsapp.net'
}

/* ============ LID ↔ PN MAPPING ============ */
function rememberPair(primary, alternate) {
  if (!primary || !alternate) return
  const p = String(primary), a = String(alternate)
  if (p === a || !p.includes('@') || !a.includes('@')) return
  const pLid = p.endsWith('@lid'), aLid = a.endsWith('@lid')
  if (pLid === aLid) return
  if (pLid && !aLid) { lidToPn.set(p, a); pnToLid.set(a, p) }
  else { lidToPn.set(a, p); pnToLid.set(p, a) }
}
function rememberMessageIdentities(message) {
  const k = message?.key || {}
  rememberPair(k.participant, k.participantAlt)
  rememberPair(k.remoteJid, k.remoteJidAlt)
  if (message?.participant || message?.participantAlt) {
    rememberPair(message.participant, message.participantAlt)
  }
}
function pickPnJid(message) {
  const k = message?.key || {}, m = message || {}
  const candidates = [k.participant, k.participantAlt, k.remoteJidAlt, m.participant, m.participantAlt].filter(Boolean).map(String)
  for (const c of candidates) if (c.endsWith('@s.whatsapp.net')) return c
  for (const c of candidates) if (c.endsWith('@lid')) { const pn = lidToPn.get(c); if (pn) return pn }
  for (const c of candidates) if (!c.endsWith('@lid')) return c
  return candidates[0] || String(k.remoteJid || '')
}
function resolveJid(jid) {
  if (!jid) return ''
  const s = String(jid)
  if (!s.endsWith('@lid')) return s
  return lidToPn.get(s) || s
}
function displayNum(jid, fallback = 'unknown') {
  if (!jid) return fallback
  const s = String(jid), num = s.split('@')[0].split(':')[0]
  if (!num) return fallback
  if (s.endsWith('@lid') && !lidToPn.has(s)) return `${num} (LID)`
  return num
}
function normalizeBotJid(id) {
  if (!id) return ''
  const num = String(id).split('@')[0].split(':')[0]
  return num ? `${num}@s.whatsapp.net` : ''
}

/* ============ RECURSIVE UNWRAP ============ */
function unwrapContent(m) {
  if (!m || typeof m !== 'object') return m
  let cur = m
  for (let i = 0; i < 10; i++) {
    const next =
      cur.ephemeralMessage?.message ||
      cur.viewOnceMessage?.message ||
      cur.viewOnceMessageV2?.message ||
      cur.viewOnceMessageV2Extension?.message ||
      cur.documentWithCaptionMessage?.message ||
      cur.groupStatusMessageV2?.message ||
      cur.groupStatusMessage?.message
    if (!next || typeof next !== 'object') break
    cur = next
  }
  return cur
}

/* ============ MEDIA TYPE ============ */
const MEDIA_TYPES = new Set(['imageMessage','videoMessage','audioMessage','stickerMessage','documentMessage'])

function getMediaType(message) {
  const unwrapped = unwrapContent(message?.message)
  if (!unwrapped) return null
  const t = getContentType(unwrapped)
  return MEDIA_TYPES.has(t) ? t : null
}

/* ============ CACHE ============ */
function cloneForCache(message) {
  return {
    key: { ...message.key },
    message: { ...message.message },
    messageTimestamp: message.messageTimestamp,
    pushName: message.pushName,
    participant: message.participant,
    participantAlt: message.participantAlt
  }
}
function cacheMessage(message, preDownload) {
  const id = message?.key?.id
  if (!id) return
  if (message.key.remoteJid === 'status@broadcast') return
  rememberMessageIdentities(message)
  messageCache.set(id, {
    message: cloneForCache(message),
    ts: Date.now(),
    buffer: preDownload?.buffer || null,
    bufferType: preDownload?.type || null
  })
  if (messageCache.size > MAX_CACHE) {
    const evictCount = Math.max(1, Math.floor(MAX_CACHE * 0.1))
    const n = evictOldest(evictCount)
    if (n > 0) console.log(`[ANTIDELETE] auto-evicted ${n} oldest entries (size ${messageCache.size}/${MAX_CACHE})`)
  }
}
function getCachedEntry(key) {
  if (!key?.id) return null
  const entry = messageCache.get(key.id)
  if (!entry) return null
  if (Date.now() - entry.ts > CACHE_TTL_MS) { messageCache.delete(key.id); return null }
  return entry
}
function markProcessedRevoke(id) {
  if (!id) return false
  if (processedRevokes.has(id)) return true
  processedRevokes.add(id)
  if (processedRevokes.size > 1000) {
    const first = processedRevokes.values().next().value
    processedRevokes.delete(first)
  }
  return false
}
function evictOldest(count) {
  if (!messageCache.size || count <= 0) return 0
  const entries = [...messageCache.entries()].sort((a, b) => a[1].ts - b[1].ts)
  const target = Math.min(count, entries.length)
  for (let i = 0; i < target; i++) messageCache.delete(entries[i][0])
  return target
}
function pruneExpired() {
  const now = Date.now()
  let removed = 0
  for (const [id, entry] of messageCache) {
    if (now - entry.ts > CACHE_TTL_MS) { messageCache.delete(id); removed++ }
  }
  return removed
}
function runAutoClear() {
  const expired = pruneExpired()
  if (expired > 0) console.log(`[ANTIDELETE] pruned ${expired} expired entries (${messageCache.size} remain)`)
  if (messageCache.size > HARD_LIMIT) {
    const excess = messageCache.size - MAX_CACHE
    const n = evictOldest(excess)
    console.log(`[ANTIDELETE] hard-limit exceeded (${HARD_LIMIT}) — evicted ${n} oldest entries`)
  }
}
function startPruneInterval() {
  if (pruneIntervalStarted) return
  pruneIntervalStarted = true
  setInterval(runAutoClear, PRUNE_INTERVAL_MS).unref()
  console.log(`[ANTIDELETE] auto-clear: prune ${PRUNE_INTERVAL_MIN}m, ttl ${CACHE_TTL_MIN}m, max ${MAX_CACHE}, hard ${HARD_LIMIT}`)
}

/* ============ DOWNLOAD (unwrapped content) ============ */
async function downloadOnce(unwrapped, key) {
  const ctx = { logger, reconnectAttempts: 5, timeoutMs: 180000 }
  // Pass the unwrapped inner — avoids Baileys' one-level-only normalize
  return downloadMediaMessage({ message: unwrapped, key }, 'buffer', {}, ctx)
}
async function downloadWithRetry(unwrapped, key) {
  let lastErr
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const buffer = await downloadOnce(unwrapped, key)
      if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Empty media buffer')
      return buffer
    } catch (e) {
      lastErr = e
      console.error(`[ANTIDELETE] download attempt ${attempt} failed:`, e?.message || e)
      if (attempt < 2) await new Promise(r => setTimeout(r, 3000))
    }
  }
  throw lastErr
}

/* ============ FORWARD ============ */
async function forwardToTarget(sock, targetJid, entry, revokerJid) {
  const original = entry.message

  let senderJid = original.key?.fromMe ? normalizeBotJid(sock?.user?.id) : (pickPnJid(original) || original.key?.remoteJid || '')
  const senderNum = displayNum(senderJid)

  let revokerResolved = ''
  if (revokerJid) {
    const raw = String(revokerJid)
    const senderLid = String(original.key?.participant || '')
    revokerResolved = raw === senderLid ? pickPnJid(original) : resolveJid(raw)
  }
  const revokerNum = revokerResolved ? displayNum(revokerResolved) : senderNum

  const isGroup = String(original.key?.remoteJid || '').endsWith('@g.us')
  const groupJid = isGroup ? String(original.key.remoteJid) : null

  const header = [
    '🗑️ ᴀɴᴛɪ-ᴅᴇʟᴇᴛᴇ', '',
    `ꜱᴇɴᴅᴇʀ : ${senderNum}`,
    groupJid ? `ɢʀᴏᴜᴘ  : ${groupJid}` : null,
    `ᴅᴇʟᴇᴛᴇᴅ ʙʏ : ${revokerNum}`
  ].filter(Boolean).join('\n')

  // Unwrap fully — this is what fixes issue #1 (media URL missing)
  const inner = unwrapContent(original.message) || {}
  // getContentType skips senderKeyDistributionMessage — this fixes issue #2
  const type = getContentType(inner)

  if (!type) {
    console.log(`[ANTIDELETE] skip — no forwardable content (keys: ${Object.keys(inner).join(',') || 'empty'})`)
    return
  }

  if (SKIP_TYPES.has(type)) {
    try { await sock.sendMessage(targetJid, { text: `${header}\n\n[${type} — skipped by config]` }) } catch {}
    return
  }

  try {
    if (type === 'conversation' || type === 'extendedTextMessage') {
      const text = inner.conversation || inner.extendedTextMessage?.text || ''
      await sock.sendMessage(targetJid, { text: `${header}\n\n${text}` })
      console.log(`[ANTIDELETE] forwarded text from ${senderNum}`)
      return
    }

    let media = entry.buffer
    if (!media) media = await downloadWithRetry(inner, original.key)

    const sendOpts = {}
    if (type === 'imageMessage') {
      sendOpts.image = media; sendOpts.caption = header
    } else if (type === 'videoMessage') {
      sendOpts.video = media; sendOpts.caption = header
    } else if (type === 'audioMessage') {
      sendOpts.audio = media
      sendOpts.mimetype = inner.audioMessage?.mimetype || 'audio/ogg; codecs=opus'
      sendOpts.ptt = inner.audioMessage?.ptt === true
    } else if (type === 'stickerMessage') {
      sendOpts.sticker = media
    } else if (type === 'documentMessage') {
      sendOpts.document = media
      sendOpts.mimetype = inner.documentMessage?.mimetype || 'application/octet-stream'
      sendOpts.fileName = inner.documentMessage?.fileName || 'document'
      sendOpts.caption = header
    } else {
      await sock.sendMessage(targetJid, { text: `${header}\n\n[Unsupported: ${type}]` })
      return
    }

    await sock.sendMessage(targetJid, sendOpts)
    console.log(`[ANTIDELETE] forwarded ${type} from ${senderNum}${entry.buffer ? ' (pre-download)' : ''}`)
  } catch (e) {
    const reason = (e?.message || 'unknown error').slice(0, 90)
    console.error('[ANTIDELETE] Forward failed:', reason, {
      type, keys: Object.keys(inner),
      hasUrl: !!(inner?.[type]?.url || inner?.[type]?.directPath)
    })
    try {
      await sock.sendMessage(targetJid, { text: `${header}\n\n[Could not recover — ${reason}]` })
    } catch {}
  }
}

/* ============ SETUP HOOK ============ */
async function setup(sock) {
  if (!sock || updateHandlerRegistered) return
  updateHandlerRegistered = true
  console.log('[ANTIDELETE] messages.update handler registered')
  if (PRE_DOWNLOAD) console.log(`[ANTIDELETE] pre-download enabled (max ${PRE_DOWNLOAD_MAX_BYTES / 1024 / 1024} MB)`)

  startPruneInterval()

  sock.ev.on('messages.update', async updates => {
    try {
      const settings = await loadSettings()
      if (!settings.enabled) return
      const targetJid = resolveTarget(settings, sock)
      if (!targetJid) return

      for (const item of updates) {
        const { key, update } = item || {}
        if (update?.messageStubType !== 1) continue
        if (markProcessedRevoke(key?.id)) continue
        const entry = getCachedEntry(key)
        if (!entry) {
          console.log(`[ANTIDELETE] ✗ not in cache (${key?.id?.slice(0, 8)}…) [messages.update]`)
          continue
        }
        const revoker = update?.messageStubParameters?.[0] || key?.participant || key?.remoteJid
        await forwardToTarget(sock, targetJid, entry, revoker)
        console.log(`[ANTIDELETE] ✓ recovered (${key?.id?.slice(0, 8)}…) [messages.update]`)
      }
    } catch (e) {
      console.error('[ANTIDELETE] messages.update handler failed:', e?.message || e)
    }
  })
}

/* ============ LISTENER ============ */
export const antideleteListener = {
  command: '__antidelete_listener',
  category: 'tools',
  setup,
  async run({ sock, message }) {
    try {
      if (!sock || !message?.key) return
      if (message.key.remoteJid === 'status@broadcast') return

      let preDownload = null
      if (PRE_DOWNLOAD) {
        const mediaType = getMediaType(message)
        if (mediaType && !SKIP_TYPES.has(mediaType)) {
          try {
            const inner = unwrapContent(message.message)
            const buffer = await downloadWithRetry(inner, message.key)
            if (buffer.length <= PRE_DOWNLOAD_MAX_BYTES) preDownload = { buffer, type: mediaType }
          } catch (e) {
            console.error('[ANTIDELETE] pre-download failed (will retry on revoke):', e?.message || e)
          }
        }
      }

      cacheMessage(message, preDownload)

      const protocol = message.message?.protocolMessage
      if (!protocol || protocol.type !== 0 || !protocol.key) return
      if (markProcessedRevoke(protocol.key.id)) return

      const settings = await loadSettings()
      if (!settings.enabled) return
      const targetJid = resolveTarget(settings, sock)
      if (!targetJid) return

      const entry = getCachedEntry(protocol.key)
      if (!entry) {
        console.log(`[ANTIDELETE] ✗ not in cache (${protocol.key.id?.slice(0, 8)}…) [inline]`)
        return
      }
      const revoker = message.key.participant || message.key.remoteJid
      await forwardToTarget(sock, targetJid, entry, revoker)
      console.log(`[ANTIDELETE] ✓ recovered (${protocol.key.id?.slice(0, 8)}…) [inline]`)
    } catch (e) {
      console.error('[ANTIDELETE] Listener failed:', e?.message || e)
    }
  }
}

/* ============ COMMAND ============ */
const antideleteCommand = {
  command: 'antidelete',
  category: 'tools',
  description: 'Forward deleted messages to the owner',
  async run({ sock, message, args = [], isOwner }) {
    try {
      const jid = message?.key?.remoteJid
      if (!jid) return
      const reply = text => sock.sendMessage(jid, { text }, { quoted: message }).catch(() => {})

      if (!isOwner) return reply('❌ ᴏɴʟʏ ᴛʜᴇ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴄʜᴀɴɢᴇ ᴀɴᴛɪ-ᴅᴇʟᴇᴛᴇ ꜱᴇᴛᴛɪɴɢꜱ')

      const settings = await loadSettings()
      const action = String(args[0] || 'status').toLowerCase()

      switch (action) {
        case 'on': case 'enable':
          settings.enabled = true
          await saveSettings(settings)
          return reply('✅ ᴀɴᴛɪ-ᴅᴇʟᴇᴛᴇ ᴇɴᴀʙʟᴇᴅ\n\nᴅᴇʟᴇᴛᴇᴅ ᴍᴇꜱꜱᴀɢᴇꜱ ᴡɪʟʟ ʙᴇ ꜰᴏʀᴡᴀʀᴅᴇᴅ ᴛᴏ ʏᴏᴜ')
        case 'off': case 'disable':
          settings.enabled = false
          await saveSettings(settings)
          return reply('❌ ᴀɴᴛɪ-ᴅᴇʟᴇᴛᴇ ᴅɪꜱᴀʙʟᴇᴅ')
        case 'set': {
          const raw = String(args[1] || '').trim()
          if (!raw) return reply('ᴜꜱᴀɢᴇ: .antidelete set <number|jid>')
          const targetJid = raw.includes('@') ? raw : raw.replace(/\D/g, '') + '@s.whatsapp.net'
          if (!/^[\w.-]+@(s\.whatsapp\.net|g\.us)$/i.test(targetJid)) return reply('❌ ɪɴᴠᴀʟɪᴅ ᴊɪᴅ')
          settings.targetJid = targetJid
          await saveSettings(settings)
          return reply(`✅ ᴀɴᴛɪ-ᴅᴇʟᴇᴛᴇ ᴛᴀʀɢᴇᴛ ꜱᴇᴛ ᴛᴏ\n${targetJid}`)
        }
        case 'reset':
          settings.targetJid = ''
          await saveSettings(settings)
          return reply('✅ ᴀɴᴛɪ-ᴅᴇʟᴇᴛᴇ ᴛᴀʀɢᴇᴛ ʀᴇꜱᴇᴛ ᴛᴏ ʙᴏᴛ ᴊɪᴅ')
        case 'clear': {
          const n = messageCache.size
          messageCache.clear(); processedRevokes.clear()
          console.log(`[ANTIDELETE] manual clear — removed ${n} entries`)
          return reply(`✅ ᴄᴀᴄʜᴇ ᴄʟᴇᴀʀᴇᴅ (${n} ᴇɴᴛʀɪᴇꜱ ʀᴇᴍᴏᴠᴇᴅ)`)
        }
        case 'status': default: {
          const target = resolveTarget(settings, sock)
          return reply([
            '╭━━━〔 ᴀɴᴛɪ-ᴅᴇʟᴇᴛᴇ 〕', '│',
            `│ ꜱᴛᴀᴛᴜꜱ : ${settings.enabled ? 'ᴏɴ ✅' : 'ᴏғғ ❌'}`,
            `│ ᴛᴀʀɢᴇᴛ : ${settings.targetJid || '(bot jid)'}`,
            `│ ʀᴇꜱᴏʟᴠᴇᴅ : ${target || '—'}`, '│',
            '│ ᴀᴜᴛᴏ-ᴄʟᴇᴀʀ',
            `│ ᴄᴀᴄʜᴇ : ${messageCache.size} / ${MAX_CACHE} (ʜᴀʀᴅ ${HARD_LIMIT})`,
            `│ ᴛᴛʟ : ${CACHE_TTL_MIN} ᴍɪɴ`,
            `│ ᴘʀᴜɴᴇ : ᴇᴠᴇʀʏ ${PRUNE_INTERVAL_MIN} ᴍɪɴ`,
            `│ ᴘʀᴇ-ᴅʟ : ${PRE_DOWNLOAD ? `ᴏɴ (${PRE_DOWNLOAD_MAX_BYTES / 1024 / 1024} ᴍʙ)` : 'ᴏғғ'}`,
            `│ ꜱᴋɪᴘ : ${SKIP_TYPES.size ? [...SKIP_TYPES].join(', ') : 'ɴᴏɴᴇ'}`, '│',
            '│ ᴄᴏᴍᴍᴀɴᴅꜱ',
            '│ .antidelete on', '│ .antidelete off',
            '│ .antidelete set <number|jid>', '│ .antidelete reset',
            '│ .antidelete clear', '│ .antidelete status', '│',
            '╰━━━━━━━━━━━━━━━━━━'
          ].join('\n'))
        }
      }
    } catch (e) {
      console.error('[ANTIDELETE] Command failed:', e?.message || e)
    }
  }
}

export default antideleteCommand
