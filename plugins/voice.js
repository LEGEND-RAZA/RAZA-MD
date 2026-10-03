import { EdgeTTS, listVoices } from 'edge-tts-universal'
import ffmpegPath from 'ffmpeg-static'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

let femaleVoicesCache = null
let femaleVoicesCacheTime = 0

async function getFemaleVoices() {
  if (
    femaleVoicesCache &&
    Date.now() - femaleVoicesCacheTime < 30 * 60 * 1000
  ) {
    return femaleVoicesCache
  }

  const voices = await listVoices()

  femaleVoicesCache = voices.filter(
    voice =>
      String(voice?.Gender || '').toLowerCase() === 'female'
  )

  femaleVoicesCacheTime = Date.now()

  return femaleVoicesCache
}

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

async function generateEdgeVoice(
  text,
  voice,
  output
) {
  const tts = new EdgeTTS(
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
      'Edge TTS returned empty audio'
    )
  }

  await fs.writeFile(
    output,
    audio
  )
}

async function generateTtsAiVoice(
  text,
  output
) {
  const response =
    await fetch(
      'https://api.tts.ai/v1/tts/',
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/json'
        },
        body:
          JSON.stringify({
            model: 'piper',
            voice: 'Aegis',
            text,
            language: 'ur',
            format: 'mp3',
            speed: 1
          })
      }
    )

  if (!response.ok) {
    throw new Error(
      `TTS.ai ${response.status}: ${await response.text()}`
    )
  }

  const contentType =
    response.headers.get(
      'content-type'
    ) || ''

  let audio

  if (
    contentType.includes(
      'application/json'
    )
  ) {
    const job =
      await response.json()

    if (!job?.uuid) {
      throw new Error(
        'TTS.ai job ID missing'
      )
    }

    let result = null

    for (
      let i = 0;
      i < 40;
      i++
    ) {
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
          'TTS.ai generation failed'
        )
      }
    }

    if (!result?.result_url) {
      throw new Error(
        'TTS.ai generation timed out'
      )
    }

    const audioResponse =
      await fetch(
        result.result_url
      )

    if (!audioResponse.ok) {
      throw new Error(
        'Failed to download TTS.ai audio'
      )
    }

    audio =
      Buffer.from(
        await audioResponse.arrayBuffer()
      )
  } else {
    audio =
      Buffer.from(
        await response.arrayBuffer()
      )
  }

  if (!audio.length) {
    throw new Error(
      'TTS.ai returned empty audio'
    )
  }

  await fs.writeFile(
    output,
    audio
  )
}

function isUrduVoice(voice) {
  const locale =
    String(
      voice?.Locale ||
      voice?.locale ||
      ''
    ).toLowerCase()

  const language =
    String(
      voice?.Language ||
      voice?.language ||
      ''
    ).toLowerCase()

  return (
    locale.startsWith('ur-') ||
    language.startsWith('ur')
  )
}

function findFemaleVoice(
  voices,
  query
) {
  const value =
    query
      .toLowerCase()
      .replace(
        /[^a-z0-9-]/g,
        ''
      )

  return voices.find(
    voice =>
      voice.ShortName
        ?.toLowerCase()
        .replace(
          /[^a-z0-9-]/g,
          ''
        ) === value
  ) ||
    voices.find(
      voice =>
        voice.FriendlyName
          ?.toLowerCase()
          .replace(
            /[^a-z0-9-]/g,
            ''
          )
          .includes(value)
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
    'Female AI voice generator',

  async run({
    sock,
    message,
    args,
    command
  }) {
    const jid =
      message?.key?.remoteJid

    if (!jid) return

    const first =
      args?.[0]
        ?.trim()
        ?.toLowerCase()

    /*
     * ALL FEMALE VOICES
     *
     * .voices <text>
     *
     * FIRST VOICE:
     * sentence only
     *
     * EVERY OTHER VOICE:
     * voice name + sentence
     *
     * EVERY VOICE RECEIVES
     * THE COMPLETE TEXT.
     */

    if (
      command === 'voices' ||
      first === 'all'
    ) {
      const text =
        command === 'voices'
          ? args?.join(' ')?.trim()
          : args
              ?.slice(1)
              ?.join(' ')
              ?.trim()

      if (!text) {
        return await sock.sendMessage(
          jid,
          {
            text:
              '❌ ᴜsᴀɢᴇ:\n\n' +
              '.ᴠᴏɪᴄᴇs ᴍᴜᴊʜᴇ ᴀᴀᴘ sᴇ ᴇᴋ ʙᴀᴀᴛ ᴋᴀʀɴɪ ʜᴀɪ'
          },
          {
            quoted: message
          }
        )
      }

      if (text.length > 300) {
        return await sock.sendMessage(
          jid,
          {
            text:
              '❌ ᴍᴀxɪᴍᴜᴍ 300 ᴄʜᴀʀᴀᴄᴛᴇʀs ᴀʟʟᴏᴡᴇᴅ ғᴏʀ ᴍᴜʟᴛɪ-ᴠᴏɪᴄᴇ ᴛᴇsᴛ.'
          },
          {
            quoted: message
          }
        )
      }

      let edgeVoices = []

      try {
        edgeVoices =
          await getFemaleVoices()
      } catch (error) {
        console.error(
          '[EDGE VOICES]',
          error?.message || error
        )
      }

      const voices = [
        {
          id: 'aegis',
          name: 'Aegis',
          provider: 'tts.ai',
          locale: 'ur'
        },
        ...edgeVoices.map(
          voice => ({
            id:
              voice.ShortName,
            name:
              voice.FriendlyName ||
              voice.ShortName,
            provider:
              'edge',
            locale:
              voice.Locale
          })
        )
      ]

      if (!voices.length) {
        return await sock.sendMessage(
          jid,
          {
            text:
              '❌ ɴᴏ ғᴇᴍᴀʟᴇ ᴠᴏɪᴄᴇs ғᴏᴜɴᴅ.'
          },
          {
            quoted: message
          }
        )
      }

      for (
        let index = 0;
        index < voices.length;
        index++
      ) {
        const voice =
          voices[index]

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
           * EXACT BEHAVIOUR:
           *
           * 1st:
           * "sentence"
           *
           * 2nd:
           * "voice name. sentence"
           *
           * 3rd:
           * "voice name. sentence"
           *
           * 4th:
           * "voice name. sentence"
           */

          let speechText =
            index === 0
              ? text
              : `${voice.name}. ${text}`

          /*
           * Convert Roman Urdu
           * only when the selected
           * voice is Urdu.
           */

          if (
            voice.provider ===
              'tts.ai' ||
            isUrduVoice({
              Locale:
                voice.locale
            })
          ) {
            speechText =
              await romanToUrdu(
                speechText
              )
          }

          /*
           * Generate the COMPLETE
           * speechText for every voice.
           */

          if (
            voice.provider ===
            'tts.ai'
          ) {
            await generateTtsAiVoice(
              speechText,
              inputFile
            )
          } else {
            await generateEdgeVoice(
              speechText,
              voice.id,
              inputFile
            )
          }

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
            `[VOICE:${voice.id}]`,
            error?.message ||
              error
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

      return
    }

    /*
     * VOICE LIST
     */

    if (
      first === 'list'
    ) {
      try {
        const voices =
          await getFemaleVoices()

        let output =
          '𝐑ᴀᴢᴀ 𝐌ᴅ 𝐅ᴇᴍᴀʟᴇ 𝐕ᴏɪᴄᴇs\n\n'

        output +=
          '01. Aegis — TTS.ai\n'

        let number = 2

        for (
          const voice of voices
        ) {
          output +=
            `${String(number).padStart(2, '0')}. ` +
            `${voice.ShortName} — ` +
            `${voice.Locale}\n`

          number++

          if (
            output.length >
            6000
          ) {
            output +=
              '\n... ʟɪsᴛ ᴛʀᴜɴᴄᴀᴛᴇᴅ'
            break
          }
        }

        return await sock.sendMessage(
          jid,
          {
            text:
              output +
              '\n\nᴜsᴀɢᴇ:\n' +
              '.ᴠᴏɪᴄᴇ <ᴠᴏɪᴄᴇ> <ᴛᴇxᴛ>\n' +
              '.ᴠᴏɪᴄᴇs <ᴛᴇxᴛ> — ᴛᴇsᴛ ᴀʟʟ'
          },
          {
            quoted: message
          }
        )
      } catch (error) {
        return await sock.sendMessage(
          jid,
          {
            text:
              '❌ ᴠᴏɪᴄᴇ ʟɪsᴛ ғᴀɪʟᴇᴅ\n\n' +
              `${error?.message || error}`
          },
          {
            quoted: message
          }
        )
      }
    }

    /*
     * SINGLE VOICE
     */

    if (!first) {
      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ ᴘʟᴇᴀsᴇ sᴇʟᴇᴄᴛ ᴀ ғᴇᴍᴀʟᴇ ᴠᴏɪᴄᴇ.\n\n' +
            'ᴜsᴇ:\n' +
            '.ᴠᴏɪᴄᴇs\n' +
            '.ᴠᴏɪᴄᴇ <ᴠᴏɪᴄᴇ> <ᴛᴇxᴛ>'
        },
        {
          quoted: message
        }
      )
    }

    const text =
      args
        ?.slice(1)
        ?.join(' ')
        ?.trim()

    if (!text) {
      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ ᴘʟᴇᴀsᴇ ᴘʀᴏᴠɪᴅᴇ ᴛᴇxᴛ.'
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
      let speechText

      if (
        first === 'aegis'
      ) {
        speechText =
          await romanToUrdu(text)

        await generateTtsAiVoice(
          speechText,
          inputFile
        )
      } else {
        const voices =
          await getFemaleVoices()

        const selected =
          findFemaleVoice(
            voices,
            first
          )

        if (!selected) {
          return await sock.sendMessage(
            jid,
            {
              text:
                '❌ ᴛʜɪs ғᴇᴍᴀʟᴇ ᴠᴏɪᴄᴇ ᴡᴀs ɴᴏᴛ ғᴏᴜɴᴅ.\n\n' +
                'ᴜsᴇ .ᴠᴏɪᴄᴇs ʟɪsᴛ'
            },
            {
              quoted: message
            }
          )
        }

        speechText =
          isUrduVoice(selected)
            ? await romanToUrdu(text)
            : text

        await generateEdgeVoice(
          speechText,
          selected.ShortName,
          inputFile
        )
      }

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
