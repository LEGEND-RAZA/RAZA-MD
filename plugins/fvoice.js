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
    'Forward an original voice note as view once',

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

      let waveform = audio.waveform

      if (waveform) {
        if (Buffer.isBuffer(waveform)) {
          waveform = Buffer.from(waveform)
        } else if (waveform instanceof Uint8Array) {
          waveform = Buffer.from(waveform)
        }
      }

      /*
       * Show recording status.
       */
      await sock.sendPresenceUpdate(
        'recording',
        target
      )

      /*
       * Random recording time:
       * 2 to 8 seconds.
       */
      const recordingTime =
        Math.floor(Math.random() * 7) + 2

      await new Promise(resolve =>
        setTimeout(
          resolve,
          recordingTime * 1000
        )
      )

      /*
       * Send the original audio.
       *
       * No TTS.
       * No audio conversion.
       * Original waveform and duration
       * are preserved when available.
       *
       * viewOnce makes the voice note
       * a View Once message.
       */
      const voiceMessage = {
        audio: buffer,
        mimetype:
          audio.mimetype || 'audio/ogg; codecs=opus',
        ptt: true,
        viewOnce: true
      }

      if (audio.seconds != null) {
        voiceMessage.seconds = audio.seconds
      }

      if (waveform) {
        voiceMessage.waveform = waveform
      }

      await sock.sendMessage(
        target,
        voiceMessage
      )

      /*
       * Stop recording status.
       */
      await sock.sendPresenceUpdate(
        'paused',
        target
      )

      await sock.sendMessage(
        chatJid,
        {
          text:
            `✅ ᴠɪᴇᴡ ᴏɴᴄᴇ ᴠᴏɪᴄᴇ ꜰᴏʀᴡᴀʀᴅᴇᴅ\n\nᴛᴏ: ${target}\nᴡᴀᴠᴇꜰᴏʀᴍ: ${waveform ? 'ᴘʀᴇsᴇʀᴠᴇᴅ' : 'ɴᴏᴛ ᴀᴠᴀɪʟᴀʙʟᴇ'}\nʀᴇᴄᴏʀᴅɪɴɢ: ${recordingTime}s`
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
