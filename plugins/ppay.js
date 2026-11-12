import {
  generateWAMessageFromContent,
  generateMessageID,
  proto,
  downloadMediaMessage,
  prepareWAMessageMedia
} from '@whiskeysockets/baileys'

// Helper to unwrap nested messages
function unwrap(m) {
  let cur = m
  for (let i = 0; i < 8; i++) {
    const next =
      cur?.ephemeralMessage?.message ||
      cur?.viewOnceMessage?.message ||
      cur?.viewOnceMessageV2?.message ||
      cur?.viewOnceMessageV2Extension?.message ||
      cur?.documentWithCaptionMessage?.message
    if (!next || typeof next !== 'object') break
    cur = next
  }
  return cur
}

// Extract text from a quoted message
function getQuotedText(quotedMessage) {
  if (!quotedMessage) return ''
  const inner = unwrap(quotedMessage)
  if (!inner) return ''

  const ext = inner.extendedTextMessage
  const img = inner.imageMessage
  const vid = inner.videoMessage

  return ext?.text || img?.caption || vid?.caption || inner.conversation || ''
}

export default {
  command: ['ppay'],
  category: 'owner',
  description: 'Send a fake payment request to all groups',

  async run({ sock, message, args, isOwner, quotedMessage }) {
    const jid = message?.key?.remoteJid
    if (!jid) return

    try {
      if (!isOwner) {
        return sock.sendMessage(
          jid,
          { text: '❌ ᴏɴʟʏ ᴛʜᴇ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴜꜱᴇ ᴛʜɪꜱ ᴄᴏᴍᴍᴀɴᴅ.' },
          { quoted: message }
        )
      }

      const customText = String(args?.join(' ') || '').trim()
      const quotedText = getQuotedText(quotedMessage)

      let baseMediaMessage = null
      let mediaType = null
      const inner = unwrap(quotedMessage)

      if (inner?.imageMessage) {
        mediaType = 'image'
      } else if (inner?.videoMessage) {
        mediaType = 'video'
      }

      let finalText = customText || quotedText

      if (!finalText && !mediaType) {
        return sock.sendMessage(
          jid,
          {
            text:
              'ᴜꜱᴀɢᴇ:\n\n' +
              '• *.ᴘᴀʏ <ᴍᴇꜱꜱᴀɢᴇ>* → ꜱᴇɴᴅ ꜱᴘᴇᴄɪꜰɪᴄ ᴛᴇxᴛ\n' +
              '• *ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴛᴇxᴛ/ɪᴍᴀɢᴇ/ᴠɪᴅᴇᴏ ᴡɪᴛʜ .ᴘᴀʏ* → ꜱᴇɴᴅ ɪᴛ ᴡɪᴛʜ ᴘᴀʏᴍᴇɴᴛ'
          },
          { quoted: message }
        )
      }

      if (mediaType) {
        try {
          const buffer = await downloadMediaMessage(
            { message: quotedMessage }, 'buffer', {},
            { logger: console, reuploadRequest: sock.updateMediaMessage }
          )
          
          const uploaded = await prepareWAMessageMedia(
            mediaType === 'image' 
              ? { image: buffer, mimetype: 'image/jpeg' } 
              : { video: buffer, mimetype: 'video/mp4' }, 
            { upload: sock.waUploadToServer }
          )
          
          if (mediaType === 'image' && uploaded?.imageMessage) {
            baseMediaMessage = uploaded.imageMessage
          } else if (mediaType === 'video' && uploaded?.videoMessage) {
            baseMediaMessage = uploaded.videoMessage
          }
        } catch (e) {
          console.error(`[PAY] ${mediaType} prep failed:`, e.message)
          mediaType = null 
        }
      }

      if (!finalText && !baseMediaMessage) {
         return sock.sendMessage(jid, { text: '❌ ꜰᴀɪʟᴇᴅ ᴛᴏ ᴘʀᴇᴘᴀʀᴇ ᴍᴇᴅɪᴀ.' }, { quoted: message })
      }

      const groupsObj = await sock.groupFetchAllParticipating()
      const groups = Object.values(groupsObj)

      if (!groups.length) {
        return sock.sendMessage(
          jid,
          { text: '❌ ɴᴏ ɢʀᴏᴜᴘꜱ ꜰᴏᴜɴᴅ.' },
          { quoted: message }
        )
      }

      await sock.sendMessage(
        jid,
        {
          text: `📢 ꜱᴇɴᴅɪɴɢ ᴘᴀʏᴍᴇɴᴛ ʀᴇQᴜᴇꜱᴛ ᴛᴏ ${groups.length} ɢʀᴏᴜᴘꜱ...\n` +
                (baseMediaMessage ? `🖼️ ᴀᴛᴛᴀᴄʜɪɴɢ ${mediaType.toUpperCase()}...` : '📝 ᴛᴇxᴛ ᴏɴʟʏ')
        },
        { quoted: message }
      )

      let success = 0
      let failed = 0

      for (const group of groups) {
        try {
          const participants = (group.participants || [])
            .map(p => p.id)
            .filter(Boolean)

          let noteMessage
          if (mediaType === 'image' && baseMediaMessage) {
            noteMessage = {
              imageMessage: {
                ...baseMediaMessage,
                mimetype: 'image/jpeg',
                caption: finalText,
                contextInfo: { mentionedJid: participants }
              }
            }
          } else if (mediaType === 'video' && baseMediaMessage) {
            noteMessage = {
              videoMessage: {
                ...baseMediaMessage,
                mimetype: 'video/mp4',
                caption: finalText,
                contextInfo: { mentionedJid: participants }
              }
            }
          } else {
            noteMessage = {
              extendedTextMessage: {
                text: finalText,
                contextInfo: { mentionedJid: participants }
              }
            }
          }

          const payProto = {
            requestPaymentMessage: {
              currencyCodeIso4217: 'BRL',
              amount1000: '0',
              noteMessage: noteMessage,
              expiryTimestamp: '0',
              amount: {
                value: '0',
                offset: 1000,
                currencyCode: 'BRL'
              },
              background: 'DEFAULT' // 🚀 CRITICAL FIX FOR NEW WHATSAPP VERSIONS
            }
          }

          const msg = generateWAMessageFromContent(
            group.id,
            proto.Message.fromObject(payProto),
            { messageId: generateMessageID() }
          )

          await sock.relayMessage(group.id, msg.message, {
            messageId: msg.key.id
          })

          success++
          console.log(`[PAY] ✓ ${group.id} | ${participants.length} mentions`)

          await new Promise(r => setTimeout(r, 800))
        } catch (e) {
          failed++
          console.error(`[PAY] ✗ ${group.id}:`, e?.message || e)
        }
      }

      await sock.sendMessage(
        jid,
        {
          text:
            `✅ ꜱᴜᴄᴄᴇꜱꜱ: ${success}/${groups.length}\n` +
            `❌ ꜰᴀɪʟᴇᴅ: ${failed}`
        },
        { quoted: message }
      )
    } catch (e) {
      console.error('[PAY] Command failed:', e?.stack || e?.message || e)
      try {
        await sock.sendMessage(
          jid,
          { text: `❌ ᴘᴀʏ ꜰᴀɪʟᴇᴅ\n\n${e?.message || e}` },
          { quoted: message }
        )
      } catch {}
    }
  }
}
