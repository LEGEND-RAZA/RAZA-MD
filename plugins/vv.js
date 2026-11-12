import { downloadMediaMessage } from '@whiskeysockets/baileys'
import fs from 'node:fs'
import path from 'node:path'

function toSmallCaps(text) {
  const map = {
    a: '\u1D00', b: '\u0299', c: '\u1D04', d: '\u1D05', e: '\u1D07',
    f: '\u0493', g: '\u0262', h: '\u029C', i: '\u026A', j: '\u1D0A',
    k: '\u1D0B', l: '\u029F', m: '\u1D0D', n: '\u0274', o: '\u1D0F',
    p: '\u1D18', q: '\u01FA', r: '\u0280', s: 's',      t: '\u1D1B',
    u: '\u1D1C', v: '\u1D20', w: '\u1D21', x: 'x',      y: '\u028F',
    z: '\u1D22'
  }
  return String(text || '').toLowerCase().split('').map((c) => map[c] || c).join('')
}

const CACHE_DIR = path.join(process.cwd(), 'database', 'vv_cache')

export default {
  command: ['vv'],
  category: 'tools',
  description: 'Retrieve and reveal view once media messages',

  async run({ sock, message }) {
    const jid = message.key.remoteJid
    const msgType = Object.keys(message.message || {})[0]
    const ctxInfo = message.message?.[msgType]?.contextInfo
    const quotedMsg = ctxInfo?.quotedMessage

    if (!quotedMsg) {
      return await sock.sendMessage(
        jid,
        { text: `⚠️ ${toSmallCaps('please reply to a view once message.')}` },
        { quoted: message }
      )
    }

    // Unwrap the message
    let inner = quotedMsg
    while (
      inner?.viewOnceMessage || 
      inner?.viewOnceMessageV2 || 
      inner?.viewOnceMessageV2Extension || 
      inner?.ephemeralMessage
    ) {
      if (inner.viewOnceMessage) inner = inner.viewOnceMessage.message
      else if (inner.viewOnceMessageV2) inner = inner.viewOnceMessageV2.message
      else if (inner.viewOnceMessageV2Extension) inner = inner.viewOnceMessageV2Extension.message
      else if (inner.ephemeralMessage) inner = inner.ephemeralMessage.message
    }

    const mediaType = Object.keys(inner || {})[0]

    if (!['imageMessage', 'videoMessage', 'audioMessage'].includes(mediaType)) {
      return await sock.sendMessage(
        jid,
        { text: `❌ ${toSmallCaps('the quoted message is not a valid view once media.')}` },
        { quoted: message }
      )
    }

    try {
      const targetMediaKey = mediaType.replace('Message', '')
      const mediaNode = inner[mediaType]
      const caption = mediaNode?.caption || `🔓 *${toSmallCaps('view once revealed')}*`

      let buffer = null
      const cachePath = path.join(CACHE_DIR, `${ctxInfo.stanzaId}.${targetMediaKey}`)

      // 1. Try to load from the background cache first
      if (fs.existsSync(cachePath)) {
        buffer = fs.readFileSync(cachePath)
        console.log(`[VIEWONCE] Loaded from cache: ${ctxInfo.stanzaId}`)
      } else {
        // 2. Fallback: Try downloading directly
        const targetMsg = {
          key: { remoteJid: jid, id: ctxInfo.stanzaId, participant: ctxInfo.participant, fromMe: false },
          message: inner
        }

        buffer = await downloadMediaMessage(
          targetMsg,
          'buffer',
          {},
          { logger: console, reuploadRequest: sock.updateMediaMessage }
        )
      }

      if (!buffer || buffer.length === 0) throw new Error('Empty buffer')

      // 3. Send the media
      if (mediaType === 'audioMessage') {
        return await sock.sendMessage(
          jid,
          { 
            audio: buffer, 
            ptt: Boolean(mediaNode?.ptt), 
            mimetype: mediaNode?.mimetype || 'audio/mp4' 
          },
          { quoted: message }
        )
      }

      await sock.sendMessage(
        jid,
        { [targetMediaKey]: buffer, caption },
        { quoted: message }
      )

    } catch (err) {
      console.error('[VIEWONCE] Extraction error:', err)
      
      let errMsg = toSmallCaps('failed to retrieve view once media.')
      if (err.message.includes('No valid media URL') || err.message.includes('404')) {
        errMsg = toSmallCaps('whatsapp deleted this file before the bot could save it. the bot must be online when the view once is sent.')
      }

      await sock.sendMessage(jid, { text: `❌ ${errMsg}` }, { quoted: message })
    }
  }
}
