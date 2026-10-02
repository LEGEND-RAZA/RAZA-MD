import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  downloadContentFromMessage
} from '@whiskeysockets/baileys'

const execFileAsync = promisify(execFile)

function unwrapMessage(message) {
  let current = message

  for (let i = 0; i < 10 && current; i++) {
    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message
      continue
    }

    if (current.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message
      continue
    }

    if (current.viewOnceMessageV2?.message) {
      current = current.viewOnceMessageV2.message
      continue
    }

    if (current.viewOnceMessageV2Extension?.message) {
      current = current.viewOnceMessageV2Extension.message
      continue
    }

    break
  }

  return current || {}
}

export default {
  command: ['tovn'],
  category: 'media',

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

    let inputPath = ''
    let outputPath = ''

    try {
      const msg =
        message?.message || {}

      const context =
        msg?.extendedTextMessage?.contextInfo ||
        msg?.imageMessage?.contextInfo ||
        msg?.videoMessage?.contextInfo ||
        msg?.audioMessage?.contextInfo ||
        msg?.documentMessage?.contextInfo ||
        msg?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo

      let quoted =
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

      quoted =
        unwrapMessage(quoted)

      const audio =
        quoted?.audioMessage

      const video =
        quoted?.videoMessage

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

      fs.mkdirSync(
        tempDir,
        {
          recursive: true
        }
      )

      const id =
        `${Date.now()}_${Math.random()
          .toString(36)
          .slice(2)}`

      inputPath =
        path.join(
          tempDir,
          `${id}.input`
        )

      outputPath =
        path.join(
          tempDir,
          `${id}.ogg`
        )

      const media =
        audio || video

      const mediaType =
        audio
          ? 'audio'
          : 'video'

      const stream =
        await downloadContentFromMessage(
          media,
          mediaType
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
          'Downloaded media is empty'
        )
      }

      fs.writeFileSync(
        inputPath,
        buffer
      )

      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-i',
          inputPath,
          '-vn',
          '-map',
          '0:a:0',
          '-ac',
          '1',
          '-ar',
          '48000',
          '-c:a',
          'libopus',
          '-b:a',
          '64k',
          '-application',
          'voip',
          '-f',
          'ogg',
          outputPath
        ],
        {
          maxBuffer:
            10 * 1024 * 1024
        }
      )

      if (
        !fs.existsSync(outputPath)
      ) {
        throw new Error(
          'FFmpeg did not create output file'
        )
      }

      const output =
        fs.readFileSync(
          outputPath
        )

      if (!output.length) {
        throw new Error(
          'Converted audio is empty'
        )
      }

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

    } catch (error) {
      console.error(
        '[TOVN]',
        error?.stack ||
        error?.message ||
        error
      )

      await sock.sendMessage(
        jid,
        {
          text:
            '❌ 𝐂ᴏɴᴠᴇʀsɪᴏɴ 𝐅ᴀɪʟᴇᴅ'
        },
        {
          quoted: message
        }
      )

    } finally {
      if (inputPath) {
        try {
          fs.unlinkSync(
            inputPath
          )
        } catch {}
      }

      if (outputPath) {
        try {
          fs.unlinkSync(
            outputPath
          )
        } catch {}
      }
    }
  }
}
