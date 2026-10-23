import {
  downloadContentFromMessage,
  prepareWAMessageMedia,
  generateWAMessageFromContent,
  getContentType,
  jidNormalizedUser
} from '@whiskeysockets/baileys'

async function downloadMedia(message, type) {
  const stream = await downloadContentFromMessage(message, type)
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

/*
 * Unwrap ephemeral / view-once / document-with-caption wrappers so we
 * can access the underlying content type (imageMessage, videoMessage, …).
 */
function unwrapQuoted(q) {
  let m = q
  for (let i = 0; i < 6; i++) {
    const next =
      m?.ephemeralMessage?.message ||
      m?.viewOnceMessage?.message ||
      m?.viewOnceMessageV2?.message ||
      m?.viewOnceMessageV2Extension?.message ||
      m?.documentWithCaptionMessage?.message
    if (!next || typeof next !== 'object') break
    m = next
  }
  return m
}

/*
 * Build the status content from the quoted message.
 *
 * For MEDIA: download + reupload via prepareWAMessageMedia (WA needs fresh
 * media keys for the new upload), then restore every field that affects
 * rendering: caption, seconds, gifPlayback, ptt, waveform.
 *
 * For TEXT: clone the entire extendedTextMessage proto so WhatsApp uses
 * the ORIGINAL link preview (title, description, thumbnail, mediaKey, …)
 * instead of regenerating it under the bot's account. Only `contextInfo`
 * is stripped — it references message IDs that don't exist in the target
 * group and would cause delivery failure.
 */
async function prepareStatusMedia(quotedMessage, sock) {
  const q = unwrapQuoted(quotedMessage) || quotedMessage || {}
  const type = getContentType(q)

  if (type === 'imageMessage') {
    const img = q.imageMessage
    const media = await downloadMedia(img, 'image')
    const prepared = await prepareWAMessageMedia(
      {
        image: media,
        mimetype: img.mimetype || 'image/jpeg',
        caption: img.caption || ''
      },
      { upload: sock.waUploadToServer }
    )
    if (prepared?.imageMessage) {
      if (img.caption) prepared.imageMessage.caption = img.caption
    }
    return prepared
  }

  if (type === 'videoMessage') {
    const vid = q.videoMessage
    const media = await downloadMedia(vid, 'video')
    const prepared = await prepareWAMessageMedia(
      {
        video: media,
        mimetype: vid.mimetype || 'video/mp4',
        caption: vid.caption || '',
        seconds: vid.seconds,
        gifPlayback: vid.gifPlayback || false
      },
      { upload: sock.waUploadToServer }
    )
    if (prepared?.videoMessage) {
      if (vid.caption) prepared.videoMessage.caption = vid.caption
      if (vid.seconds) prepared.videoMessage.seconds = vid.seconds
      if (vid.gifPlayback) prepared.videoMessage.gifPlayback = true
    }
    return prepared
  }

  if (type === 'audioMessage') {
    const aud = q.audioMessage
    const media = await downloadMedia(aud, 'audio')
    const prepared = await prepareWAMessageMedia(
      {
        audio: media,
        mimetype: aud.mimetype || 'audio/ogg; codecs=opus',
        ptt: aud.ptt === true,
        seconds: aud.seconds
      },
      { upload: sock.waUploadToServer }
    )
    if (prepared?.audioMessage) {
      if (aud.seconds) prepared.audioMessage.seconds = aud.seconds
      if (aud.ptt) prepared.audioMessage.ptt = true
      if (aud.waveform) {
        prepared.audioMessage.waveform = Buffer.isBuffer(aud.waveform)
          ? aud.waveform
          : Buffer.from(aud.waveform)
      }
    }
    return prepared
  }

  if (type === 'stickerMessage') {
    const stk = q.stickerMessage
    const media = await downloadMedia(stk, 'sticker')
    return await prepareWAMessageMedia(
      {
        sticker: media,
        mimetype: stk.mimetype || 'image/webp'
      },
      { upload: sock.waUploadToServer }
    )
  }

  if (type === 'documentMessage') {
    const doc = q.documentMessage
    const media = await downloadMedia(doc, 'document')
    const prepared = await prepareWAMessageMedia(
      {
        document: media,
        mimetype: doc.mimetype || 'application/octet-stream',
        fileName: doc.fileName || 'file',
        caption: doc.caption || ''
      },
      { upload: sock.waUploadToServer }
    )
    if (prepared?.documentMessage && doc.caption) {
      prepared.documentMessage.caption = doc.caption
    }
    return prepared
  }

  if (type === 'extendedTextMessage') {
    // Preserve the ORIGINAL preview (title, description, thumbnail,
    // mediaKey, …) by cloning the whole proto. Only strip contextInfo —
    // it points to a message that doesn't exist in the target group.
    const cloned = { ...q.extendedTextMessage }
    delete cloned.contextInfo
    return { extendedTextMessage: cloned }
  }

  if (type === 'conversation') {
    const raw = q.conversation || ''
    // Basic URL detection so WA still generates a preview for plain text
    const urlRe = /(https?:\/\/[^\s]+)/i
    const m = raw.match(urlRe)
    const ext = { text: raw }
    if (m) ext.matchedText = m[1]
    return { extendedTextMessage: ext }
  }

  return null
}

async function sendGroupStatus(sock, groupJid, statusMessage) {
  const userJid = jidNormalizedUser(sock.user?.id)

  const msg = generateWAMessageFromContent(
    groupJid,
    {
      groupStatusMessageV2: {
        message: statusMessage
      }
    },
    { userJid }
  )

  await sock.relayMessage(groupJid, msg.message, {
    messageId: msg.key.id
  })
}

async function getGroups(sock) {
  const groups = await sock.groupFetchAllParticipating()
  return Object.keys(groups).filter(jid => jid.endsWith('@g.us'))
}

function statusTypeLabel(statusMessage) {
  if (!statusMessage) return 'unknown'
  const k = Object.keys(statusMessage)[0]
  return k || 'unknown'
}

export default {
  command: ['gst', 'gggg'],
  category: 'tools',

  async run({ sock, message, quotedMessage, command, args }) {
    const jid = message?.key?.remoteJid
    if (!jid) return

    if (!quotedMessage) {
      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ 𝐑ᴇᴘʟʏ 𝐓ᴏ 𝐀 𝐓ᴇxᴛ, 𝐈ᴍᴀɢᴇ, 𝐕ɪᴅᴇᴏ, 𝐕ᴏɪᴄᴇ 𝐎ʀ 𝐀ᴜᴅɪᴏ'
        },
        { quoted: message }
      )
    }

    try {
      const statusMessage = await prepareStatusMedia(quotedMessage, sock)

      if (!statusMessage) {
        return await sock.sendMessage(
          jid,
          {
            text: '❌ 𝐔ɴsᴜᴘᴘᴏʀᴛᴇᴅ 𝐌ᴇᴅɪᴀ 𝐓ʏᴘᴇ'
          },
          { quoted: message }
        )
      }

      const typeLabel = statusTypeLabel(statusMessage)

      /* ── .gst : every group ── */
      if (command === 'gst') {
        const groupJids = await getGroups(sock)

        if (!groupJids.length) {
          return await sock.sendMessage(
            jid,
            { text: '❌ 𝐁ᴏᴛ 𝐈s 𝐍ᴏᴛ 𝐈ɴ 𝐀ɴʏ 𝐆ʀᴏᴜᴘs' },
            { quoted: message }
          )
        }

        let success = 0
        let failed = 0

        for (const groupJid of groupJids) {
          try {
            await sendGroupStatus(sock, groupJid, statusMessage)
            success++
            console.log(`[GST] Posted (${typeLabel}): ${groupJid}`)
            await new Promise(r => setTimeout(r, 500))
          } catch (error) {
            failed++
            console.error(`[GST] Failed: ${groupJid}`, error?.message || error)
          }
        }

        return await sock.sendMessage(
          jid,
          {
            text:
              `╭─❒ ɢʀᴏᴜᴘ sᴛᴀᴛᴜs ❒\n` +
              `│\n` +
              `│ ᴛʏᴘᴇ: ${typeLabel}\n` +
              `│ ᴛᴏᴛᴀʟ: ${groupJids.length}\n` +
              `│ sᴜᴄᴄᴇss: ${success}\n` +
              `│ ғᴀɪʟᴇᴅ: ${failed}\n` +
              `╰──────────────`
          },
          { quoted: message }
        )
      }

      /* ── .gggg : specific group, N times ── */
      if (command === 'gggg') {
        let targetJid = jid
        let count = 1

        if (args[0]) {
          if (args[0].endsWith('@g.us')) {
            targetJid = args[0]
            count = Number(args[1]) || 1
          } else {
            count = Number(args[0]) || 1
          }
        }

        if (!targetJid.endsWith('@g.us')) {
          return await sock.sendMessage(
            jid,
            {
              text:
                '❌ 𝐆ʀᴏᴜᴘ 𝐉ɪᴅ 𝐑ᴇǫᴜɪʀᴇᴅ\n\n' +
                '𝐄xᴀᴍᴘʟᴇ:\n' +
                '.gggg 120363xxxx@g.us 5'
            },
            { quoted: message }
          )
        }

        count = Math.max(1, Math.min(count, 50))

        let success = 0
        let failed = 0

        for (let i = 0; i < count; i++) {
          try {
            await sendGroupStatus(sock, targetJid, statusMessage)
            success++
            console.log(`[GGGG] Posted ${i + 1}/${count} (${typeLabel}): ${targetJid}`)
            if (i < count - 1) await new Promise(r => setTimeout(r, 500))
          } catch (error) {
            failed++
            console.error(`[GGGG] Failed: ${targetJid}`, error?.message || error)
          }
        }

        return await sock.sendMessage(
          jid,
          {
            text:
              `╭─❒ ɢɢɢɢ ❒\n` +
              `│\n` +
              `│ ɢʀᴏᴜᴘ: ${targetJid}\n` +
              `│ ᴛʏᴘᴇ: ${typeLabel}\n` +
              `│ ᴛᴏᴛᴀʟ: ${count}\n` +
              `│ sᴜᴄᴄᴇss: ${success}\n` +
              `│ ғᴀɪʟᴇᴅ: ${failed}\n` +
              `╰──────────────`
          },
          { quoted: message }
        )
      }
    } catch (error) {
      console.error('[GST/GGGG ERROR]', error)
      return await sock.sendMessage(
        jid,
        {
          text: `❌ ɢsᴛ ғᴀɪʟᴇᴅ\n\n${error?.message || error}`
        },
        { quoted: message }
      )
    }
  }
}
