import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import ffmpegPath from 'ffmpeg-static'

const API_BASE = 'https://tryvoicely.com'

async function getVoices(apiKey) {
  const response = await fetch(
    `${API_BASE}/v1/voices`,
    {
      headers: {
        'xi-api-key': apiKey
      }
    }
  )

  if (!response.ok) {
    throw new Error(
      `${response.status} ${await response.text()}`
    )
  }

  const data = await response.json()

  return Array.isArray(data)
    ? data
    : data?.voices || []
}

async function generateVoice(
  apiKey,
  voiceId,
  text,
  languageCode
) {
  const response = await fetch(
    `${API_BASE}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID()
      },
      body: JSON.stringify({
        text,
        model_id: 'voicely-flash-v1',
        language_code: languageCode
      })
    }
  )

  if (!response.ok) {
    throw new Error(
      `${response.status} ${await response.text()}`
    )
  }

  const audio =
    Buffer.from(
      await response.arrayBuffer()
    )

  if (!audio.length) {
    throw new Error(
      'Voicely returned empty audio'
    )
  }

  return audio
}

function convertToOpus(
  input,
  output
) {
  return new Promise(
    (resolve, reject) => {
      const ffmpeg =
        spawn(
          ffmpegPath,
          [
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
          ]
        )

      let errorOutput = ''

      ffmpeg.stderr.on(
        'data',
        data => {
          errorOutput +=
            data.toString()
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
    }
  )
}

function getFemaleVoices(
  voices
) {
  return voices.filter(
    voice =>
      String(
        voice?.gender || ''
      ).toLowerCase() === 'female'
  )
}

function findVoice(
  voices,
  input
) {
  const value =
    String(
      input || ''
    )
      .trim()
      .toLowerCase()

  if (!value) {
    return null
  }

  const femaleVoices =
    getFemaleVoices(voices)

  const number =
    Number(value)

  if (
    Number.isInteger(number) &&
    number >= 1
  ) {
    return (
      femaleVoices[number - 1] ||
      null
    )
  }

  return (
    femaleVoices.find(
      voice => {
        const id =
          String(
            voice?.voice_id ||
            voice?.id ||
            ''
          ).toLowerCase()

        const name =
          String(
            voice?.name ||
            ''
          ).toLowerCase()

        return (
          id === value ||
          name === value
        )
      }
    ) ||
    null
  )
}

function getLanguage(
  voice,
  text
) {
  const voiceId =
    voice?.voice_id ||
    voice?.id ||
    ''

  if (
    voiceId === 'vly_f08'
  ) {
    return 'ur'
  }

  const languages =
    Array.isArray(
      voice?.languages
    )
      ? voice.languages.map(
          x =>
            String(x)
              .toLowerCase()
        )
      : []

  const romanUrdu =
    /(?:hai|hain|ho|hu|houn|mujhe|mujh|aap|ap|tum|main|mein|mera|meri|mere|kaise|kese|kyun|kya|acha|achha|nahi|nahin|aur|se|ko|ke|ki|ka|ye|ya|woh|wo|ek|baat|kar|karo|karta|karti|karen|raha|rahi|rahe|sakta|sakti|sakte)\b/i
      .test(text)

  if (
    romanUrdu &&
    languages.includes('ur')
  ) {
    return 'ur'
  }

  return 'en'
}

export default {
  command: [
    'voice',
    'voices'
  ],

  category: 'ai',

  description:
    'Voicely AI female voice generator',

  async run({
    sock,
    message,
    args,
    command
  }) {
    const jid =
      message?.key?.remoteJid

    if (!jid) return

    const apiKey =
      process.env.VOICELY_API_KEY

    if (!apiKey) {
      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ ᴠᴏɪᴄᴇʟʏ ᴀᴘɪ ᴋᴇʏ ɴᴏᴛ sᴇᴛ.\n\n' +
            'ᴜsᴇ:\n' +
            '.sᴇᴛᴠᴀʀ ᴠᴏɪᴄᴇʟʏ_ᴀᴘɪ_ᴋᴇʏ <ᴋᴇʏ>'
        },
        {
          quoted: message
        }
      )
    }

    if (command === 'voices') {
      try {
        const voices =
          await getVoices(
            apiKey
          )

        const femaleVoices =
          getFemaleVoices(
            voices
          )

        if (!femaleVoices.length) {
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

        const lines =
          femaleVoices.map(
            (voice, index) => {
              const id =
                voice?.voice_id ||
                voice?.id ||
                'unknown'

              const name =
                voice?.name ||
                id

              const style =
                voice?.style
                  ? `\n    sᴛʏʟᴇ: ${voice.style}`
                  : ''

              const urdu =
                id === 'vly_f08'
                  ? '\n    ᴜʀᴅᴜ: ✓'
                  : ''

              return (
                `${String(
                  index + 1
                ).padStart(2, '0')}. ${name}\n` +
                `    ɪᴅ: ${id}` +
                urdu +
                style
              )
            }
          )

        return await sock.sendMessage(
          jid,
          {
            text:
              '𝐑ᴀᴢᴀ 𝐌ᴅ 𝐅ᴇᴍᴀʟᴇ 𝐕ᴏɪᴄᴇs\n\n' +
              lines.join('\n\n') +
              '\n\n' +
              'ᴜsᴀɢᴇ:\n' +
              '.ᴠᴏɪᴄᴇ 1 <sᴇɴᴛᴇɴᴄᴇ>\n' +
              '.ᴠᴏɪᴄᴇ 2 <sᴇɴᴛᴇɴᴄᴇ>\n\n' +
              'ᴏʀ:\n' +
              '.ᴠᴏɪᴄᴇ <ɴᴀᴍᴇ> <sᴇɴᴛᴇɴᴄᴇ>'
          },
          {
            quoted: message
          }
        )
      } catch (error) {
        console.error(
          '[VOICELY VOICES]',
          error?.message || error
        )

        return await sock.sendMessage(
          jid,
          {
            text:
              '❌ ᴄᴏᴜʟᴅ ɴᴏᴛ ғᴇᴛᴄʜ ᴠᴏɪᴄᴇs.\n\n' +
              `${error?.message || error}`
          },
          {
            quoted: message
          }
        )
      }
    }

    const voiceInput =
      args?.[0]?.trim()

    const text =
      args
        ?.slice(1)
        ?.join(' ')
        ?.trim()

    if (
      !voiceInput ||
      !text
    ) {
      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ ᴜsᴀɢᴇ:\n\n' +
            '.ᴠᴏɪᴄᴇs\n' +
            '.ᴠᴏɪᴄᴇ 1 <sᴇɴᴛᴇɴᴄᴇ>\n' +
            '.ᴠᴏɪᴄᴇ 2 <sᴇɴᴛᴇɴᴄᴇ>\n\n' +
            'ᴏʀ:\n' +
            '.ᴠᴏɪᴄᴇ <ɴᴀᴍᴇ> <sᴇɴᴛᴇɴᴄᴇ>'
        },
        {
          quoted: message
        }
      )
    }

    if (text.length > 1000) {
      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ ᴍᴀxɪᴍᴜᴍ 1000 ᴄʜᴀʀᴀᴄᴛᴇʀs ᴀʟʟᴏᴡᴇᴅ.'
        },
        {
          quoted: message
        }
      )
    }

    let mp3File = null
    let oggFile = null

    try {
      const voices =
        await getVoices(
          apiKey
        )

      const selected =
        findVoice(
          voices,
          voiceInput
        )

      if (!selected) {
        return await sock.sendMessage(
          jid,
          {
            text:
              '❌ ᴠᴏɪᴄᴇ ɴᴏᴛ ғᴏᴜɴᴅ.\n\n' +
              'ᴜsᴇ .ᴠᴏɪᴄᴇs ᴛᴏ sᴇᴇ ᴛʜᴇ ᴠᴏɪᴄᴇ ɴᴜᴍʙᴇʀs.'
          },
          {
            quoted: message
          }
        )
      }

      const voiceId =
        selected?.voice_id ||
        selected?.id

      const languageCode =
        getLanguage(
          selected,
          text
        )

      console.log(
        `[VOICELY] Voice: ${voiceId} | Language: ${languageCode}`
      )

      const audio =
        await generateVoice(
          apiKey,
          voiceId,
          text,
          languageCode
        )

      const fileId =
        `${Date.now()}_${Math.random()
          .toString(36)
          .slice(2)}`

      mp3File =
        path.join(
          os.tmpdir(),
          `raza-voicely-${fileId}.mp3`
        )

      oggFile =
        path.join(
          os.tmpdir(),
          `raza-voicely-${fileId}.ogg`
        )

      await fs.writeFile(
        mp3File,
        audio
      )

      await convertToOpus(
        mp3File,
        oggFile
      )

      const voiceNote =
        await fs.readFile(
          oggFile
        )

      if (!voiceNote.length) {
        throw new Error(
          'Converted audio is empty'
        )
      }

      await sock.sendMessage(
        jid,
        {
          audio: voiceNote,
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
        '[VOICELY]',
        error?.message || error
      )

      return await sock.sendMessage(
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
      if (mp3File) {
        await fs
          .unlink(mp3File)
          .catch(() => {})
      }

      if (oggFile) {
        await fs
          .unlink(oggFile)
          .catch(() => {})
      }
    }
  }
}
