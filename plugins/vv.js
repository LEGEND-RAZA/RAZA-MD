import { downloadContentFromMessage } from '@whiskeysockets/baileys'

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

    // Keep unwrapping the message until we reach the actual media object
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
      // Extract the raw media node (e.g. imageMessage) and the type (e.g. 'image')
      const mediaObj = inner[mediaType]
      const targetMediaKey = mediaType.replace('Message', '') 

      // Download directly from the media node, skipping all wrapper confusion
      const stream = await downloadContentFromMessage(mediaObj, targetMediaKey)
      
      const chunks = []
      for await (const chunk of stream) {
        chunks.push(chunk)
      }
      const buffer = Buffer.concat(chunks)

      if (buffer.length === 0) {
        throw new Error('File is empty')
      }

      const caption = mediaObj?.caption || `🔓 *${toSmallCaps('view once revealed')}*`

      // Send back to chat
      if (mediaType === 'audioMessage') {
        return await sock.sendMessage(
          jid,
          { audio: buffer, ptt: Boolean(mediaObj?.ptt), mimetype: mediaObj?.mimetype || 'audio/mp4' },
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
        { text: `❌ ${toSmallCaps('failed to retrieve view once media.')}\n\n_${err.message || 'Media is corrupted or deleted'}_` },
        { quoted: message }
      )
    }
  }
}
