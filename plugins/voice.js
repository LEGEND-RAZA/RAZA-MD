import ffmpegPath from 'ffmpeg-static'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

function convertToOpus(input, output) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, [
      '-y',
      '-i', input,
      '-vn',
      '-ar', '48000',
      '-ac', '1',
      '-c:a', 'libopus',
      '-b:a', '32k',
      '-application', 'voip',
      '-avoid_negative_ts', 'make_zero',
      '-map_metadata', '-1',
      '-f', 'ogg',
      output
    ])

    let errorOutput = ''

    ffmpeg.stderr.on('data', data => {
      errorOutput += data.toString()
    })

    ffmpeg.on('error', reject)

    ffmpeg.on('close', code => {
      if (code === 0) {
        resolve()
      } else {
        reject(
          new Error(
            errorOutput ||
            `FFmpeg exited with code ${code}`
          )
        )
      }
    })
  })
}

export default {
  command: ['voice', 'tts'],
  category: 'ai',
  description: 'Generate natural female AI voice',

  async run({
    sock,
    message,
    args
  }) {
    const jid =
      message?.key?.remoteJid

    if (!jid) return

    const text =
      args?.join(' ')?.trim()

    if (!text) {
      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ ᴘʟᴇᴀsᴇ ᴘʀᴏᴠɪᴅᴇ sᴏᴍᴇ ᴛᴇxᴛ.\n\n' +
            'ᴜsᴀɢᴇ:\n' +
            '.ᴠᴏɪᴄᴇ ʜᴇʟʟᴏ, ʜᴏᴡ ᴀʀᴇ ʏᴏᴜ?'
        },
        { quoted: message }
      )
    }

    if (text.length > 500) {
      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ ᴍᴀxɪᴍᴜᴍ 500 ᴄʜᴀʀᴀᴄᴛᴇʀs ᴀʟʟᴏᴡᴇᴅ.'
        },
        { quoted: message }
      )
    }

    const id =
      `${Date.now()}_${Math.random().toString(36).slice(2)}`

    const inputFile =
      path.join(
        os.tmpdir(),
        `raza-voice-${id}.mp3`
      )

    const outputFile =
      path.join(
        os.tmpdir(),
        `raza-voice-${id}.ogg`
      )

    try {
      await sock.sendMessage(
        jid,
        {
          text:
            '🎙️ ɢᴇɴᴇʀᴀᴛɪɴɢ ᴠᴏɪᴄᴇ...'
        },
        { quoted: message }
      )

      const response =
        await fetch(
          'https://api.tts.ai/v1/tts/',
          {
            method: 'POST',
            headers: {
              'Content-Type':
                'application/json'
            },
            body: JSON.stringify({
              model: 'kokoro',
              voice: 'af_bella',
              text,
              format: 'mp3',
              speed: 1
            })
          }
        )

      if (!response.ok) {
        throw new Error(
          `TTS API returned ${response.status}`
        )
      }

      const job =
        await response.json()

      if (!job?.uuid) {
        throw new Error(
          'TTS job ID was not returned'
        )
      }

      let result = null

      for (let i = 0; i < 40; i++) {
        await new Promise(
          resolve =>
            setTimeout(resolve, 1500)
        )

        const statusResponse =
          await fetch(
            `https://api.tts.ai/v1/speech/results/?uuid=${encodeURIComponent(job.uuid)}`
          )

        if (!statusResponse.ok) continue

        const status =
          await statusResponse.json()

        if (
          status.status ===
          'completed'
        ) {
          result = status
          break
        }

        if (
          status.status ===
          'failed'
        ) {
          throw new Error(
            status.error ||
            'TTS generation failed'
          )
        }
      }

      if (!result?.result_url) {
        throw new Error(
          'TTS generation timed out'
        )
      }

      const audioResponse =
        await fetch(
          result.result_url
        )

      if (!audioResponse.ok) {
        throw new Error(
          'Failed to download TTS audio'
        )
      }

      const mp3 =
        Buffer.from(
          await audioResponse.arrayBuffer()
        )

      if (!mp3.length) {
        throw new Error(
          'TTS returned empty audio'
        )
      }

      await fs.writeFile(
        inputFile,
        mp3
      )

      await convertToOpus(
        inputFile,
        outputFile
      )

      const opus =
        await fs.readFile(
          outputFile
        )

      if (!opus.length) {
        throw new Error(
          'Opus conversion returned empty audio'
        )
      }

      await sock.sendMessage(
        jid,
        {
          audio: opus,
          mimetype:
            'audio/ogg; codecs=opus',
          ptt: true
        },
        { quoted: message }
      )

    } catch (error) {
      console.error(
        '[VOICE]',
        error?.message || error
      )

      await sock.sendMessage(
        jid,
        {
          text:
            '❌ ᴠᴏɪᴄᴇ ɢᴇɴᴇʀᴀᴛɪᴏɴ ғᴀɪʟᴇᴅ\n\n' +
            `${error?.message || error}`
        },
        { quoted: message }
      )
    } finally {
      await fs
        .unlink(inputFile)
        .catch(() => {})

      await fs
        .unlink(outputFile)
        .catch(() => {})
    }
  }
}
