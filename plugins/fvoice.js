import {
  downloadContentFromMessage
} from '@whiskeysockets/baileys'

function normalizeJid(input) {
  if (!input) return null

  input = input.trim()

  if (input.endsWith('@s.whatsapp.net')) {
    return input
  }

  if (input.endsWith('@g.us')) {
    return input
  }

  const number = input.replace(/\D/g, '')

  if (!number) return null

  return `${number}@s.whatsapp.net`
}

function getQuotedMessage(message) {
  const contextInfo =
    message.message?.extendedTextMessage?.contextInfo ||
    message.message?.imageMessage?.contextInfo ||
    message.message?.videoMessage?.contextInfo ||
    message.message?.audioMessage?.contextInfo ||
    message.message?.documentMessage?.contextInfo

  return contextInfo?.quotedMessage || null
}

function getAudioMessage(message) {
  if (!message) return null

  if (message.audioMessage) {
    return message.audioMessage
  }

  if (message.viewOnceMessage?.message?.audioMessage) {
    return message.viewOnceMessage.message.audioMessage
  }

  if (message.viewOnceMessageV2?.message?.audioMessage) {
    return message.viewOnceMessageV2.message.audioMessage
  }

  if (
    message.viewOnceMessageV2Extension?.message?.audioMessage
  ) {
    return message.viewOnceMessageV2Extension.message.audioMessage
  }

  return null
}

export default {
  command: ['vto'],
  category: 'media',

  description:
    'Forward an original voice note to a number or group',

  async run({
    sock,
    message,
    args,
    isOwner
  }) {
    if (!isOwner) return

    const chatJid = message.key.remoteJid
    const target = normalizeJid(args?.[0])

    if (!target) {
      return await sock.sendMessage(
        chatJid,
        {
          text:
            '❌ ᴘʟᴇᴀsᴇ ᴘʀᴏᴠɪᴅᴇ ᴀ ᴠᴀʟɪᴅ ɴᴜᴍʙᴇʀ ᴏʀ ɢʀᴏᴜᴘ ᴊɪᴅ.\n\nᴇxᴀᴍᴘʟᴇ:\n.vto 923xxxxxxxxx@s.whatsapp.net'
        },
        {
          quoted: message
        }
      )
    }

    const quoted = getQuotedMessage(message)

    if (!quoted) {
      return await sock.sendMessage(
        chatJid,
        {
          text:
            '❌ ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴠᴏɪᴄᴇ ɴᴏᴛᴇ.'
        },
        {
          quoted: message
        }
      )
    }

    const audio = getAudioMessage(quoted)

    if (!audio) {
      return await sock.sendMessage(
        chatJid,
        {
          text:
            '❌ ᴛʜᴇ ʀᴇᴘʟɪᴇᴅ ᴍᴇssᴀɢᴇ ɪs ɴᴏᴛ ᴀ ᴠᴏɪᴄᴇ ɴᴏᴛᴇ.'
        },
        {
          quoted: message
        }
      )
    }

    try {
      const stream = await downloadContentFromMessage(
        audio,
        'audio'
      )

      const chunks = []

      for await (const chunk of stream) {
        chunks.push(chunk)
      }

      const buffer = Buffer.concat(chunks)

      if (!buffer.length) {
        throw new Error('Audio buffer is empty')
      }

      /*
       * Show "recording..." to the target
       */
      await sock.sendPresenceUpdate(
        'recording',
        target
      )

      /*
       * Keep recording presence visible
       * before sending the original audio
       */
      await new Promise(resolve =>
        setTimeout(resolve, 1500)
      )

      /*
       * Send the original audio as a voice note.
       * No TTS and no speech conversion.
       */
      await sock.sendMessage(target, {
        audio: buffer,
        mimetype:
          audio.mimetype || 'audio/ogg; codecs=opus',
        ptt: true
      })

      /*
       * Stop recording presence
       */
      await sock.sendPresenceUpdate(
        'paused',
        target
      )

      await sock.sendMessage(
        chatJid,
        {
          text:
            `✅ ᴠᴏɪᴄᴇ ɴᴏᴛᴇ ꜰᴏʀᴡᴀʀᴅᴇᴅ\n\nᴛᴏ: ${target}`
        },
        {
          quoted: message
        }
      )
    } catch (error) {
      console.error('[VTO]', error)

      await sock.sendPresenceUpdate(
        'paused',
        target
      ).catch(() => {})

      await sock.sendMessage(
        chatJid,
        {
          text:
            '❌ ꜰᴀɪʟᴇᴅ ᴛᴏ ꜰᴏʀᴡᴀʀᴅ ᴛʜᴇ ᴠᴏɪᴄᴇ ɴᴏᴛᴇ.'
        },
        {
          quoted: message
        }
      )
    }
  }
}
