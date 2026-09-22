import { downloadMediaMessage } from '@whiskeysockets/baileys'

// Clean Unicode Escape Map for Small Caps
function toSmallCaps(text) {
  const map = {
    a: '\u1D00', b: '\u0299', c: '\u1D04', d: '\u1D05', e: '\u1D07',
    f: '\u0493', g: '\u0262', h: '\u029C', i: '\u026A', j: '\u1D0A',
    k: '\u1D0B', l: '\u029F', m: '\u1D0D', n: '\u0274', o: '\u1D0F',
    p: '\u1D18', q: '\u01FA', r: '\u0280', s: 's',      t: '\u1D1B',
    u: '\u1D1C', v: '\u1D20', w: '\u1D21', x: 'x',      y: '\u028F',
    z: '\u1D22'
  }
  return String(text || '')
    .toLowerCase()
    .split('')
    .map((c) => map[c] || c)
    .join('')
}

export default {
  command: ['vv', 'viewonce'],
  description: 'Retrieve and reveal view once media messages',
  async run({ sock, message }) {
    const jid = message.key.remoteJid

    // Check for quoted message
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

    // Extract inner viewOnce message wrapper if present
    const viewOnceWrapper =
      quotedMsg.viewOnceMessageV2?.message ||
      quotedMsg.viewOnceMessage?.message ||
      quotedMsg.viewOnceMessageV2Extension?.message ||
      quotedMsg

    const mediaType = Object.keys(viewOnceWrapper)[0]

    if (!['imageMessage', 'videoMessage', 'audioMessage'].includes(mediaType)) {
      return await sock.sendMessage(
        jid,
        { text: `❌ ${toSmallCaps('the quoted message is not a valid view once media.')}` },
        { quoted: message }
      )
    }

    try {
      // Download the media buffer from the quoted view-once payload
      const buffer = await downloadMediaMessage(
        { message: viewOnceWrapper },
        'buffer',
        {}
      )

      const targetMediaKey = mediaType.replace('Message', '')
      const caption =
        viewOnceWrapper[mediaType]?.caption ||
        `🔓 *${toSmallCaps('view once revealed')}*`

      if (mediaType === 'audioMessage') {
        const ptt = Boolean(viewOnceWrapper.audioMessage?.ptt)
        return await sock.sendMessage(
          jid,
          { audio: buffer, ptt, mimetype: 'audio/mp4' },
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
      await sock.sendMessage(
        jid,
        { text: `❌ ${toSmallCaps('failed to retrieve view once media.')}` },
        { quoted: message }
      )
    }
  }
}