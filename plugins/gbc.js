import {
  downloadMediaMessage,
  getContentType,
  generateWAMessageFromContent,
  jidNormalizedUser
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

function extractMembers(group) {
  const result = []
  for (const p of group.participants || []) {
    const candidates = [
      p.id,
      p.phoneNumber,
      p.pn,
      p.participantPn,
      p.lid,
      p.participantAlt
    ].filter(Boolean).map(String)

    const pn = candidates.find(c => c.endsWith('@s.whatsapp.net'))
    const lid = candidates.find(c => c.endsWith('@lid'))
    const primary = pn || lid || candidates[0]

    if (primary && primary.includes('@')) {
      result.push({ pn, lid, primary })
    }
  }
  return result
}

const MENTION_BATCH = 100000

function chunkMentions(members) {
  const jids = members.map(m => m.primary).filter(Boolean)
  const batches = []
  for (let i = 0; i < jids.length; i += MENTION_BATCH) {
    batches.push(jids.slice(i, i + MENTION_BATCH))
  }
  return batches.length ? batches : [[]]
}

/*
 * Send a pre-built message proto WITHOUT Baileys rebuilding it.
 * This is the only way to preserve extendedTextMessage link preview
 * metadata (title, description, jpegThumbnail, mediaKey, …) — sendMessage()
 * throws all of that away and regenerates the preview under the bot account.
 */
async function sendRawMessage(sock, jid, content) {
  const userJid = jidNormalizedUser(sock.user.id)
  const msg = generateWAMessageFromContent(jid, content, { userJid })
  await sock.relayMessage(jid, msg.message, { messageId: msg.key.id })
}

export default {
  command: ['gbc'],
  category: 'tools',
  description: 'Broadcast the replied message and notify everyone in all groups',

  async run({ sock, message, isOwner }) {
    const jid = message.key.remoteJid

    if (!isOwner) {
      return await sock.sendMessage(
        jid,
        { text: '❌ 𝐎ɴʟʏ 𝐎ᴡɴᴇʀ 𝐂ᴀɴ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ' },
        { quoted: message }
      )
    }

    const contextInfo =
      message.message?.extendedTextMessage?.contextInfo ||
      message.message?.imageMessage?.contextInfo ||
      message.message?.videoMessage?.contextInfo ||
      message.message?.audioMessage?.contextInfo ||
      message.message?.documentMessage?.contextInfo ||
      message.message?.stickerMessage?.contextInfo

    const quotedMessage = contextInfo?.quotedMessage

    if (!quotedMessage) {
      return await sock.sendMessage(
        jid,
        { text: '⚠️ 𝐑ᴇᴘʟʏ 𝐓ᴏ 𝐀 𝐌ᴇssᴀɢᴇ 𝐓ᴏ 𝐁ʀᴏᴀᴅᴄᴀsᴛ 𝐈ᴛ' },
        { quoted: message }
      )
    }

    try {
      const groupsMap = await sock.groupFetchAllParticipating()
      const groups = Object.values(groupsMap)

      if (!groups.length) {
        return await sock.sendMessage(
          jid,
          { text: '𝐍ᴏ 𝐆ʀᴏᴜᴘs 𝐅ᴏᴜɴᴅ.' },
          { quoted: message }
        )
      }

      await sock.sendMessage(
        jid,
        { text: `📢 𝐏ʀᴏᴄᴇssɪɴɢ 𝐓ᴏ ${groups.length} 𝐆ʀᴏᴜᴘs...` },
        { quoted: message }
      )

      const quoted = {
        key: {
          remoteJid: message.key.remoteJid,
          fromMe: false,
          id: contextInfo.stanzaId,
          participant: contextInfo.participant
        },
        message: quotedMessage
      }

      const inner = unwrap(quotedMessage)
      const type = getContentType(inner)

      if (!type) {
        return await sock.sendMessage(
          jid,
          { text: '❌ 𝐔ɴsᴜᴘᴘᴏʀᴛᴇᴅ 𝐐ᴜᴏᴛᴇᴅ 𝐌ᴇssᴀɢᴇ' },
          { quoted: message }
        )
      }

      let mediaBuffer = null
      if (
        type === 'imageMessage' ||
        type === 'videoMessage' ||
        type === 'documentMessage' ||
        type === 'audioMessage' ||
        type === 'stickerMessage'
      ) {
        mediaBuffer = await downloadMediaMessage(
          { message: inner, key: quoted.key },
          'buffer',
          {}
        )
      }

      let count = 0
      let notified = 0
      let skipped = 0
      let previewPreserved = false

      for (const group of groups) {
        try {
          const members = extractMembers(group)
          if (!members.length) {
            skipped++
            continue
          }

          const batches = chunkMentions(members)
          const baseCaption = getBaseCaption(type, inner)

          for (let b = 0; b < batches.length; b++) {
            const mentionBatch = batches[b]
            const suffix = batches.length > 1 ? ` (${b + 1}/${batches.length})` : ''

            const built = buildContent(
              type,
              inner,
              mediaBuffer,
              baseCaption,
              suffix,
              mentionBatch
            )
            if (!built) throw new Error(`Unsupported: ${type}`)

            if (built.raw) {
              await sendRawMessage(sock, group.id, built.content)
              if (built.previewPreserved) previewPreserved = true
            } else {
              await sock.sendMessage(group.id, built.content)
            }

            notified += mentionBatch.length
            if (b < batches.length - 1) {
              await new Promise(r => setTimeout(r, 800))
            }
          }

          count++
          await new Promise(resolve => setTimeout(resolve, 1000))
        } catch (e) {
          console.error(
            `𝐅ᴀɪʟᴇᴅ 𝐓ᴏ 𝐒𝐞ɴᴅ ${group.id}:`,
            e?.message || e
          )
        }
      }

      await sock.sendMessage(
        jid,
        {
          text:
            `✅ 𝐃ᴏɴᴇ !\n\n` +
            `📤 𝐒ᴇɴᴛ 𝐓ᴏ: *${count}/${groups.length}* 𝐆ʀᴏᴜᴘs\n` +
            `🔔 𝐌ᴇɴᴛɪᴏɴs: *${notified}* 𝐌ᴇᴍʙᴇʀs\n` +
            `🖼️ 𝐏ʀᴇᴠɪᴇᴡ: ${previewPreserved ? '*𝐎ʀɪɢɪɴᴀʟ*' : '*𝐑ᴇɢᴇɴᴇʀᴀᴛᴇᴅ*'}` +
            (skipped ? `\n⚠️ 𝐒ᴋɪᴘᴘᴇᴅ: ${skipped} (𝐍ᴏ 𝐌ᴇᴍʙᴇʀs)` : '')
        },
        { quoted: message }
      )
    } catch (e) {
      console.error('𝐆𝐁𝐂 𝐄ʀʀᴏʀ:', e)

      await sock.sendMessage(
        jid,
        { text: `❌ 𝐅ᴀɪʟᴇᴅ 𝐓ᴏ 𝐁ᴏᴀʀᴅᴄᴀsᴛ: ${e?.message || e}` },
        { quoted: message }
      )
    }
  }
}

function getBaseCaption(type, inner) {
  switch (type) {
    case 'conversation': return inner.conversation || ''
    case 'extendedTextMessage': return inner.extendedTextMessage?.text || ''
    case 'imageMessage': return inner.imageMessage?.caption || ''
    case 'videoMessage': return inner.videoMessage?.caption || ''
    case 'documentMessage': return inner.documentMessage?.caption || ''
    default: return ''
  }
}

function buildContent(type, inner, mediaBuffer, baseCaption, suffix, mentions) {
  /*
   * extendedTextMessage — clone the WHOLE proto so every link-preview field
   * survives: matchedText, canonicalUrl, title, description, jpegThumbnail,
   * thumbnailDirectPath, thumbnailSha256, thumbnailEncSha256, mediaKey,
   * mediaKeyTimestamp, previewType, etc.
   * Only contextInfo is stripped (it references the source message).
   * A fresh contextInfo carries the mention batch for silent notification.
   */
  if (type === 'extendedTextMessage') {
    const cloned = { ...inner.extendedTextMessage }
    if (suffix) cloned.text = baseCaption + suffix
    delete cloned.contextInfo
    if (mentions.length) {
      cloned.contextInfo = { mentionedJid: mentions }
    }
    return {
      content: { extendedTextMessage: cloned },
      raw: true,
      previewPreserved: true
    }
  }

  /*
   * Plain conversation with a URL — promote to extendedTextMessage so
   * WhatsApp generates a fresh preview. There was no original preview
   * (plain text never stores one), so this is the best possible.
   */
  if (type === 'conversation') {
    const text = baseCaption + suffix
    const m = text.match(/(https?:\/\/[^\s]+)/i)
    if (m) {
      const ext = { text, matchedText: m[1] }
      if (mentions.length) ext.contextInfo = { mentionedJid: mentions }
      return {
        content: { extendedTextMessage: ext },
        raw: true,
        previewPreserved: false
      }
    }
    return { content: { text, mentions }, raw: false }
  }

  if (type === 'imageMessage') {
    return {
      content: { image: mediaBuffer, caption: baseCaption + suffix, mentions },
      raw: false
    }
  }

  if (type === 'videoMessage') {
    return {
      content: { video: mediaBuffer, caption: baseCaption + suffix, mentions },
      raw: false
    }
  }

  if (type === 'documentMessage') {
    return {
      content: {
        document: mediaBuffer,
        mimetype: inner.documentMessage?.mimetype || 'application/octet-stream',
        fileName: inner.documentMessage?.fileName || 'document',
        caption: baseCaption + suffix,
        mentions
      },
      raw: false
    }
  }

  if (type === 'audioMessage') {
    return {
      content: {
        audio: mediaBuffer,
        mimetype: inner.audioMessage?.mimetype || 'audio/mp4',
        ptt: inner.audioMessage?.ptt || false,
        mentions
      },
      raw: false
    }
  }

  if (type === 'stickerMessage') {
    return { content: { sticker: mediaBuffer, mentions }, raw: false }
  }

  return null
}
