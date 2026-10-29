import {
  generateWAMessageFromContent,
  generateMessageID,
  proto,
  prepareWAMessageMedia
} from '@whiskeysockets/baileys'

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

function extractUrl(text) {
  if (!text) return null
  const m = String(text).match(/https?:\/\/[^\s]+/i)
  return m ? m[0] : null
}

function extractFromQuoted(quotedMessage) {
  if (!quotedMessage) return null
  const inner = unwrap(quotedMessage)
  if (!inner) return null

  const ext = inner.extendedTextMessage
  const img = inner.imageMessage
  const vid = inner.videoMessage

  const textSources = [ext?.text, img?.caption, vid?.caption, inner.conversation]

  let url = null
  for (const t of textSources) {
    url = extractUrl(t)
    if (url) break
  }
  if (!url && ext?.matchedText) url = ext.matchedText
  if (!url) return null

  return {
    url,
    canonicalUrl: ext?.canonicalUrl,
    title: ext?.title,
    description: ext?.description,
    jpegThumbnail: ext?.jpegThumbnail,
    previewType: ext?.previewType
  }
}

async function fetchGroupPreview(sock, url) {
  const m = url.match(/chat\.whatsapp\.com\/([0-9A-Za-z]+)/i)
  if (!m) return null

  try {
    const meta = await sock.groupGetInviteInfo(m[1])
    const groupName = meta?.subject || 'WhatsApp Group'
    const result = {
      matchedText: url,
      canonicalUrl: url,
      title: groupName,
      description: `Invite to join "${groupName}"`,
      previewType: 'NONE'
    }

    if (meta?.id) {
      try {
        const ppUrl = await sock.profilePictureUrl(meta.id, 'image')
        if (ppUrl) {
          const res = await fetch(ppUrl)
          if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer())
            const prepared = await prepareWAMessageMedia(
              { image: buf },
              { upload: sock.waUploadToServer }
            )
            if (prepared?.imageMessage?.jpegThumbnail) {
              result.jpegThumbnail = prepared.imageMessage.jpegThumbnail
            }
          }
        }
      } catch {}
    }

    return result
  } catch (e) {
    console.error('[PAY] group preview failed:', e?.message || e)
    return null
  }
}

async function buildNoteContent(sock, customText, quotedData) {
  const customUrl = customText ? extractUrl(customText) : null

  let url = null
  let previewSource = null

  if (customUrl) {
    url = customUrl
    if (quotedData && quotedData.url === customUrl) {
      previewSource = quotedData
    }
  } else if (quotedData) {
    url = quotedData.url
    previewSource = quotedData
  }

  if (!url) {
    return { text: customText || '' }
  }

  let displayText = customText || ''
  if (!displayText || !displayText.includes(url)) {
    displayText = displayText ? `${displayText}\n${url}` : url
  }

  const content = {
    text: displayText,
    matchedText: url,
    canonicalUrl: previewSource?.canonicalUrl || url
  }

  if (
    previewSource &&
    (previewSource.title || previewSource.jpegThumbnail || previewSource.description)
  ) {
    if (previewSource.title) content.title = previewSource.title
    if (previewSource.description) content.description = previewSource.description
    if (previewSource.jpegThumbnail) content.jpegThumbnail = previewSource.jpegThumbnail
    if (previewSource.previewType) content.previewType = previewSource.previewType
  } else {
    const fetched = await fetchGroupPreview(sock, url)
    if (fetched) {
      if (fetched.title) content.title = fetched.title
      if (fetched.description) content.description = fetched.description
      if (fetched.jpegThumbnail) content.jpegThumbnail = fetched.jpegThumbnail
      if (fetched.previewType) content.previewType = fetched.previewType
    }
  }

  return content
}

export default {
  command: ['pay'],
  category: 'owner',
  description: 'Send a fake payment request to all groups (reply to a link or pass text)',

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
      const quotedData = extractFromQuoted(quotedMessage)

      if (!customText && !quotedData) {
        return sock.sendMessage(
          jid,
          {
            text:
              'ᴜꜱᴀɢᴇ:\n\n' +
              '• *.ᴘᴀʏ <ᴍᴇꜱꜱᴀɢᴇ>* → ᴛᴇxᴛ-ᴏɴʟʏ ᴘᴀʏᴍᴇɴᴛ ɴᴏᴛᴇ\n' +
              '• *ʀᴇᴘʟʏ ᴛᴏ ᴀ ʟɪɴᴋ ᴡɪᴛʜ .ᴘᴀʏ* → ꜱᴇɴᴅ ʟɪɴᴋ + ᴏʀɪɢɪɴᴀʟ ᴘʀᴇᴠɪᴇᴡ\n' +
              '• *ʀᴇᴘʟʏ ᴛᴏ ᴀ ʟɪɴᴋ ᴡɪᴛʜ .ᴘᴀʏ <ᴛᴇxᴛ>* → ᴄᴜꜱᴛᴏᴍ ᴛᴇxᴛ + ʟɪɴᴋ ᴘʀᴇᴠɪᴇᴡ'
          },
          { quoted: message }
        )
      }

      const noteContent = await buildNoteContent(sock, customText, quotedData)

      const groupsObj = await sock.groupFetchAllParticipating()
      const groups = Object.values(groupsObj)

      if (!groups.length) {
        return sock.sendMessage(
          jid,
          { text: '❌ ɴᴏ ɢʀᴏᴜᴘꜱ ꜰᴏᴜɴᴅ.' },
          { quoted: message }
        )
      }

      const previewLabel = noteContent.title
        ? `ᴡɪᴛʜ ᴘʀᴇᴠɪᴇᴡ: "${noteContent.title}"`
        : noteContent.matchedText
          ? 'ᴀᴜᴛᴏ-ɢᴇɴᴇʀᴀᴛᴇᴅ ᴘʀᴇᴠɪᴇᴡ'
          : 'ᴛᴇxᴛ ᴏɴʟʏ'

      await sock.sendMessage(
        jid,
        {
          text:
            `📢 ꜱᴇɴᴅɪɴɢ ᴘᴀʏᴍᴇɴᴛ ʀᴇQᴜᴇꜱᴛ ᴛᴏ ${groups.length} ɢʀᴏᴜᴘꜱ...\n` +
            `🖼️ ${previewLabel}`
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

          const payProto = {
            requestPaymentMessage: {
              currencyCodeIso4217: 'BRL',
              amount1000: '0',
              noteMessage: {
                extendedTextMessage: {
                  ...noteContent,
                  contextInfo: { mentionedJid: participants }
                }
              },
              expiryTimestamp: '0',
              amount: {
                value: '0',
                offset: 1000,
                currencyCode: 'BRL'
              }
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
          console.log(
            `[PAY] ✓ ${group.id} | ${participants.length} mentions | ` +
            `preview: ${noteContent.title || noteContent.matchedText || 'none'}`
          )

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
