import { EdgeTTS, listVoices } from 'edge-tts-universal'
import ffmpegPath from 'ffmpeg-static'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const TTS_AI_VOICES = {
  aegis: {
    name: 'Aegis',
    provider: 'tts.ai',
    language: 'Urdu',
    female: true
  }
}

let edgeVoicesCache = null
let edgeVoicesCacheTime = 0

async function getFemaleVoices() {
  if (
    edgeVoicesCache &&
    Date.now() - edgeVoicesCacheTime < 30 * 60 * 1000
  ) {
    return edgeVoicesCache
  }

  const voices = await listVoices()

  edgeVoicesCache =
    voices.filter(
      voice =>
        voice?.Gender === 'Female'
    )

  edgeVoicesCacheTime = Date.now()

  return edgeVoicesCache
}

async function romanToUrdu(text) {
  if (!text) return text

  if (!/^[\x00-\x7F\s\d.,!?'"()\-_:;@#$%&*+/=]+$/.test(text)) {
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
  } catch {
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

async function edgeTTS(text, voice, output) {
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
      'Edge TTS returned empty audio'
    )
  }

  await fs.writeFile(
    output,
    audio
  )
}

async function ttsAi(text, output) {
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
    const error =
      await response.text()

    throw new Error(
      `TTS.ai ${response.status}: ${error}`
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

function findEdgeVoice(
  voices,
  query
) {
  const value =
    query
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')

  return voices.find(
    voice =>
      voice.ShortName
        ?.toLowerCase()
        .replace(/[^a-z0-9-]/g, '') ===
      value
  ) ||
    voices.find(
      voice =>
        voice.FriendlyName
          ?.toLowerCase()
          .replace(/[^a-z0-9-]/g, '')
          .includes(value)
    )
}

function smallCaps(text) {
  const map = {
    A:'ᴀ',B:'ʙ',C:'ᴄ',D:'ᴅ',E:'ᴇ',
    F:'ғ',G:'ɢ',H:'ʜ',I:'ɪ',J:'ᴊ',
    K:'ᴋ',L:'ʟ',M:'ᴍ',N:'ɴ',O:'ᴏ',
    P:'ᴘ',Q:'ǫ',R:'ʀ',S:'s',T:'ᴛ',
    U:'ᴜ',V:'ᴠ',W:'ᴡ',X:'x',Y:'ʏ',Z:'ᴢ'
  }

  return text
    .split('')
    .map(char =>
      map[char.toUpperCase()] ||
      char
    )
    .join('')
}

async function sendVoice(
  sock,
  jid,
  message,
  mp3File,
  id
) {
  const opusFile =
    path.join(
      os.tmpdir(),
      `raza-voice-${id}.ogg`
    )

  try {
    await convertToOpus(
      mp3File,
      opusFile
    )

    const audio =
      await fs.readFile(
        opusFile
      )

    if (!audio.length) {
      throw new Error(
        'Opus conversion returned empty audio'
      )
    }

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
  } finally {
    await fs
      .unlink(opusFile)
      .catch(() => {})
  }
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

    if (
      command === 'voices' ||
      first === 'list'
    ) {
      try {
        const voices =
          await getFemaleVoices()

        let output =
          '𝐑ᴀᴢᴀ 𝐌ᴅ 𝐅ᴇᴍᴀʟᴇ 𝐀ɪ 𝐕ᴏɪᴄᴇs\n\n'

        output +=
          '「 ᴛᴛs.ᴀɪ 」\n'

        output +=
          '01. ᴀᴇɢɪs — ᴜʀᴅᴜ\n\n'

        output +=
          '「 ᴇᴅɢᴇ ᴛᴛs 」\n'

        const urdu =
          voices.filter(
            voice =>
              voice.Locale
                ?.toLowerCase()
                .startsWith('ur-')
          )

        const other =
          voices.filter(
            voice =>
              !voice.Locale
                ?.toLowerCase()
                .startsWith('ur-')
          )

        let number = 2

        for (
          const voice of urdu
        ) {
          output +=
            `${String(number).padStart(2,'0')}. ` +
            `${voice.ShortName} — ` +
            `${voice.Locale}\n`

          number++
        }

        output +=
          '\n「 ᴏᴛʜᴇʀ ᴇᴅɢᴇ ғᴇᴍᴀʟᴇ ᴠᴏɪᴄᴇs 」\n\n'

        for (
          const voice of other
        ) {
          output +=
            `${String(number).padStart(2,'0')}. ` +
            `${voice.ShortName} — ` +
            `${voice.Locale}\n`

          number++

          if (output.length > 6000) {
            output +=
              '\n... ʟɪsᴛ ᴛʀᴜɴᴄᴀᴛᴇᴅ'
            break
          }
        }

        output +=
          '\n\nᴜsᴀɢᴇ:\n' +
          '.ᴠᴏɪᴄᴇ <ᴠᴏɪᴄᴇɴᴀᴍᴇ> <ᴛᴇxᴛ>\n\n' +
          'ᴇxᴀᴍᴘʟᴇ:\n' +
          '.ᴠᴏɪᴄᴇ ᴜʀ-ᴘᴋ-ᴜᴢᴍᴀɴᴇᴜʀᴀʟ ᴍᴜᴊʜᴇ ᴀᴀᴘ sᴇ ʙᴀᴀᴛ ᴋᴀʀɴɪ ʜᴀɪ'

        return await sock.sendMessage(
          jid,
          { text: output },
          { quoted: message }
        )
      } catch (error) {
        return await sock.sendMessage(
          jid,
          {
            text:
              '❌ ᴠᴏɪᴄᴇ ʟɪsᴛ ғᴀɪʟᴇᴅ\n\n' +
              `${error?.message || error}`
          },
          { quoted: message }
        )
      }
    }

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
        { quoted: message }
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
            '❌ ᴘʟᴇᴀsᴇ ᴘʀᴏᴠɪᴅᴇ ᴛᴇxᴛ.\n\n' +
            'ᴇxᴀᴍᴘʟᴇ:\n' +
            '.ᴠᴏɪᴄᴇ ᴜᴢᴍᴀ ᴍᴜᴊʜᴇ ᴀᴀᴘ sᴇ ᴇᴋ ʙᴀᴀᴛ ᴋᴀʀɴɪ ʜᴀɪ'
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

    const mp3File =
      path.join(
        os.tmpdir(),
        `raza-voice-${id}.mp3`
      )

    try {
      await sock.sendMessage(
        jid,
        {
          text:
            '🎙️ ɢᴇɴᴇʀᴀᴛɪɴɢ ғᴇᴍᴀʟᴇ ᴀɪ ᴠᴏɪᴄᴇ...'
        },
        { quoted: message }
      )

      const edgeVoices =
        await getFemaleVoices()

      const ttsAi =
        first === 'aegis'

      if (ttsAi) {
        const urduText =
          await romanToUrdu(text)

        await ttsAiGenerate(
          urduText,
          mp3File
        )

        await sendVoice(
          sock,
          jid,
          message,
          mp3File,
          id
        )

        return
      }

      const selected =
        findEdgeVoice(
          edgeVoices,
          first
        )

      if (!selected) {
        return await sock.sendMessage(
          jid,
          {
            text:
              '❌ ᴛʜɪs ғᴇᴍᴀʟᴇ ᴠᴏɪᴄᴇ ᴡᴀs ɴᴏᴛ ғᴏᴜɴᴅ.\n\n' +
              'ᴜsᴇ .ᴠᴏɪᴄᴇs ᴛᴏ sᴇᴇ ᴀʟʟ ғᴇᴍᴀʟᴇ ᴠᴏɪᴄᴇs.'
          },
          { quoted: message }
        )
      }

      const language =
        selected.Locale
          ?.toLowerCase()
          .startsWith('ur-')
          ? 'urdu'
          : 'other'

      const finalText =
        language === 'urdu'
          ? await romanToUrdu(text)
          : text

      await edgeTTS(
        finalText,
        selected.ShortName,
        mp3File
      )

      await sendVoice(
        sock,
        jid,
        message,
        mp3File,
        id
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
            '❌ ᴠᴏɪᴄᴇ ɢᴇɴᴇʀᴀᴛɪᴏɴ ғᴀɪʟᴇᴅ\n\n' +
            `${error?.message || error}`
        },
        { quoted: message }
      )
    } finally {
      await fs
        .unlink(mp3File)
        .catch(() => {})
    }
  }
}

async function ttsAiGenerate(
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
