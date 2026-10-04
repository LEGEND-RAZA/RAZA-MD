import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'

export const play = {
  command: ['play', 'song'],

  async run({
    sock,
    message,
    args
  }) {
    const jid =
      message?.key?.remoteJid

    if (!jid) return

    const query =
      args?.join(' ').trim()

    if (!query) {
      await sock.sendMessage(
        jid,
        {
          text:
            '❌ ᴘʟᴇᴀsᴇ ᴘʀᴏᴠɪᴅᴇ ᴀ ʏᴏᴜᴛᴜʙᴇ ᴜʀʟ ᴏʀ sᴇᴀʀᴄʜ ǫᴜᴇʀʏ.\n\nᴇxᴀᴍᴘʟᴇ:\n!play faded'
        },
        {
          quoted: message
        }
      )

      return
    }

    const id =
      randomUUID()

    const workDir =
      path.join(
        os.tmpdir(),
        `raza-play-${id}`
      )

    const cookiePath =
      path.join(
        workDir,
        'cookies.txt'
      )

    const outputPath =
      path.join(
        workDir,
        'audio.%(ext)s'
      )

    try {
      const { default: ytdlp } =
        await import('yt-dlp-exec')

      const cookieData =
        process.env.YOUTUBE_COOKIE ||
        process.env.YT_COOKIE ||
        ''

      await fs.mkdir(
        workDir,
        {
          recursive: true
        }
      )

      if (cookieData.trim()) {
        await fs.writeFile(
          cookiePath,
          cookieData,
          'utf8'
        )
      }

      await sock.sendMessage(
        jid,
        {
          text:
            '⏳ ᴘʀᴏᴄᴇssɪɴɢ ʏᴏᴜʀ ʀᴇǫᴜᴇsᴛ...'
        },
        {
          quoted: message
        }
      )

      const target =
        /^https?:\/\//i.test(query)
          ? query
          : `ytsearch1:${query}`

      const infoArgs = {
        dumpSingleJson: true,
        noWarnings: true,
        noPlaylist: true,
        skipDownload: true,
        quiet: true
      }

      if (cookieData.trim()) {
        infoArgs.cookies =
          cookiePath
      }

      const info =
        await ytdlp(
          target,
          infoArgs
        )

      let video = info

      if (
        Array.isArray(
          info?.entries
        )
      ) {
        video =
          info.entries.find(
            entry => entry
          )
      }

      if (!video) {
        throw new Error(
          'No YouTube result found.'
        )
      }

      const title =
        String(
          video.title ||
          'Unknown title'
        )

      const duration =
        video.duration
          ? formatDuration(
              Number(
                video.duration
              )
            )
          : ''

      const channel =
        String(
          video.uploader ||
          video.channel ||
          ''
        )

      const downloadArgs = {
        format:
          'bestaudio/best',
        output:
          outputPath,
        noWarnings: true,
        noPlaylist: true,
        quiet: true,
        preferFreeFormats: true,
        extractAudio: true,
        audioFormat: 'mp3',
        audioQuality: '128K'
      }

      if (cookieData.trim()) {
        downloadArgs.cookies =
          cookiePath
      }

      await ytdlp(
        target,
        downloadArgs
      )

      const files =
        await fs.readdir(
          workDir
        )

      const audioFile =
        files.find(
          file =>
            file !== 'cookies.txt' &&
            /\.(mp3|m4a|opus|webm|ogg)$/i.test(
              file
            )
        )

      if (!audioFile) {
        throw new Error(
          'Audio file was not created.'
        )
      }

      const audioPath =
        path.join(
          workDir,
          audioFile
        )

      const audio =
        await fs.readFile(
          audioPath
        )

      await sock.sendMessage(
        jid,
        {
          audio,
          mimetype:
            'audio/mpeg',
          fileName:
            `${safeFileName(title)}.mp3`,
          ptt: false,
          contextInfo: {
            externalAdReply: {
              title,
              body:
                channel
                  ? `${channel}${duration ? ` • ${duration}` : ''}`
                  : duration ||
                    'Raza-MD',
              mediaType: 2,
              renderLargerThumbnail:
                false,
              showAdAttribution:
                false,
              sourceUrl:
                video.webpage_url ||
                video.original_url ||
                query
            }
          }
        },
        {
          quoted: message
        }
      )

    } catch (error) {
      console.error(
        '[PLAY ERROR]:',
        error?.stderr ||
        error?.message ||
        error
      )

      let text =
        '❌ ᴜɴᴀʙʟᴇ ᴛᴏ ᴘʟᴀʏ ᴛʜᴇ ʀᴇǫᴜᴇsᴛ.'

      const errorText =
        String(
          error?.stderr ||
          error?.message ||
          error ||
          ''
        )

      if (
        /cannot find package|module not found/i.test(
          errorText
        )
      ) {
        text =
          '❌ ʏᴛ-ᴅʟᴘ ᴅᴇᴘᴇɴᴅᴇɴᴄʏ ɪs ɴᴏᴛ ɪɴsᴛᴀʟʟᴇᴅ.'
      } else if (
        /cookie|login|sign in|authentication/i.test(
          errorText
        )
      ) {
        text =
          '❌ ʏᴏᴜᴛᴜʙᴇ ᴄᴏᴏᴋɪᴇs ᴀʀᴇ ɪɴᴠᴀʟɪᴅ ᴏʀ ᴇxᴘɪʀᴇᴅ.'
      } else if (
        /private|unavailable|not available/i.test(
          errorText
        )
      ) {
        text =
          '❌ ᴛʜɪs ᴠɪᴅᴇᴏ ɪs ɴᴏᴛ ᴀᴠᴀɪʟᴀʙʟᴇ.'
      }

      try {
        await sock.sendMessage(
          jid,
          {
            text
          },
          {
            quoted: message
          }
        )
      } catch {}
    } finally {
      try {
        await fs.rm(
          workDir,
          {
            recursive: true,
            force: true
          }
        )
      } catch {}
    }
  }
}

function formatDuration(seconds) {
  if (
    !Number.isFinite(seconds) ||
    seconds < 0
  ) {
    return ''
  }

  const total =
    Math.floor(seconds)

  const hours =
    Math.floor(total / 3600)

  const minutes =
    Math.floor(
      (total % 3600) / 60
    )

  const secs =
    total % 60

  if (hours > 0) {
    return `${hours}:${String(
      minutes
    ).padStart(2, '0')}:${String(
      secs
    ).padStart(2, '0')}`
  }

  return `${minutes}:${String(
    secs
  ).padStart(2, '0')}`
}

function safeFileName(name) {
  return String(
    name || 'audio'
  )
    .replace(
      /[<>:"/\\|?*\x00-\x1F]/g,
      ''
    )
    .replace(
      /\s+/g,
      ' '
    )
    .trim()
    .slice(0, 80) ||
    'audio'
}
