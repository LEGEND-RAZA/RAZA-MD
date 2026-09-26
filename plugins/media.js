import {
  downloadMediaMessage
} from '@whiskeysockets/baileys'

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

function tempFile(ext) {
  return path.join(
    os.tmpdir(),
    `raza-${crypto.randomBytes(8).toString('hex')}.${ext}`
  )
}

function getQuoted(message) {
  const msg = message.message || {}

  const types = [
    'extendedTextMessage',
    'imageMessage',
    'videoMessage',
    'documentMessage',
    'audioMessage',
    'stickerMessage'
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
  command: [
    'download',
    'dl',
    'sticker',
    's',
    'toimg',
    'tovideo',
    'tom3',
    'tomp3',
    'ocr'
  ],

  description: 'Media and message tools',

  async run({ sock, message, command, isOwner }) {
    const jid = message.key.remoteJid

    if (!isOwner) {
      return await sock.sendMessage(
        jid,
        {
          text: '❌ 𝐎ɴʟʏ 𝐎ᴡɴᴇʀ 𝐂ᴀɴ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ'
        },
        { quoted: message }
      )
    }

    const quoted = getQuoted(message)

    if (!quoted) {
      return await sock.sendMessage(
        jid,
        {
          text:
            '⚠️ 𝐑ᴇᴘʟʏ 𝐓ᴏ 𝐀 𝐌ᴇᴅɪᴀ 𝐌ᴇssᴀɢᴇ'
        },
        { quoted: message }
      )
    }

    const type = getType(quoted)

    try {

      // ==============================
      // DOWNLOAD
      // ==============================

      if (command === 'download' || command === 'dl') {

        const mediaTypes = [
          'imageMessage',
          'videoMessage',
          'audioMessage',
          'documentMessage',
          'stickerMessage'
        ]

        if (!mediaTypes.includes(type)) {
          return await sock.sendMessage(
            jid,
            {
              text: '❌ 𝐑ᴇᴘʟɪᴇᴅ 𝐌ᴇssᴀɢᴇ 𝐇ᴀs 𝐍ᴏ 𝐃ᴏᴡɴʟᴏᴀᴅᴀʙʟᴇ 𝐌ᴇᴅɪᴀ'
            },
            { quoted: message }
          )
        }

        const buffer = await downloadMediaMessage(
          quoted,
          'buffer',
          {}
        )

        const media = quoted.message[type]

        if (type === 'imageMessage') {
          await sock.sendMessage(
            jid,
            {
              image: buffer,
              caption: media.caption || ''
            },
            { quoted: message }
          )
        }

        if (type === 'videoMessage') {
          await sock.sendMessage(
            jid,
            {
              video: buffer,
              caption: media.caption || ''
            },
            { quoted: message }
          )
        }

        if (type === 'audioMessage') {
          await sock.sendMessage(
            jid,
            {
              audio: buffer,
              mimetype: media.mimetype || 'audio/mp4',
              ptt: media.ptt || false
            },
            { quoted: message }
          )
        }

        if (type === 'documentMessage') {
          await sock.sendMessage(
            jid,
            {
              document: buffer,
              mimetype:
                media.mimetype ||
                'application/octet-stream',
              fileName:
                media.fileName ||
                'download'
            },
            { quoted: message }
          )
        }

        if (type === 'stickerMessage') {
          await sock.sendMessage(
            jid,
            {
              sticker: buffer
            },
            { quoted: message }
          )
        }

        return
      }

      // ==============================
      // STICKER
      // ==============================

      if (
        command === 'sticker' ||
        command === 's'
      ) {

        if (
          type !== 'imageMessage' &&
          type !== 'videoMessage'
        ) {
          return await sock.sendMessage(
            jid,
            {
              text:
                '⚠️ 𝐑ᴇᴘʟʏ 𝐓ᴏ 𝐀ɴ 𝐈ᴍᴀɢᴇ 𝐎ʀ 𝐕ɪᴅᴇᴏ'
            },
            { quoted: message }
          )
        }

        const buffer = await downloadMediaMessage(
          quoted,
          'buffer',
          {}
        )

        await sock.sendMessage(
          jid,
          {
            sticker: buffer
          },
          { quoted: message }
        )

        return
      }

      // ==============================
      // STICKER → IMAGE
      // ==============================

      if (command === 'toimg') {

        if (type !== 'stickerMessage') {
          return await sock.sendMessage(
            jid,
            {
              text:
                '⚠️ 𝐑ᴇᴘʟʏ 𝐓ᴏ 𝐀 𝐒ᴛɪᴄᴋᴇʀ'
            },
            { quoted: message }
          )
        }

        const input = tempFile('webp')
        const output = tempFile('png')

        try {
          const buffer = await downloadMediaMessage(
            quoted,
            'buffer',
            {}
          )

          fs.writeFileSync(input, buffer)

          await execFileAsync(
            'ffmpeg',
            [
              '-y',
              '-i',
              input,
              output
            ]
          )

          await sock.sendMessage(
            jid,
            {
              image: fs.readFileSync(output)
            },
            { quoted: message }
          )

        } finally {
          if (fs.existsSync(input))
            fs.unlinkSync(input)

          if (fs.existsSync(output))
            fs.unlinkSync(output)
        }

        return
      }

      // ==============================
      // STICKER → VIDEO
      // ==============================

      if (command === 'tovideo') {

        if (type !== 'stickerMessage') {
          return await sock.sendMessage(
            jid,
            {
              text:
                '⚠️ 𝐑ᴇᴘʟʏ 𝐓ᴏ 𝐀ɴ 𝐀ɴɪᴍᴀᴛᴇᴅ 𝐒ᴛɪᴄᴋᴇʀ'
            },
            { quoted: message }
          )
        }

        const input = tempFile('webp')
        const output = tempFile('mp4')

        try {
          const buffer = await downloadMediaMessage(
            quoted,
            'buffer',
            {}
          )

          fs.writeFileSync(input, buffer)

          await execFileAsync(
            'ffmpeg',
            [
              '-y',
              '-i',
              input,
              '-c:v',
              'libx264',
              '-pix_fmt',
              'yuv420p',
              '-movflags',
              '+faststart',
              output
            ]
          )

          await sock.sendMessage(
            jid,
            {
              video: fs.readFileSync(output),
              mimetype: 'video/mp4'
            },
            { quoted: message }
          )

        } finally {
          if (fs.existsSync(input))
            fs.unlinkSync(input)

          if (fs.existsSync(output))
            fs.unlinkSync(output)
        }

        return
      }

      // ==============================
      // VIDEO → MP3
      // ==============================

      if (
        command === 'tomp3' ||
        command === 'tom3'
      ) {

        if (type !== 'videoMessage') {
          return await sock.sendMessage(
            jid,
            {
              text:
                '⚠️ 𝐑ᴇᴘʟʏ 𝐓ᴏ 𝐀 𝐕ɪᴅᴇᴏ'
            },
            { quoted: message }
          )
        }

        const input = tempFile('mp4')
        const output = tempFile('mp3')

        try {
          const buffer = await downloadMediaMessage(
            quoted,
            'buffer',
            {}
          )

          fs.writeFileSync(input, buffer)

          await execFileAsync(
            'ffmpeg',
            [
              '-y',
              '-i',
              input,
              '-vn',
              '-codec:a',
              'libmp3lame',
              '-q:a',
              '2',
              output
            ]
          )

          await sock.sendMessage(
            jid,
            {
              audio: fs.readFileSync(output),
              mimetype: 'audio/mpeg',
              fileName: 'Raza-MD.mp3'
            },
            { quoted: message }
          )

        } finally {
          if (fs.existsSync(input))
            fs.unlinkSync(input)

          if (fs.existsSync(output))
            fs.unlinkSync(output)
        }

        return
      }

      // ==============================
      // OCR
      // ==============================

      if (command === 'ocr') {

        if (type !== 'imageMessage') {
          return await sock.sendMessage(
            jid,
            {
              text:
                '⚠️ 𝐑ᴇᴘʟʏ 𝐓ᴏ 𝐀ɴ 𝐈ᴍᴀɢᴇ'
            },
            { quoted: message }
          )
        }

        const buffer = await downloadMediaMessage(
          quoted,
          'buffer',
          {}
        )

        const input = tempFile('jpg')

        fs.writeFileSync(input, buffer)

        try {
          const { createWorker } =
            await import('tesseract.js')

          const worker = await createWorker('eng')

          const result =
            await worker.recognize(input)

          await worker.terminate()

          const text =
            result?.data?.text?.trim()

          await sock.sendMessage(
            jid,
            {
              text: text
                ? `📝 𝐎𝐂𝐑 𝐑ᴇsᴜʟᴛ\n\n${text}`
                : '❌ 𝐍ᴏ 𝐓ᴇxᴛ 𝐅ᴏᴜɴᴅ'
            },
            { quoted: message }
          )

        } finally {
          if (fs.existsSync(input))
            fs.unlinkSync(input)
        }

        return
      }

    } catch (e) {
      console.error(
        `𝐌ᴇᴅɪᴀ 𝐄ʀʀᴏʀ [${command}]:`,
        e?.message || e
      )

      await sock.sendMessage(
        jid,
        {
          text:
            `❌ 𝐅ᴀɪʟᴇᴅ\n\n${e?.message || e}`
        },
        { quoted: message }
      )
    }
  }
}