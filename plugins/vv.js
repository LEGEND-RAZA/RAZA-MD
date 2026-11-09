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

    // 1. Unwrap the nested wrappers to find the actual media type
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
      // 2. Construct a fake message with the correct Key info
      const fakeMsg = {
        key: {
          remoteJid: jid,
          id: ctxInfo.stanzaId,
          participant: ctxInfo.participant,
          fromMe: false
        },
        message: quotedMsg
      }

      // 3. Download with custom Retry Handler
      const buffer = await downloadMediaMessage(
        fakeMsg,
        'buffer',
        {},
        {
          logger: console,
          reuploadRequest: async (msg) => {
            // Ask WhatsApp for a fresh URL
            await sock.updateMediaMessage(msg)
            
            // Wait for WhatsApp to send the updated message back
            return new Promise((resolve, reject) => {
              const listener = (updates) => {
                for (const update of updates) {
                  if (update.key.id === msg.key.id && update.update.message) {
                    sock.ev.off('messages.update', listener)
                    clearTimeout(timer)
                    resolve(update.update.message)
                    return
                  }
                }
              }
              
              sock.ev.on('messages.update', listener)
              
              // Timeout after 10 seconds if WhatsApp doesn't respond
              const timer = setTimeout(() => {
                sock.ev.off('messages.update', listener)
                reject(new Error('Media retry timed out'))
              }, 10000)
            })
          }
        }
      )

      if (!buffer || buffer.length === 0) throw new Error('Empty buffer')

      const mediaNode = inner[mediaType]
      const targetMediaKey = mediaType.replace('Message', '')
      const caption = mediaNode?.caption || `🔓 *${toSmallCaps('view once revealed')}*`

      // 4. Send the media back
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
      if (err.message.includes('No valid media URL') || err.message.includes('timed out')) {
        errMsg = toSmallCaps('whatsapp has permanently deleted this media from their servers. it cannot be recovered.')
      } else if (err.message.includes('Empty buffer')) {
        errMsg = toSmallCaps('downloaded file was empty.')
      }

      await sock.sendMessage(
        jid,
        { text: `❌ ${errMsg}` },
        { quoted: message }
      )
    }
  }
}
