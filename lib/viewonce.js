import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pino from 'pino'
import { downloadMediaMessage, normalizeMessageContent } from '@whiskeysockets/baileys'

const logger = pino({ level: 'silent' })
const MEDIA_TYPES = ['imageMessage', 'videoMessage', 'audioMessage']
const DIR = path.join(os.tmpdir(), 'raza-vv')
const MAX_ENTRIES = 100
const MAX_BYTES = 50 * 1024 * 1024
const TTL_MS = 12 * 60 * 60 * 1000
const DEBUG = Boolean(process.env.VV_DEBUG)

fs.mkdirSync(DIR, { recursive: true })

const store = new Map()
const pending = new Set()

function removeEntry(id) {
  const e = store.get(id)
  if (e) fs.promises.unlink(e.file).catch(() => {})
  store.delete(id)
}

export function getViewOnce(id) {
  const e = store.get(id)
  if (!e) return null
  if (Date.now() - e.time > TTL_MS || !fs.existsSync(e.file)) {
    removeEntry(id)
    return null
  }
  return e
}

function findViewOnce(message) {
  if (!message) return null
  const raw = message.ephemeralMessage?.message || message
  const wrapped = raw.viewOnceMessage || raw.viewOnceMessageV2 || raw.viewOnceMessageV2Extension
  const inner = normalizeMessageContent(message)
  const type = Object.keys(inner || {}).find(k => MEDIA_TYPES.includes(k))
  if (!type) return null
  if (wrapped || inner[type]?.viewOnce) return { inner, type }
  return null
}

async function capture(sock, m) {
  const id = m?.key?.id
  if (!id || store.has(id) || pending.has(id)) return

  if (DEBUG) {
    console.log('[VV_DEBUG] message keys:', Object.keys(m.message || {}).join(','), '| chat:', m.key.remoteJid)
  }

  const found = findViewOnce(m.message)
  if (!found) return

  pending.add(id)
  console.log(`[VIEWONCE] detected ${found.type} id=${id}`)
  try {
    const buffer = await downloadMediaMessage(
      { key: m.key, message: found.inner },
      'buffer',
      {},
      { logger, reuploadRequest: msg => sock.updateMediaMessage(msg) }
    )
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
    console.log(`[VIEWONCE] saved ${found.type} (${(buffer.length / 1024).toFixed(0)} KB) id=${id}`)
  } catch (err) {
    console.error(`[VIEWONCE] save failed for ${id}:`, err.message)
  } finally {
    pending.delete(id)
  }
}

// Called from index.js for every incoming message. Never throws.
export function captureViewOnce(sock, m) {
  try {
    capture(sock, m).catch(() => {})
  } catch { /* never break the bot */ }
}

globalThis.__vv = { get: getViewOnce }
