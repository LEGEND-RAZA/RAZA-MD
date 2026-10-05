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
    message.message?.audioMessage?.contextInfo ||
    message.message?.imageMessage?.contextInfo ||
    message.message?.videoMessage?.contextInfo ||
    message.message?.documentMessage?.contextInfo

  return contextInfo?.quotedMessage || null
}

function unwrapMessage(message) {
  if (!message) return null

  if (message.audioMessage) {
    return message
  }

  if (message.viewOnceMessage?.message) {
    return unwrapMessage(
      message.viewOnceMessage.message
    )
  }

  if (message.viewOnceMessageV2?.message) {
    return unwrapMessage(
      message.viewOnceMessageV2.message
    )
  }

  if (
    message.viewOnceMessageV2Extension?.message
  ) {
    return unwrapMessage(
      message.viewOnceMessageV2Extension.message
    )
  }

  if (message.ephemeralMessage?.message) {
    return unwrapMessage(
      message.ephemeralMessage.message
    )
  }

  return null
}

export default {
  command: [
    'vto',
    'audioto',
    'forwardaudio'
  ],

  category: 'media',

  description:
    'Forward a voice note',

  async run({
    sock,
    message,
    args,
    isOwner
  }) {
    if (!isOwner) return

    const chatJid =
      message.key.remoteJid

    const target =
      normalizeJid(args?.[0])

    if (!target) {
      return await sock.sendMessage(
        chatJid,
        {
          text:
            '❌ ᴘʟᴇᴀsᴇ ᴘʀᴏᴠɪᴅᴇ ᴀ ᴠᴀʟɪᴅ ɴᴜᴍʙᴇʀ ᴏʀ ɢʀᴏᴜᴘ ᴊɪᴅ.'
        },
        {
          quoted: message
        }
      )
    }

    const quoted =
      getQuotedMessage(message)

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

    const audioMessage =
      unwrapMessage(quoted)

    if (!audioMessage) {
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

    const audio =
      audioMessage.audioMessage

    try {
      const stream =
        await downloadContentFromMessage(
          audio,
          'audio'
        )

      const chunks = []

      for await (
        const chunk of stream
      ) {
        chunks.push(chunk)
      }

      const buffer =
        Buffer.concat(chunks)

      if (!buffer.length) {
        throw new Error(
          'Empty audio buffer'
        )
      }

      const originalSeconds =
        Number(audio.seconds) || 1

      await sock.sendPresenceUpdate(
        'recording',
        target
      )

      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            originalSeconds * 1000
          )
      )

      const voiceMessage = {
        audio: buffer,
        mimetype:
          audio.mimetype ||
          'audio/ogg; codecs=opus',
        ptt: true
      }

      if (
        audio.seconds !== undefined
      ) {
        voiceMessage.seconds =
          audio.seconds
      }

      if (audio.waveform) {
        voiceMessage.waveform =
          Buffer.isBuffer(
            audio.waveform
          )
            ? audio.waveform
            : Buffer.from(
                audio.waveform
              )
      }

      await sock.sendMessage(
        target,
        voiceMessage
      )

      await sock.sendPresenceUpdate(
        'paused',
        target
      )

      await sock.sendMessage(
        chatJid,
        {
          text:
            `✅ ᴠᴏɪᴄᴇ sᴇɴᴛ\n\nᴛᴏ: ${target}\nᴅᴜʀᴀᴛɪᴏɴ: ${originalSeconds}s`
        },
        {
          quoted: message
        }
      )
    } catch (error) {
      console.error(
        '[VTO]',
        error
      )

      await sock.sendPresenceUpdate(
        'paused',
        target
      ).catch(() => {})

      await sock.sendMessage(
        chatJid,
        {
          text:
            `❌ ꜰᴀɪʟᴇᴅ ᴛᴏ sᴇɴᴅ ᴠᴏɪᴄᴇ.\n\n${error?.message || 'Unknown error'}`
        },
        {
          quoted: message
        }
      )
    }
  }
}
