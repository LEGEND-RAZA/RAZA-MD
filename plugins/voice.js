import { EdgeTTS } from 'edge-tts-universal'
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

    const converted = data[1]
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
      '[ROMAN URDU]',
      error?.message || error
    )

    return text
  }
}

function convertToOpus(input, output) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, [
      '-y',
      '-i',
      input,
      '-vn',
      '-ar',
      '48000',
      '-ac',
      '1',
      '-c:a',
      'libopus',
      '-b:a',
      '32k',
      '-application',
      'voip',
      '-avoid_negative_ts',
      'make_zero',
      '-map_metadata',
      '-1',
      '-f',
      'ogg',
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

async function generateVoice(
  text,
  voice,
  output
) {
  const tts =
    new EdgeTTS(
      text,
      voice
    )

  const result =
    await tts.synthesize()

  const audio =
    Buffer.from(
      await result.audio.arrayBuffer()
    )

  if (!audio.length) {
    throw new Error(
      'TTS returned empty audio'
    )
  }

  await fs.writeFile(
    output,
    audio
  )
}

async function createVoiceNote(
  input,
  output
) {
  await convertToOpus(
    input,
    output
  )

  const audio =
    await fs.readFile(output)

  if (!audio.length) {
    throw new Error(
      'Opus audio is empty'
    )
  }

  return audio
}

async function sendVoice(
  sock,
  jid,
  message,
  audio
) {
  await sock.sendMessage(
    jid,
    {
      audio,
      mimetype:
        'audio/ogg; codecs=opus',
      ptt: true
    },
    {
      quoted: message
    }
  )
}

export default {
  command: [
    'voice',
    'tts',
    'voices'
  ],

  category: 'ai',

  description:
    'Pakistani Urdu female AI voice',

  async run({
    sock,
    message,
    args,
    command
  }) {
    const jid =
      message?.key?.remoteJid

    if (!jid) return

    const voice = {
      id: 'ur-PK-UzmaNeural',
      name: 'Uzma',
      language: 'ur-PK'
    }

    /*
     * .voices <text>
     * .voice <text>
     * .tts <text>
     *
     * All commands use the same
     * Pakistani Urdu female voice.
     */

    let text = ''

    if (
      command === 'voices' ||
      command === 'voice' ||
      command === 'tts'
    ) {
      text =
        args
          ?.join(' ')
          ?.trim()
    }

    if (!text) {
      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ ᴜsᴀɢᴇ:\n\n' +
            '.ᴠᴏɪᴄᴇs <ᴛᴇxᴛ>\n' +
            '.ᴠᴏɪᴄᴇ <ᴛᴇxᴛ>\n' +
            '.ᴛᴛs <ᴛᴇxᴛ>'
        },
        {
          quoted: message
        }
      )
    }

    if (text.length > 500) {
      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ ᴍᴀxɪᴍᴜᴍ 500 ᴄʜᴀʀᴀᴄᴛᴇʀs ᴀʟʟᴏᴡᴇᴅ.'
        },
        {
          quoted: message
        }
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
      /*
       * Convert Roman Urdu to
       * Urdu script first.
       *
       * Only the actual sentence
       * is converted.
       */

      const speechText =
        await romanToUrdu(text)

      /*
       * IMPORTANT:
       *
       * The COMPLETE sentence is
       * sent to Uzma.
       *
       * No voice name is added.
       */

      console.log(
        `[VOICE:${voice.name}]`,
        speechText
      )

      await generateVoice(
        speechText,
        voice.id,
        inputFile
      )

      const audio =
        await createVoiceNote(
          inputFile,
          outputFile
        )

      await sendVoice(
        sock,
        jid,
        message,
        audio
      )
    } catch (error) {
      console.error(
        '[VOICE]',
        error?.message ||
          error
      )

      await sock.sendMessage(
        jid,
        {
          text:
            '❌ ᴠᴏɪᴄᴇ ɢᴇɴᴇʀᴀᴛɪᴏɴ ғᴀɪʟᴇᴅ\n\n' +
            `${error?.message || error}`
        },
        {
          quoted: message
        }
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
