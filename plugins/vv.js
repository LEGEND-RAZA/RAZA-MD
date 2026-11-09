import { downloadMediaMessage, normalizeMessageContent } from '@whiskeysockets/baileys'
import pino from 'pino'

const logger = pino({ level: 'silent' })
const MEDIA_TYPES = ['imageMessage', 'videoMessage', 'audioMessage']

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

// ---------- view-once cache (filled as messages arrive) ----------
const cache = new Map()
const hooked = new WeakSet()

function isViewOnce(raw) {
  const r = raw?.ephemeralMessage?.message || raw
  return Boolean(r?.viewOnceMessage || r?.viewOnceMessageV2 || r?.viewOnceMessageV2Extension)
}

function hookCache(sock) {
  if (hooked.has(sock)) return
  hooked.add(sock)
  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const m of messages || []) {
      try {
        if (!m.message || !m.key?.id || !isViewOnce(m.message)) continue
        const inner = normalizeMessageContent(m.message)
        if (!MEDIA_TYPES.includes(Object.keys(inner || {})[0])) continue
        cache.set(m.key.id, { key: m.key, message: inner })
        if (cache.size > 300) cache.delete(cache.keys().next().value)
      } catch { /* ignore */ }
    }
  })
}

// ---------- download ----------
async function tryDownload(sock, candidate) {
  const buffer = await downloadMediaMessage(
    candidate,
    'buffer',
    {},
    { logger, reuploadRequest: (m) => sock.updateMediaMessage(m) }
  )
  if (!buffer || buffer.length === 0) throw new Error('Empty buffer')
  return buffer
}

export default {
  command: ['vv'],
  category: 'tools',
  description: 'Retrieve and reveal view once media messages',

  async run({ sock, message }) {
    const jid = message.key.remoteJid
    const send = (text) => sock.sendMessage(jid, { text }, { quoted: message })

    hookCache(sock)

    // Find the contextInfo no matter which key comes first
    const content = normalizeMessageContent(message.message)
    const ctxInfo = Object.values(content || {}).map((v) => v?.contextInfo).find(Boolean)
    const quotedMsg = ctxInfo?.quotedMessage

    if (!quotedMsg) {
      return send(`⚠️ ${toSmallCaps('please reply to a view once message.')}`)
    }

    const inner = normalizeMessageContent(quotedMsg)
    const mediaType = Object.keys(inner || {})[0]

    if (!MEDIA_TYPES.includes(mediaType)) {
      return send(`❌ ${toSmallCaps('the quoted message is not a valid view once media.')}`)
    }

    try {
      const candidates = []

      // Cached original has the full media keys, so try it first
      const cached = cache.get(ctxInfo.stanzaId)
      if (cached) candidates.push(cached)

      // Then the quoted copy
      candidates.push({
        key: {
          remoteJid: jid,
          id: ctxInfo.stanzaId,
          participant: ctxInfo.participant,
          fromMe: false
        },
        message: inner
      })

      let buffer = null
      let lastErr = null
      for (const candidate of candidates) {
        try {
          buffer = await tryDownload(sock, candidate)
          break
        } catch (err) {
          lastErr = err
          console.error('[VIEWONCE] attempt failed:', err.message)
        }
      }
      if (!buffer) throw lastErr || new Error('Download failed')

      const mediaNode = inner[mediaType]
      const key = mediaType.replace('Message', '')
      const caption = mediaNode?.caption || `🔓 *${toSmallCaps('view once revealed')}*`

      if (mediaType === 'audioMessage') {
        return await sock.sendMessage(
          jid,
          { audio: buffer, ptt: Boolean(mediaNode?.ptt), mimetype: mediaNode?.mimetype || 'audio/mp4' },
          { quoted: message }
        )
      }

      await sock.sendMessage(jid, { [key]: buffer, caption }, { quoted: message })
    } catch (err) {
      console.error('[VIEWONCE] Extraction error:', err)

      let errMsg = toSmallCaps('failed to retrieve view once media.')
      if (/No valid media URL|timed out|404|410|media key|mediaKey/i.test(err.message)) {
        errMsg = toSmallCaps('this media is no longer available or the keys were stripped by whatsapp. it was not cached, so it cannot be recovered.')
      } else if (err.message.includes('Empty buffer')) {
        errMsg = toSmallCaps('downloaded file was empty.')
      }

      await send(`❌ ${errMsg}`)
    }
  }
}
