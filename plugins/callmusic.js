import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import ffmpegPath from 'ffmpeg-static'

const YT_DLP_TIMEOUT_MS = 90_000
const ELITE_API = 'https://eliteprotech-apis.zone.id'
const YOUTUBE_URL_RE = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/i

let youtubeDl
let youtubeDlReady

async function getYoutubeDl() {
    if (!youtubeDl) youtubeDl = (await import('youtube-dl-exec')).default
    if (!youtubeDlReady) {
        youtubeDlReady = (async () => {
            const binaryPath = youtubeDl.constants?.YOUTUBE_DL_PATH
                || path.join(path.dirname(import.meta.resolve('youtube-dl-exec')), '..', 'bin', 'yt-dlp')
            if (!fs.existsSync(binaryPath)) {
                fs.mkdirSync(path.dirname(binaryPath), { recursive: true })
                const response = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp', {
                    redirect: 'follow', signal: AbortSignal.timeout(90_000), headers: { 'User-Agent': 'RAZA-MD/1.0' },
                })
                if (!response.ok) throw new Error(`yt-dlp bootstrap HTTP ${response.status}`)
                const binary = Buffer.from(await response.arrayBuffer())
                fs.writeFileSync(binaryPath, binary, { mode: 0o755 })
            }
            try { fs.chmodSync(binaryPath, 0o755) } catch (_) {}
            return youtubeDl
        })().catch(error => { youtubeDlReady = null; throw error })
    }
    await youtubeDlReady
    return youtubeDl
}

function normalizeYoutubeUrl(value) {
    const input = String(value || '').trim()
    const match = input.match(YOUTUBE_URL_RE)
    return match ? `https://www.youtube.com/watch?v=${match[1]}` : input
}

async function eliteJson(pathname, params) {
    const url = new URL(`${ELITE_API}${pathname}`)
    for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, String(value))
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { Accept: 'application/json', 'User-Agent': 'RAZA-MD/1.0' } })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok || payload.success === false || payload.status === false) throw new Error(payload.error || payload.message || `EliteProTech HTTP ${response.status}`)
    return payload
}

async function resolveWithElite(query) {
    const payload = await eliteJson('/search/ytsearch', { q: query })
    const result = payload.results?.videos?.[0]
    if (!result?.url) throw new Error('EliteProTech returned no YouTube result')
    return { url: normalizeYoutubeUrl(result.url), title: result.title || query }
}

async function resolveVideo(input) {
    if (!YOUTUBE_URL_RE.test(input)) {
        try { return await resolveWithElite(input) } catch (_) {}
    }
    const source = YOUTUBE_URL_RE.test(input) ? normalizeYoutubeUrl(input) : `ytsearch1:${input}`
    const ytdlp = await getYoutubeDl()
    const raw = await ytdlp(source, { dumpSingleJson: true, skipDownload: true, noWarnings: true, noCheckCertificates: true, noPlaylist: true, extractorArgs: 'youtube:player_client=android' }, { timeout: YT_DLP_TIMEOUT_MS })
    const metadata = raw?.entries?.[0] || raw
    const id = metadata.id || source.match(/[?&]v=([A-Za-z0-9_-]{6,})/)?.[1]
    const url = metadata.webpage_url || (id ? `https://www.youtube.com/watch?v=${id}` : source)
    return { url, title: metadata.title || input }
}

async function getDirectUrl(url, formats) {
    let lastError
    try {
        const payload = await eliteJson(`/download/ytmp3`, { url })
        const direct = payload.download?.downloadUrl || payload.result?.url || payload.downloadUrl || payload.url
        if (/^https?:\/\//i.test(String(direct || ''))) return direct
        throw new Error('EliteProTech returned no media URL')
    } catch (error) { lastError = error }
    for (const format of formats) {
        try {
            const ytdlp = await getYoutubeDl()
            const result = await ytdlp(url, { getUrl: true, format, noWarnings: true, noCheckCertificates: true, extractorArgs: 'youtube:player_client=android' }, { timeout: YT_DLP_TIMEOUT_MS })
            const direct = String(result || '').trim().split(/\r?\n/).pop()
            if (/^https?:\/\//i.test(direct)) return direct
        } catch (error) { lastError = error }
    }
    throw lastError || new Error('YouTube did not return a downloadable format')
}

async function fetchBuffer(url) {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(90_000), headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' } })
    if (!response.ok) throw new Error(`YouTube media HTTP ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
}

export default {
  command: ['playcall', 'callmusic'],
  category: 'owner',
  description: 'Play music in a group voice call',

  async run({ sock, message, args, isOwner }) {
    const jid = message.key.remoteJid
    if (!isOwner) return sock.sendMessage(jid, { text: '❌ Only the owner can use this command.' })

    const groupJid = args[0]
    const songQuery = args.slice(1).join(' ')

    if (!groupJid || !groupJid.endsWith('@g.us') || !songQuery) {
      return sock.sendMessage(jid, { text: '⚠️ Usage: .playcall <group_jid> <song_name>' })
    }

    let call = null
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raza-call-'))
    const tempMp3 = path.join(dir, 'audio.mp3')

    try {
      const meowPkg = (await import('meowcaller-js')).default || (await import('meowcaller-js'))
      const { Client, SourceFunc } = meowPkg
      const { createPcmStream } = await import('../lib/audioHelper.js')
      
      await sock.sendMessage(jid, { text: `🔍 sᴇᴀʀᴄʜɪɴɢ & ᴅᴏᴡɴʟᴏᴀᴅɪɴɢ: *${songQuery}*...` })

      const video = await resolveVideo(songQuery)
      const sourceUrl = await getDirectUrl(video.url, ['18', 'best'])
      const sourceBuffer = await fetchBuffer(sourceUrl)
      fs.writeFileSync(path.join(dir, 'source.media'), sourceBuffer)

      await new Promise((resolve, reject) => {
          const encoder = ffmpegPath && fs.existsSync(ffmpegPath) ? ffmpegPath : 'ffmpeg'
          const child = spawn(encoder, ['-y', '-i', path.join(dir, 'source.media'), '-vn', '-codec:a', 'libmp3lame', '-b:a', '128k', tempMp3], { stdio: ['ignore', 'ignore', 'pipe'] })
          child.once('error', reject)
          child.once('close', code => code === 0 ? resolve() : reject(new Error(`MP3 conversion failed`)))
      })

      await sock.sendMessage(jid, { text: `🎵 ᴅᴏᴡɴʟᴏᴀᴅᴇᴅ! ᴊᴏɪɴɪɴɢ ᴄᴀʟʟ...` })

      const pcmStream = await createPcmStream(tempMp3)
      const client = new Client(sock)
      client.connect()

      // 🚀 DEBUGGING: Check all available functions inside the client
      const methods = Object.keys(client).join(', ')
      const protoMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(client)).join(', ')
      
      if (typeof client.groupCall === 'function') {
        call = await client.groupCall(groupJid)
      } else if (typeof client.groupCallByID === 'function') {
        call = await client.groupCallByID(groupJid)
      } else if (typeof client.call === 'function') {
        call = await client.call(groupJid)
      } else {
        // If we can't find a call function, send the available methods to WhatsApp
        throw new Error(`No group call method found. Methods: [${methods}] | Proto: [${protoMethods}]`)
      }
      
      await sock.sendMessage(jid, { text: '📞 ᴄᴏɴɴᴇᴄᴛᴇᴅ ᴛᴏ ᴄᴀʟʟ. sᴛʀᴇᴀᴍɪɴɢ ᴀᴜᴅɪᴏ...' })

      call.onReady(() => {
        const source = SourceFunc(async () => {
          return new Promise((resolve) => {
            pcmStream.once('data', (chunk) => resolve(chunk))
            pcmStream.once('end', () => resolve(null))
          })
        })
        call.play(source)
      })

      call.onEnd((reason) => {
        call = null
        fs.rmSync(dir, { recursive: true, force: true })
      })

    } catch (error) {
      console.error('[PLAYCALL ERROR]', error)
      await sock.sendMessage(jid, { text: `❌ ꜰᴀɪʟᴇᴅ: ${error.message}` })
      if (call) { try { call.hangup() } catch {} }
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}
