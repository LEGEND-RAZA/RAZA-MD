import { downloadContentFromMessage } from '@whiskeysockets/baileys'

function normalizeJid(input) {
  if (!input) return null
  input = input.trim()
  if (input.endsWith('@s.whatsapp.net')) return input
  if (input.endsWith('@g.us')) return input
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
  if (message.audioMessage) return message
  if (message.viewOnceMessage?.message) return unwrapMessage(message.viewOnceMessage.message)
  if (message.viewOnceMessageV2?.message) return unwrapMessage(message.viewOnceMessageV2.message)
  if (message.viewOnceMessageV2Extension?.message) return unwrapMessage(message.viewOnceMessageV2Extension.message)
  if (message.ephemeralMessage?.message) return unwrapMessage(message.ephemeralMessage.message)
  return null
}

/*
 * Waveform normalizer.
 *
 * WhatsApp renders the voice-bubble bars from a 64-byte Uint8Array, each
 * byte being the amplitude of one of the 64 segments (values 0–100).
 *
 * - If the source is a 64-byte array/Uint8Array/Buffer, use it verbatim.
 * - If the source is a shorter/longer array, resample it into 64 buckets
 *   (preserves the original shape).
 * - If there is no source at all, synthesize a natural-looking pattern
 *   so the bubble never shows as a flat line.
 */
function normalizeWaveform(source) {
  // 1) Normalize any input to a plain array of numbers 0–100
  let samples = null
  if (source) {
    try {
      let arr
      if (Buffer.isBuffer(source)) arr = Array.from(source)
      else if (source instanceof Uint8Array) arr = Array.from(source)
      else if (Array.isArray(source)) arr = source.map(Number)
      else if (typeof source === 'object' && typeof source.length === 'number') {
        arr = Array.from(source).map(Number)
      }

      if (arr && arr.length) {
        // Clamp each sample to 0–100
        samples = arr.map(v => {
          const n = Math.max(0, Math.min(100, Math.round(Number(v) || 0)))
          return n
        })
        // Strip trailing zeros so resample below doesn't compress the "active" part
        while (samples.length > 1 && samples[samples.length - 1] === 0) samples.pop()
      }
    } catch {}
  }

  // 2) If we got valid samples, resample to exactly 64
  if (samples && samples.length) {
    const out = new Uint8Array(64)
    const n = samples.length
    for (let i = 0; i < 64; i++) {
      const pos = (i / 63) * (n - 1)
      const lo = Math.floor(pos)
      const hi = Math.min(n - 1, lo + 1)
      const t = pos - lo
      const v = samples[lo] * (1 - t) + samples[hi] * t
      out[i] = Math.max(1, Math.min(100, Math.round(v)))
    }
    return out
  }

  // 3) No waveform available — synthesize a natural-looking one.
  // Uses a low-frequency sine envelope + slight jitter so it looks like
  // a real voice recording rather than a uniform block of bars.
  const out = new Uint8Array(64)
  for (let i = 0; i < 64; i++) {
    const t = i / 63
    const env = 0.5 + 0.5 * Math.sin(t * Math.PI) // ramp up / ramp down
    const ripple = 0.6 + 0.4 * Math.sin(t * Math.PI * 6)
    const jitter = 0.85 + Math.random() * 0.3
    const amp = env * ripple * jitter
    out[i] = Math.max(2, Math.min(100, Math.round(amp * 90)))
  }
  return out
}

export default {
  command: ['vnto'],
  category: 'media',
  description: 'Forward a voice note',

  async run({ sock, message, args, isOwner }) {
    if (!isOwner) return

    const chatJid = message.key.remoteJid
    const target = normalizeJid(args?.[0])

    if (!target) {
      return await sock.sendMessage(
        chatJid,
        { text: '❌ ᴘʟᴇᴀsᴇ ᴘʀᴏᴠɪᴅᴇ ᴀ ᴠᴀʟɪᴅ ɴᴜᴍʙᴇʀ ᴏʀ ɢʀᴏᴜᴘ ᴊɪᴅ.' },
        { quoted: message }
      )
    }

    const quoted = getQuotedMessage(message)

    if (!quoted) {
      return await sock.sendMessage(
        chatJid,
        { text: '❌ ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴠᴏɪᴄᴇ ɴᴏᴛᴇ.' },
        { quoted: message }
      )
    }

    const audioMessage = unwrapMessage(quoted)

    if (!audioMessage) {
      return await sock.sendMessage(
        chatJid,
        { text: '❌ ᴛʜᴇ ʀᴇᴘʟɪᴇᴅ ᴍᴇssᴀɢᴇ ɪs ɴᴏᴛ ᴀ ᴠᴏɪᴄᴇ ɴᴏᴛᴇ.' },
        { quoted: message }
      )
    }

    const audio = audioMessage.audioMessage

    try {
      const stream = await downloadContentFromMessage(audio, 'audio')

      const chunks = []
      for await (const chunk of stream) {
        chunks.push(chunk)
      }

      const buffer = Buffer.concat(chunks)

      if (!buffer.length) {
        throw new Error('Empty audio buffer')
      }

      const originalSeconds = Number(audio.seconds) || 1

      await sock.sendPresenceUpdate('recording', target)
      await new Promise(resolve => setTimeout(resolve, originalSeconds * 1000))

      // Build the voice payload — waveform is ALWAYS present.
      const voiceMessage = {
        audio: buffer,
        mimetype: audio.mimetype || 'audio/ogg; codecs=opus',
        ptt: true,
        seconds: originalSeconds,
        waveform: normalizeWaveform(audio.waveform)
      }

      await sock.sendMessage(target, voiceMessage)
      await sock.sendPresenceUpdate('paused', target)

      await sock.sendMessage(
        chatJid,
        {
          text:
            `✅ ᴠᴏɪᴄᴇ sᴇɴᴛ\n\n` +
            `ᴛᴏ: ${target}\n` +
            `ᴅᴜʀᴀᴛɪᴏɴ: ${originalSeconds}s\n` +
            `ᴡᴀᴠᴇꜰᴏʀᴍ: ${audio.waveform ? 'ꜱᴏᴜʀᴄᴇ' : 'ꜱʏɴᴛʜᴇꜱɪᴢᴇᴅ'}`
        },
        { quoted: message }
      )
    } catch (error) {
      console.error('[VTO]', error)
      await sock.sendPresenceUpdate('paused', target).catch(() => {})
      await sock.sendMessage(
        chatJid,
        { text: `❌ ꜰᴀɪʟᴇᴅ ᴛᴏ sᴇɴᴅ ᴠᴏɪᴄᴇ.\n\n${error?.message || 'Unknown error'}` },
        { quoted: message }
      )
    }
  }
}
