import {
  downloadContentFromMessage,
  prepareWAMessageMedia,
  generateWAMessageFromContent,
  jidNormalizedUser
} from '@whiskeysockets/baileys'

async function downloadMedia(message, type) {
  const stream =
    await downloadContentFromMessage(
      message,
      type
    )

  const chunks = []

  for await (const chunk of stream) {
    chunks.push(chunk)
  }

  return Buffer.concat(chunks)
}

async function prepareStatusMedia(
  quotedMessage,
  sock
) {
  if (quotedMessage?.imageMessage) {
    const media =
      await downloadMedia(
        quotedMessage.imageMessage,
        'image'
      )

    const prepared =
      await prepareWAMessageMedia(
        {
          image: media,
          mimetype:
            quotedMessage.imageMessage.mimetype ||
            'image/jpeg'
        },
        {
          upload: sock.waUploadToServer
        }
      )

    if (prepared.imageMessage) {
      prepared.imageMessage.caption =
        quotedMessage.imageMessage.caption || ''
    }

    return prepared
  }

  if (quotedMessage?.videoMessage) {
    const media =
      await downloadMedia(
        quotedMessage.videoMessage,
        'video'
      )

    const prepared =
      await prepareWAMessageMedia(
        {
          video: media,
          mimetype:
            quotedMessage.videoMessage.mimetype ||
            'video/mp4'
        },
        {
          upload: sock.waUploadToServer
        }
      )

    if (prepared.videoMessage) {
      prepared.videoMessage.caption =
        quotedMessage.videoMessage.caption || ''
    }

    return prepared
  }

  if (quotedMessage?.audioMessage) {
    const media =
      await downloadMedia(
        quotedMessage.audioMessage,
        'audio'
      )

    return await prepareWAMessageMedia(
      {
        audio: media,
        mimetype:
          quotedMessage.audioMessage.mimetype ||
          'audio/ogg; codecs=opus',
        ptt:
          quotedMessage.audioMessage.ptt || false
      },
      {
        upload: sock.waUploadToServer
      }
    )
  }

  const text =
    quotedMessage?.conversation ||
    quotedMessage?.extendedTextMessage?.text

  if (text) {
    return {
      extendedTextMessage: {
        text
      }
    }
  }

  return null
}

async function sendGroupStatus(
  sock,
  groupJid,
  statusMessage
) {
  const userJid =
    jidNormalizedUser(
      sock.user?.id
    )

  const msg =
    generateWAMessageFromContent(
      groupJid,
      {
        groupStatusMessageV2: {
          message: statusMessage
        }
      },
      {
        userJid
      }
    )

  await sock.relayMessage(
    groupJid,
    msg.message,
    {
      messageId: msg.key.id
    }
  )
}

export default {
  command: 'gst',

  async run({
    sock,
    message,
    quotedMessage
  }) {
    if (!quotedMessage) {
      await sock.sendMessage(
        message.key.remoteJid,
        {
          text:
            '❌ ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴛᴇxᴛ, ɪᴍᴀɢᴇ ᴏʀ ᴠɪᴅᴇᴏ.'
        }
      )

      return
    }

    try {
      const statusMessage =
        await prepareStatusMedia(
          quotedMessage,
          sock
        )

      if (!statusMessage) {
        await sock.sendMessage(
          message.key.remoteJid,
          {
            text:
              '❌ ᴜɴsᴜᴘᴘᴏʀᴛᴇᴅ ᴍᴇᴅɪᴀ ᴛʏᴘᴇ.'
          }
        )

        return
      }

      const groups =
        await sock.groupFetchAllParticipating()

      const groupJids =
        Object.keys(groups)
          .filter(jid =>
            jid.endsWith('@g.us')
          )

      let success = 0
      let failed = 0

      for (const groupJid of groupJids) {
        try {
          await sendGroupStatus(
            sock,
            groupJid,
            statusMessage
          )

          success++

          console.log(
            `[GST] Posted: ${groupJid}`
          )
        } catch (error) {
          failed++

          console.error(
            `[GST] Failed: ${groupJid}`,
            error?.message || error
          )
        }
      }

      await sock.sendMessage(
        message.key.remoteJid,
        {
          text:
            `╭─❒ ɢʀᴏᴜᴘ sᴛᴀᴛᴜs ❒\n` +
            `│\n` +
            `│ ᴛᴏᴛᴀʟ: ${groupJids.length}\n` +
            `│ sᴜᴄᴄᴇss: ${success}\n` +
            `│ ғᴀɪʟᴇᴅ: ${failed}\n` +
            `╰──────────────`
        }
      )

    } catch (error) {
      console.error(
        '[GST ERROR]',
        error
      )

      await sock.sendMessage(
        message.key.remoteJid,
        {
          text:
            `❌ ɢsᴛ ғᴀɪʟᴇᴅ\n\n` +
            `${error?.message || error}`
        }
      )
    }
  }
}