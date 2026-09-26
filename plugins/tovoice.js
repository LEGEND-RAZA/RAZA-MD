import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  downloadContentFromMessage
} from '@whiskeysockets/baileys'

const execFileAsync = promisify(execFile)

export default {
  command: ['tovn'],

  description:
    'Convert audio/video to voice note',

  async run({
    sock,
    message,
    isOwner
  }) {
    if (!isOwner) return

    const jid =
      message?.key?.remoteJid

    if (!jid) return

    try {
      const context =
        message?.message?.extendedTextMessage?.contextInfo ||
        message?.message?.imageMessage?.contextInfo ||
        message?.message?.videoMessage?.contextInfo ||
        message?.message?.audioMessage?.contextInfo ||
        message?.message?.documentMessage?.contextInfo

      const quoted =
        context?.quotedMessage

      if (!quoted) {
        return await sock.sendMessage(
          jid,
          {
            text:
              '❌ 𝐑ᴇᴘʟʏ 𝐓ᴏ 𝐀ᴜᴅɪᴏ 𝐎ʀ 𝐕ɪᴅᴇᴏ'
          },
          {
            quoted: message
          }
        )
      }

      const audio =
        quoted.audioMessage

      const video =
        quoted.videoMessage

      if (!audio && !video) {
        return await sock.sendMessage(
          jid,
          {
            text:
              '❌ 𝐑ᴇᴘʟʏ 𝐓ᴏ 𝐀ᴜᴅɪᴏ/𝐕ɪᴅᴇᴏ 𝐎ɴʟʏ'
          },
          {
            quoted: message
          }
        )
      }

      const tempDir =
        path.join(
          process.cwd(),
          'tmp'
        )

      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(
          tempDir,
          {
            recursive: true
          }
        )
      }

      const id =
        `${Date.now()}_${Math.random()
          .toString(36)
          .slice(2)}`

      const inputPath =
        path.join(
          tempDir,
          `${id}.input`
        )

      const outputPath =
        path.join(
          tempDir,
          `${id}.ogg`
        )

      const media =
        audio || video

      const mediaType =
        audio ? 'audio' : 'video'

      const stream =
        await downloadContentFromMessage(
          media,
          mediaType
        )

      const chunks = []

      for await (const chunk of stream) {
        chunks.push(chunk)
      }

      fs.writeFileSync(
        inputPath,
        Buffer.concat(chunks)
      )

      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-i',
          inputPath,
          '-vn',
          '-c:a',
          'libopus',
          '-b:a',
          '128k',
          '-application',
          'voip',
          outputPath
        ]
      )

      const output =
        fs.readFileSync(
          outputPath
        )

      await sock.sendMessage(
        jid,
        {
          audio: output,
          mimetype:
            'audio/ogg; codecs=opus',
          ptt: true
        },
        {
          quoted: message
        }
      )

      try {
        fs.unlinkSync(inputPath)
      } catch {}

      try {
        fs.unlinkSync(outputPath)
      } catch {}

    } catch (error) {
      console.error(
        '[TOVN]',
        error?.stack ||
          error?.message ||
          error
      )

      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ 𝐂ᴏɴᴠᴇʀsɪᴏɴ 𝐅ᴀɪʟᴇᴅ'
        },
        {
          quoted: message
        }
      )
    }
  }
}