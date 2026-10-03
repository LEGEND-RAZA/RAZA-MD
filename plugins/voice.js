import ffmpegPath from 'ffmpeg-static'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

function isRomanText(text) {
  return /^[\x00-\x7F\s\d.,!?'"()\-_:;@#$%&*+/=]+$/.test(text)
}

async function romanToUrdu(text) {
  if (!text || !isRomanText(text)) {
    return text
  }

  try {
    const url =
      'https://inputtools.google.com/request' +
      `?text=${encodeURIComponent(text)}` +
      '&itc=ur-t-i0-und' +
      '&num=1' +
      '&cp=0' +
      '&cs=1' +
      '&ie=utf-8' +
      '&oe=utf-8' +
      '&app=chat'

    const response = await fetch(url)

    if (!response.ok) {
      return text
    }

    const data = await response.json()

    if (
      data?.[0] !== 'SUCCESS' ||
      !Array.isArray(data?.[1])
    ) {
      return text
    }

    const converted =
      data[1]
        .map(item =>
          Array.isArray(item?.[1])
            ? item[1][0]
            : ''
        )
        .filter(Boolean)
        .join(' ')

    return converted || text

  } catch (error) {
    console.error(
      '[ROMAN URDU] Error:',
      error?.message || error
    )

    return text
  }
}

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

    ffmpeg.stderr.on(
      'data',
      data => {
        errorOutput += data.toString()
      }
    )

    ffmpeg.on(
      'error',
      reject
    )

    ffmpeg.on(
      'close',
      code => {
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
      }
    )
  })
}

export default {
  command: ['voice', 'tts'],
  category: 'ai',
  description:
    'Generate natural Urdu female AI voice',

  async run({
    sock,
    message,
    args
  }) {
    const jid =
      message?.key?.remoteJid

    if (!jid) return

    const text =
      args
        ?.join(' ')
        ?.trim()

    if (!text) {
      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ ᴘʟᴇᴀsᴇ ᴘʀᴏᴠɪᴅᴇ sᴏᴍᴇ ᴛᴇxᴛ.\n\n' +
            'ᴜsᴀɢᴇ:\n' +
            '.ᴠᴏɪᴄᴇ ᴍᴜᴊʜᴇ ᴀᴀᴘ sᴇ ᴇᴋ ʙᴀᴀᴛ ᴋᴀʀɴɪ ʜᴀɪ'
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
      `${Date.now()}_${Math.random()
        .toString(36)
        .slice(2)}`

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
            '🎙️ ᴜʀᴅᴜ ғᴇᴍᴀʟᴇ ᴠᴏɪᴄᴇ ɢᴇɴᴇʀᴀᴛɪɴɢ...'
        },
        { quoted: message }
      )

      const urduText =
        await romanToUrdu(text)

      /*
       * Always use Aegis.
       * Aegis = Urdu Female
       * Fasih = Urdu Male
       */
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
              model: 'piper',
              voice: 'Aegis',
              text: urduText,
              language: 'ur',
              format: 'mp3',
              speed: 1.0
            })
          }
        )

      if (!response.ok) {
        const errorText =
          await response.text()

        throw new Error(
          `TTS API ${response.status}: ${errorText}`
        )
      }

      const contentType =
        response.headers.get(
          'content-type'
        ) || ''

      let mp3

      if (
        contentType.includes(
          'application/json'
        )
      ) {
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
              setTimeout(
                resolve,
                1500
              )
          )

          const statusResponse =
            await fetch(
              `https://api.tts.ai/v1/speech/results/?uuid=${encodeURIComponent(job.uuid)}`
            )

          if (!statusResponse.ok) {
            continue
          }

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

        mp3 =
          Buffer.from(
            await audioResponse.arrayBuffer()
          )
      } else {
        mp3 =
          Buffer.from(
            await response.arrayBuffer()
          )
      }

      if (!mp3?.length) {
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
        '[VOICE] Error:',
        error?.message || error
      )

      await sock.sendMessage(
        jid,
        {
          text:
            '❌ ᴜʀᴅᴜ ғᴇᴍᴀʟᴇ ᴠᴏɪᴄᴇ ғᴀɪʟᴇᴅ\n\n' +
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
