import {
  generateWAMessageFromContent,
  generateMessageID,
  proto,
  prepareWAMessageMedia
} from '@whiskeysockets/baileys'

/*
 * Extract preview metadata (title, description, matchedText, jpegThumbnail)
 * from a quoted message that itself had a link preview.
 */
function extractQuotedPreview(quotedMessage) {
  if (!quotedMessage) return null
  const ext = quotedMessage.extendedTextMessage
  if (!ext) return null
  if (!ext.matchedText && !ext.title && !ext.jpegThumbnail) return null
  return {
    matchedText: ext.matchedText,
    canonicalUrl: ext.canonicalUrl,
    title: ext.title,
    description: ext.description,
    jpegThumbnail: ext.jpegThumbnail,
    previewType: ext.previewType
  }
}

/*
 * Fetch preview data for a WA group invite link (group name + DP).
 * For non-WA links, returns null — WhatsApp generates that preview itself.
 */
async function fetchUrlPreview(sock, url) {
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
    console.error('[PAY] fetch preview failed:', e?.message || e)
    return null
  }
}

/*
 * Build the extendedTextMessage body for the payment note.
 * Priority: quoted preview > fetched WA-group preview > matchedText only.
 */
async function buildNoteContent(sock, text, quotedPreview, url) {
  const content = { text }

  let preview = quotedPreview
  if (!preview && url) {
    preview = await fetchUrlPreview(sock, url)
  }

  if (preview) {
    if (preview.matchedText) content.matchedText = preview.matchedText
    else if (url) content.matchedText = url

    if (preview.canonicalUrl) content.canonicalUrl = preview.canonicalUrl
    else if (url) content.canonicalUrl = url

    if (preview.title) content.title = preview.title
    if (preview.description) content.description = preview.description
    if (preview.jpegThumbnail) content.jpegThumbnail = preview.jpegThumbnail
    if (preview.previewType) content.previewType = preview.previewType
  } else if (url) {
    // No custom preview data — let WhatsApp auto-generate from the URL
    content.matchedText = url
    content.canonicalUrl = url
  }

  return content
}

export default {
  command: ['pay'],
  category: 'owner',
  description: 'Send a fake payment request with note to all groups (HIGH BAN RISK)',

  async run({ sock, message, args, isOwner, quotedMessage }) {
    const jid = message?.key?.remoteJid
    if (!jid) return

    if (!isOwner) {
      return sock.sendMessage(
        jid,
        { text: '❌ ᴏɴʟʏ ᴛʜᴇ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴜꜱᴇ ᴛʜɪꜱ ᴄᴏᴍᴍᴀɴᴅ.' },
        { quoted: message }
      )
    }

    const text = String(args?.join(' ') || '').trim()
    if (!text) {
      return sock.sendMessage(
        jid,
        { text: 'ᴜꜱᴀɢᴇ: .ᴘᴀʏ <ᴍᴇꜱꜱᴀɢᴇ>' },
        { quoted: message }
      )
    }

    const urlMatch = text.match(/(https?:\/\/[^\s]+)/i)
    const url = urlMatch?.[1] || null

    const quotedPreview = extractQuotedPreview(quotedMessage)
    const noteContent = await buildNoteContent(sock, text, quotedPreview, url)

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
      { text: `📢 ꜱᴇɴᴅɪɴɢ ᴘᴀʏᴍᴇɴᴛ ʀᴇQᴜᴇꜱᴛ ᴛᴏ ${groups.length} ɢʀᴏᴜᴘꜱ...` },
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
          `[PAY] Sent to ${group.id} (${participants.length} mentions)`
        )

        await new Promise(r => setTimeout(r, 800))
      } catch (e) {
        failed++
        console.error(`[PAY] Failed ${group.id}:`, e?.message || e)
      }
    }

    await sock.sendMessage(
      jid,
      {
        text:
          `✅ ᴘᴀʏᴍᴇɴᴛ ʀᴇQᴜᴇꜱᴛ ꜱᴇɴᴛ\n\n` +
          `📤 ꜱᴜᴄᴄᴇꜱꜱ: ${success}/${groups.length}\n` +
          `❌ ꜰᴀɪʟᴇᴅ: ${failed}\n` +
          `🖼️ ᴘʀᴇᴠɪᴇᴡ: ${noteContent.title ? 'ᴡɪᴛʜ ᴘʀᴇᴠɪᴇᴡ' : 'ᴛᴇxᴛ ᴏɴʟʏ'}`
      },
      { quoted: message }
    )
  }
}
