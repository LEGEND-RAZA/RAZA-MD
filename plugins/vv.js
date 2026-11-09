import { downloadMediaMessage } from '@whiskeysockets/baileys'

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

    // Unwrap the message to find the actual media type for validation
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
        { text: `❌ ${toSmallCaps('the quoted message is not a valid media.')}` },
        { quoted: message }
      )
    }

    try {
      // Construct the fake message object. We pass the ORIGINAL quotedMsg 
      // so Baileys can properly send the retry request if the URL is missing.
      const fakeMsg = {
        key: {
          remoteJid: jid,
          id: ctxInfo.stanzaId,
          participant: ctxInfo.participant,
          fromMe: false
        },
        message: quotedMsg 
      }

      // downloadMediaMessage automatically handles missing URLs by requesting 
      // WhatsApp to re-upload the media using the reuploadRequest parameter.
      const buffer = await downloadMediaMessage(
        fakeMsg,
        'buffer',
        {},
        {
          logger: console,
          reuploadRequest: sock.updateMediaMessage
        }
      )

      const mediaNode = inner[mediaType]
      const targetMediaKey = mediaType.replace('Message', '')
      const caption = mediaNode?.caption || `🔓 *${toSmallCaps('view once revealed')}*`

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
      await sock.sendMessage(
        jid,
        { text: `❌ ${toSmallCaps('failed to retrieve view once media. it may have been deleted from whatsapp servers.')}` },
        { quoted: message }
      )
    }
  }
}
