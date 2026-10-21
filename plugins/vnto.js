import { downloadContentFromMessage } from '@whiskeysockets/baileys'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ffmpegPath from 'ffmpeg-static'

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
 * ==============================
 * WAVEFORM BUILDERS
 * ==============================
 * WhatsApp renders the voice-bubble bars from a 64-byte array. Every byte
 * is one bar height (0–255, WA scales internally).
 *
 * PRIORITY:
 *   1. Source waveform — pass through VERBATIM when length is 64.
 *      This is the exact waveform the sender's phone shows, so the
 *      forwarded voice looks identical to the original.
 *   2. Source waveform with wrong length — resample (no strips, no clamps).
 *   3. ffmpeg-derived from the decoded audio (unique per voice).
 *   4. Synthesized random (last resort only).
 */

function toByteArray(source) {
  if (!source) return null
  try {
    if (Buffer.isBuffer(source)) return Array.from(source)
    if (source instanceof Uint8Array) return Array.from(source)
    if (Array.isArray(source)) return source.map(Number)
    if (typeof source === 'object' && typeof source.length === 'number') {
      return Array.from(source).map(Number)
    }
  } catch {}
  return null
}

function passthrough64(arr) {
  // Byte-for-byte copy — no clamping, no smoothing, no stripping.
  const out = new Uint8Array(64)
  for (let i = 0; i < 64; i++) {
    const v = Number(arr[i])
    out[i] = Number.isFinite(v)
      ? Math.max(0, Math.min(255, Math.round(v)))
      : 0
  }
  return out
}

function resampleTo64(arr) {
  if (!arr || !arr.length) return null
  const out = new Uint8Array(64)
  const n = arr.length
  for (let i = 0; i < 64; i++) {
    const pos = (i / 63) * (n - 1)
    const lo = Math.floor(pos)
    const hi = Math.min(n - 1, lo + 1)
    const t = pos - lo
    const v = arr[lo] * (1 - t) + arr[hi] * t
    out[i] = Math.max(0, Math.min(255, Math.round(v)))
  }
  return out
}

function synthesizeWaveform() {
  const out = new Uint8Array(64)
  const baseAmp = 25 + Math.random() * 55
  const activity = 0.5 + Math.random() * 0.5
  for (let i = 0; i < 64; i++) {
    const t = i / 63
    const envelope = 0.4 + 0.6 * Math.sin(t * Math.PI)
    const noise = 0.25 + Math.random() * 0.75
    const v = baseAmp * envelope * noise * activity
    out[i] = Math.max(1, Math.min(100, Math.round(v)))
  }
  return out
}

/*
 * Decode audio via ffmpeg to raw 16-bit mono PCM @ 8 kHz, then take the
 * peak per 64th of the duration. Used only when source waveform is missing.
 */
async function deriveWaveformFromAudio(audioBuffer) {
  if (!ffmpegPath) throw new Error('ffmpeg-static binary not found')

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vnwf-'))
  const inFile = path.join(tmpDir, 'in.ogg')

  try {
    await fs.writeFile(inFile, audioBuffer)

    const pcm = await new Promise((resolve, reject) => {
      const args = [
        '-hide_banner', '-loglevel', 'error',
        '-i', inFile, '-vn',
        '-f', 's16le', '-ac', '1', '-ar', '8000',
        'pipe:1'
      ]
      const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      const chunks = []
      const errs = []
      let settled = false
      const finish = (fn, val) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn(val)
      }
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL') } catch {}
        finish(reject, new Error('ffmpeg timeout'))
      }, 30000)
      proc.stdout.on('data', c => chunks.push(c))
      proc.stderr.on('data', c => errs.push(c))
      proc.on('error', e => finish(reject, e))
      proc.on('close', code => {
        if (code !== 0) {
          const err = Buffer.concat(errs).toString().slice(0, 200)
          return finish(reject, new Error(`ffmpeg exit ${code}: ${err}`))
        }
        finish(resolve, Buffer.concat(chunks))
      })
    })

    const sampleCount = pcm.length >> 1
    if (sampleCount < 64) return null

    const peaks = new Float64Array(64)
    const bucketSize = sampleCount / 64
    let maxPeak = 0

    for (let i = 0; i < 64; i++) {
      const start = Math.floor(i * bucketSize)
      const end = Math.floor((i + 1) * bucketSize)
      let peak = 0
      for (let j = start; j < end; j++) {
        const s = Math.abs(pcm.readInt16LE(j * 2))
        if (s > peak) peak = s
      }
      peaks[i] = peak
      if (peak > maxPeak) maxPeak = peak
    }

    if (maxPeak === 0) return null

    const out = new Uint8Array(64)
    for (let i = 0; i < 64; i++) {
      out[i] = Math.max(1, Math.min(100, Math.round((peaks[i] / maxPeak) * 100)))
    }
    return out
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function buildWaveform(audioBuffer, sourceWaveform) {
  const srcArr = toByteArray(sourceWaveform)

  // 1. Source present, already 64 bytes — use verbatim. Byte-for-byte
  //    the same waveform the sender's phone displays.
  if (srcArr && srcArr.length === 64) {
    return { waveform: passthrough64(srcArr), source: 'original-64' }
  }

  // 2. Source present but a different length — resample without stripping.
  if (srcArr && srcArr.length > 1) {
    const r = resampleTo64(srcArr)
    if (r) return { waveform: r, source: 'original-resampled' }
  }

  // 3. No source — derive from the decoded audio.
  try {
    const derived = await deriveWaveformFromAudio(audioBuffer)
    if (derived) return { waveform: derived, source: 'derived' }
  } catch (e) {
    console.error('[VTO] waveform derive failed:', e?.message || e)
  }

  // 4. Nothing worked — random fallback.
  return { waveform: synthesizeWaveform(), source: 'synthesized' }
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
      for await (const chunk of stream) chunks.push(chunk)
      const buffer = Buffer.concat(chunks)

      if (!buffer.length) throw new Error('Empty audio buffer')

      const originalSeconds = Number(audio.seconds) || 1

      await sock.sendPresenceUpdate('recording', target)
      await new Promise(resolve => setTimeout(resolve, originalSeconds * 1000))

      const { waveform, source } = await buildWaveform(buffer, audio.waveform)

      const voiceMessage = {
        audio: buffer,
        mimetype: audio.mimetype || 'audio/ogg; codecs=opus',
        ptt: true,
        seconds: originalSeconds,
        waveform
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
            `ᴡᴀᴠᴇꜰᴏʀᴍ: ${source}`
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
