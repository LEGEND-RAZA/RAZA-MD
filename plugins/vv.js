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
  return String(text || '')
    .toLowerCase()
    .split('')
    .map((c) => map[c] || c)
    .join('')
}

export default {
  command: ['vv'],
  category: 'tools',
  description: 'Retrieve and reveal view once media messages',

  async run({ sock, message }) {
    const jid = message.key.remoteJid

    // 1. Unwrap the incoming command message if it was sent in disappearing mode
    let msg = message.message
    if (msg?.ephemeralMessage) msg = msg.ephemeralMessage.message

    const msgType = Object.keys(msg || {})[0]
    const ctxInfo = msg?.[msgType]?.contextInfo
    const quotedMsg = ctxInfo?.quotedMessage

    if (!quotedMsg) {
      return await sock.sendMessage(
        jid,
        { text: `⚠️ ${toSmallCaps('please reply to a view once message.')}` },
        { quoted: message }
      )
    }

    // 2. Unwrap the quoted message to find the actual media
    let inner = quotedMsg
    if (inner?.viewOnceMessageV2) inner = inner.viewOnceMessageV2.message
    else if (inner?.viewOnceMessage) inner = inner.viewOnceMessage.message
    else if (inner?.viewOnceMessageV2Extension) inner = inner.viewOnceMessageV2Extension.message
    else if (inner?.ephemeralMessage) inner = inner.ephemeralMessage.message

    const mediaType = Object.keys(inner || {})[0]

    if (!['imageMessage', 'videoMessage', 'audioMessage'].includes(mediaType)) {
      return await sock.sendMessage(
        jid,
        { text: `❌ ${toSmallCaps('the quoted message is not a valid view once media.')}` },
        { quoted: message }
      )
    }

    try {
      // 3. Construct a proper fake message for Baileys to download (needs the Key & ID)
      const fakeMsg = {
        key: {
          remoteJid: jid,
          id: ctxInfo.stanzaId,
          participant: ctxInfo.participant,
          fromMe: false
        },
        message: quotedMsg 
      }

      // 4. Download with reuploadRequest to handle expired media URLs
      const buffer = await downloadMediaMessage(
        fakeMsg,
        'buffer',
        {},
        {
          logger: console,
          reuploadRequest: sock.updateMediaMessage // Fixes "sometimes fails" on old media
        }
      )

      const targetMediaKey = mediaType.replace('Message', '')
      const caption = inner[mediaType]?.caption || `🔓 *${toSmallCaps('view once revealed')}*`

      if (mediaType === 'audioMessage') {
        const ptt = Boolean(inner.audioMessage?.ptt)
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
        { text: `❌ ${toSmallCaps('failed to retrieve view once media. link may have expired.')}` },
        { quoted: message }
      )
    }
  }
}
