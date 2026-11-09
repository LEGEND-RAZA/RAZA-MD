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
  return String(text || '').toLowerCase().split('').map(c => map[c] || c).join('')
}

export default {
  command: ['vv'],
  category: 'tools',
  description: 'Retrieve and reveal view once media messages',

  async run({ sock, message }) {
    const jid = message.key.remoteJid
    const send = text => sock.sendMessage(jid, { text }, { quoted: message })

    if (!globalThis.__vv) {
      return send('❌ View-once capture is not installed. Add the captureViewOnce lines to index.js and restart.')
    }

    const content = normalizeMessageContent(message.message)
    const ctxInfo = Object.values(content || {}).map(v => v?.contextInfo).find(Boolean)
    const quotedMsg = ctxInfo?.quotedMessage
    if (!quotedMsg) return send(`⚠️ ${toSmallCaps('please reply to a view once message.')}`)

    let buffer = null
    let type = null
    let mimetype = ''
    let caption = ''
    let ptt = false

    // 1) Copy saved when the message arrived
    const entry = globalThis.__vv.get(ctxInfo.stanzaId)
    if (entry) {
      try {
        const fs = await import('node:fs')
        buffer = await fs.promises.readFile(entry.file)
        ;({ type, mimetype, caption, ptt } = entry)
      } catch (err) {
        console.error('[VIEWONCE] cache read failed:', err.message)
      }
    }

    // 2) Fallback: download straight from the quoted message
    if (!buffer) {
      const inner = normalizeMessageContent(quotedMsg)
      const qType = Object.keys(inner || {}).find(k => MEDIA_TYPES.includes(k))
      if (!qType) return send(`❌ ${toSmallCaps('the quoted message is not a valid view once media.')}`)
      try {
        buffer = await downloadMediaMessage(
          {
            key: { remoteJid: jid, id: ctxInfo.stanzaId, participant: ctxInfo.participant, fromMe: false },
            message: inner,
          },
          'buffer',
          {},
          { logger, reuploadRequest: m => sock.updateMediaMessage(m) }
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
      return send(`❌ ${toSmallCaps('this view once was not saved. it must arrive while the bot is online. send a new one and try again.')}`)
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
