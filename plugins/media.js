import { downloadMediaMessage } from '@whiskeysockets/baileys'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import ffmpegPathStatic from 'ffmpeg-static'
import sharp from 'sharp'

const execFileAsync = promisify(execFile)
const FFMPEG_PATH = ffmpegPathStatic || 'ffmpeg'

function tempFile(ext) {
  return path.join(os.tmpdir(), `raza-${crypto.randomBytes(8).toString('hex')}.${ext}`)
}

function getQuoted(message) {
  const msg = message.message || {}
  const types = [
    'extendedTextMessage', 'imageMessage', 'videoMessage', 
    'documentMessage', 'audioMessage', 'stickerMessage'
  ]

  for (const type of types) {
    const context = msg[type]?.contextInfo
    if (context?.quotedMessage) {
      return {
        key: {
          remoteJid: message.key.remoteJid,
          fromMe: false,
          id: context.stanzaId,
          participant: context.participant
        },
        message: context.quotedMessage
      }
    }
  }
  return null
}

function getType(msg) {
  return Object.keys(msg?.message || msg || {})[0]
}

export default {
  command: ['download', 'dl', 'sticker', 's', 'toimg', 'tovideo', 'tom3', 'tomp3', 'ocr'],
  category: 'media',
  description: 'Media and message tools',

  async run(ctx) {
    const { sock, message, command, isOwner } = ctx
    const msg = message || ctx.msg
    if (!sock || !msg) return

    const jid = msg.key.remoteJid

    // Owner check
    if (!isOwner) {
      return sock.sendMessage(jid, { text: '❌ ᴏɴʟʏ ᴏᴡɴᴇʀ ᴄᴀɴ ᴜsᴇ ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ' }, { quoted: msg })
    }

    const quoted = getQuoted(msg)
    if (!quoted) {
      return sock.sendMessage(jid, { text: '⚠️ ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴍᴇᴅɪᴀ ᴍᴇssᴀɢᴇ' }, { quoted: msg })
    }

    const type = getType(quoted)

    try {
      // ==============================
      // DOWNLOAD (.dl)
      // ==============================
      if (command === 'download' || command === 'dl') {
        const mediaTypes = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage']
        if (!mediaTypes.includes(type)) {
          return sock.sendMessage(jid, { text: '❌ ʀᴇᴘʟɪᴇᴅ ᴍᴇssᴀɢᴇ ʜᴀs ɴᴏ ᴅᴏᴡɴʟᴏᴀᴅᴀʙʟᴇ ᴍᴇᴅɪᴀ' }, { quoted: msg })
        }

        const buffer = await downloadMediaMessage(quoted, 'buffer', {})
        const media = quoted.message[type]

        if (type === 'imageMessage') {
          await sock.sendMessage(jid, { image: buffer, caption: media.caption || '' }, { quoted: msg })
        }
        if (type === 'videoMessage') {
          await sock.sendMessage(jid, { video: buffer, caption: media.caption || '' }, { quoted: msg })
        }
        if (type === 'audioMessage') {
          await sock.sendMessage(jid, { audio: buffer, mimetype: media.mimetype || 'audio/mp4', ptt: media.ptt || false }, { quoted: msg })
        }
        if (type === 'documentMessage') {
          await sock.sendMessage(jid, { document: buffer, mimetype: media.mimetype || 'application/octet-stream', fileName: media.fileName || 'download' }, { quoted: msg })
        }
        if (type === 'stickerMessage') {
          await sock.sendMessage(jid, { sticker: buffer }, { quoted: msg })
        }
        return
      }

      // ==============================
      // STICKER (.sticker / .s)
      // ==============================
      if (command === 'sticker' || command === 's') {
        if (type !== 'imageMessage' && type !== 'videoMessage') {
          return sock.sendMessage(jid, { text: '⚠️ ʀᴇᴘʟʏ ᴛᴏ ᴀɴ ɪᴍᴀɢᴇ ᴏʀ ᴠɪᴅᴇᴏ' }, { quoted: msg })
        }

        // Check if user provided a custom pack name
        const customPackName = String(ctx.text || '').trim()
        const finalPackName = customPackName ? customPackName : '𝐑ᴀᴢᴀ-𝐌ᴅ'

        const buffer = await downloadMediaMessage(quoted, 'buffer', {})
        let webpBuffer

        if (type === 'imageMessage') {
          // Convert static image to WebP
          webpBuffer = await sharp(buffer)
            .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .webp({ quality: 90, lossless: false })
            .toBuffer()
        } else {
          // Convert video to Animated WebP using FFmpeg
          const input = tempFile('mp4')
          const output = tempFile('webp')
          fs.writeFileSync(input, buffer)

          try {
            await execFileAsync(FFMPEG_PATH, [
              '-y', '-i', input,
              '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,fps=15',
              '-vcodec', 'libwebp_anim', '-lossless', '0', '-compression_level', '6', '-q:v', '75',
              '-loop', '0', '-an', '-vsync', '0', '-t', '6', // Max 6 seconds
              output
            ], { timeout: 60000 })
            webpBuffer = fs.readFileSync(output)
          } finally {
            if (fs.existsSync(input)) fs.unlinkSync(input)
            if (fs.existsSync(output)) fs.unlinkSync(output)
          }
        }

        await sock.sendMessage(jid, {
          sticker: webpBuffer,
          packname: finalPackName,
          author: 'ʟᴇɢᴇɴᴅ ʀᴀᴢᴀ'
        }, { quoted: msg })
        return
      }

      // ==============================
      // STICKER → IMAGE (.toimg)
      // ==============================
      if (command === 'toimg') {
        if (type !== 'stickerMessage') {
          return sock.sendMessage(jid, { text: '⚠️ ʀᴇᴘʟʏ ᴛᴏ ᴀ sᴛɪᴄᴋᴇʀ' }, { quoted: msg })
        }

        const input = tempFile('webp')
        const output = tempFile('png')

        try {
          const buffer = await downloadMediaMessage(quoted, 'buffer', {})
          fs.writeFileSync(input, buffer)

          await execFileAsync(FFMPEG_PATH, ['-y', '-i', input, output], { timeout: 60000 })
          await sock.sendMessage(jid, { image: fs.readFileSync(output) }, { quoted: msg })
        } finally {
          if (fs.existsSync(input)) fs.unlinkSync(input)
          if (fs.existsSync(output)) fs.unlinkSync(output)
        }
        return
      }

      // ==============================
      // STICKER → VIDEO (.tovideo)
      // ==============================
      if (command === 'tovideo') {
        if (type !== 'stickerMessage') {
          return sock.sendMessage(jid, { text: '⚠️ ʀᴇᴘʟʏ ᴛᴏ ᴀɴ ᴀɴɪᴍᴀᴛᴇᴅ sᴛɪᴄᴋᴇʀ' }, { quoted: msg })
        }

        const input = tempFile('webp')
        const output = tempFile('mp4')

        try {
          const buffer = await downloadMediaMessage(quoted, 'buffer', {})
          fs.writeFileSync(input, buffer)

          await execFileAsync(FFMPEG_PATH, [
            '-y', '-i', input, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output
          ], { timeout: 60000 })

          await sock.sendMessage(jid, { video: fs.readFileSync(output), mimetype: 'video/mp4' }, { quoted: msg })
        } finally {
          if (fs.existsSync(input)) fs.unlinkSync(input)
          if (fs.existsSync(output)) fs.unlinkSync(output)
        }
        return
      }

      // ==============================
      // VIDEO → MP3 (.tomp3 / .tom3)
      // ==============================
      if (command === 'tomp3' || command === 'tom3') {
        if (type !== 'videoMessage') {
          return sock.sendMessage(jid, { text: '⚠️ ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴠɪᴅᴇᴏ' }, { quoted: msg })
        }

        const input = tempFile('mp4')
        const output = tempFile('mp3')

        try {
          const buffer = await downloadMediaMessage(quoted, 'buffer', {})
          fs.writeFileSync(input, buffer)

          await execFileAsync(FFMPEG_PATH, [
            '-y', '-i', input, '-vn', '-codec:a', 'libmp3lame', '-q:a', '2', output
          ], { timeout: 60000 })

          await sock.sendMessage(jid, { audio: fs.readFileSync(output), mimetype: 'audio/mpeg', fileName: 'Raza-MD.mp3' }, { quoted: msg })
        } finally {
          if (fs.existsSync(input)) fs.unlinkSync(input)
          if (fs.existsSync(output)) fs.unlinkSync(output)
        }
        return
      }

      // ==============================
      // OCR (.ocr)
      // ==============================
      if (command === 'ocr') {
        if (type !== 'imageMessage') {
          return sock.sendMessage(jid, { text: '⚠️ ʀᴇᴘʟʏ ᴛᴏ ᴀɴ ɪᴍᴀɢᴇ' }, { quoted: msg })
        }

        const buffer = await downloadMediaMessage(quoted, 'buffer', {})
        const input = tempFile('jpg')
        fs.writeFileSync(input, buffer)

        try {
          const { createWorker } = await import('tesseract.js')
          const worker = await createWorker('eng')
          const result = await worker.recognize(input)
          await worker.terminate()

          const text = result?.data?.text?.trim()
          await sock.sendMessage(jid, { 
            text: text ? `📝 ᴏᴄʀ ʀᴇsᴜʟᴛ\n\n${text}` : '❌ ɴᴏ ᴛᴇxᴛ ꜰᴏᴜɴᴅ' 
          }, { quoted: msg })
        } finally {
          if (fs.existsSync(input)) fs.unlinkSync(input)
        }
        return
      }

    } catch (e) {
      console.error(`[Media Error] ${command}:`, e?.message || e)
      await sock.sendMessage(jid, { text: `❌ ꜰᴀɪʟᴇᴅ\n\n${e?.message || e}` }, { quoted: msg })
    }
  }
}
