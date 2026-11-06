import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import yts from 'yt-search'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'

const execFileAsync = promisify(execFile)

const FFMPEG_PATH = ffmpegStatic || 'ffmpeg'
const FFPROBE_PATH = ffprobeStatic?.path || 'ffprobe'
const MAX_VIDEO_BYTES = 60 * 1024 * 1024
const MIN_VIDEO_BYTES = 16 * 1024
const MAX_DURATION_SEC = 20 * 60
const BIN_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000

// ---------- Cookies ----------
let cookiesPath = null
function getCookiesFile() {
    if (cookiesPath && fs.existsSync(cookiesPath)) return cookiesPath

    let value = process.env.YOUTUBE_COOKIES_B64
        ? Buffer.from(process.env.YOUTUBE_COOKIES_B64, 'base64').toString('utf8')
        : (process.env.YOUTUBE_COOKIES || '')
    if (!value) return null

    // Value may be a path to a cookies file
    if (!value.includes('\n') && !value.includes('=') && fs.existsSync(value)) {
        value = fs.readFileSync(value, 'utf8')
    }
    value = value.replace(/\\n/g, '\n').trim()

    // Convert "a=b; c=d" header format into Netscape format
    if (!/youtube\.com\t/.test(value)) {
        const lines = ['# Netscape HTTP Cookie File']
        for (const part of value.split(';')) {
            const i = part.indexOf('=')
            if (i < 1) continue
            const name = part.slice(0, i).trim()
            const val = part.slice(i + 1).trim()
            lines.push(`.youtube.com\tTRUE\t/\tTRUE\t2147483647\t${name}\t${val}`)
        }
        if (lines.length < 2) {
            console.error('[Video Plugin] Cookies invalid')
            return null
        }
        value = lines.join('\n')
    }

    cookiesPath = path.join(os.tmpdir(), 'yt-cookies.txt')
    fs.writeFileSync(cookiesPath, value + '\n')
    console.log('[Video Plugin] Cookies loaded')
    return cookiesPath
}

// ---------- yt-dlp binary (auto-downloaded, no Python needed) ----------
const BIN_DIR = path.join(process.cwd(), 'bin')
const BIN_PATH = path.join(BIN_DIR, 'yt-dlp')
let binPromise = null

async function downloadBinary() {
    const file = process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'
    const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${file}`
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) throw new Error(`yt-dlp download failed: HTTP ${res.status}`)
    await fs.promises.mkdir(BIN_DIR, { recursive: true })
    const tmp = BIN_PATH + '.tmp'
    await fs.promises.writeFile(tmp, Buffer.from(await res.arrayBuffer()))
    await fs.promises.chmod(tmp, 0o755)
    await fs.promises.rename(tmp, BIN_PATH)
    console.log('[Video Plugin] yt-dlp binary updated')
}

async function ensureYtDlp() {
    if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH
    if (process.platform !== 'linux') return 'yt-dlp' // must be installed on PATH

    const exists = fs.existsSync(BIN_PATH)
    const fresh = exists && Date.now() - fs.statSync(BIN_PATH).mtimeMs < BIN_MAX_AGE_MS
    if (fresh) return BIN_PATH

    if (!binPromise) {
        binPromise = downloadBinary()
            .catch(err => {
                if (!exists) throw err
                console.error('[Video Plugin] yt-dlp update failed, using old binary:', err.message)
            })
            .finally(() => { binPromise = null })
    }
    await binPromise
    return BIN_PATH
}

// ---------- Search ----------
async function searchYouTube(query) {
    const res = await yts(query)
    const v = res.videos?.[0]
    if (!v) return null
    return {
        url: v.url,
        title: v.title || 'YouTube Video',
        thumbnail: v.thumbnail || '',
        author: v.author?.name || 'Unknown',
        duration: v.seconds || 0,
        views: v.views || 0,
    }
}

function fmtDuration(sec) {
    if (!sec) return 'Unknown'
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
}

// ---------- Download ----------
async function runYtDlp(bin, url, template, quality, extraArgs) {
    const cookies = getCookiesFile()
    const args = [
        '-o', template,
        '-f', `bv*[height<=${quality}][ext=mp4]+ba[ext=m4a]/b[height<=${quality}][ext=mp4]/bv*[height<=${quality}]+ba/b[height<=${quality}]/b`,
        '--merge-output-format', 'mp4',
        '--no-playlist',
        '--no-warnings',
        '--no-check-certificates',
        '--max-filesize', '60M',
        '--ffmpeg-location', FFMPEG_PATH,
        ...(cookies ? ['--cookies', cookies] : []),
        ...(process.env.YTDLP_PROXY ? ['--proxy', process.env.YTDLP_PROXY] : []),
        ...extraArgs,
        url,
    ]
    await execFileAsync(bin, args, { timeout: 150_000, maxBuffer: 10 * 1024 * 1024 })
}

async function downloadVideo(url, quality = 720) {
    const bin = await ensureYtDlp()
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yt-dlp-'))
    const template = path.join(tempDir, 'video.%(ext)s')

    try {
        const attempts = [
            ['--js-runtimes', `node:${process.execPath}`, '--extractor-args', 'youtube:player_client=default,mweb'],
            ['--extractor-args', 'youtube:player_client=android,web'],
            ['--extractor-args', 'youtube:player_client=ios'],
            [],
        ]

        let lastError = null
        let file = null
        for (const extra of attempts) {
            try {
                await runYtDlp(bin, url, template, quality, extra)
                const files = await fs.promises.readdir(tempDir)
                const found = files.find(f => f.startsWith('video.') && !f.endsWith('.part'))
                if (found) { file = path.join(tempDir, found); break }
            } catch (err) {
                lastError = err
                console.error('[Video Plugin] attempt failed:', String(err.stderr || err.message).split('\n').filter(Boolean).slice(-3).join(' | '))
            }
        }

        if (!file) {
            const detail = String(lastError?.stderr || lastError?.message || 'unknown error').split('\n').filter(Boolean).pop()
            throw new Error(`yt-dlp failed: ${detail}`)
        }

        const stats = await fs.promises.stat(file)
        if (stats.size < MIN_VIDEO_BYTES) throw new Error(`Downloaded file too small (${stats.size} bytes)`)
        if (stats.size > MAX_VIDEO_BYTES) throw new Error(`File too large (${(stats.size / 1048576).toFixed(1)} MB)`)

        return await ensureWhatsAppMp4(file, tempDir)
    } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
}

async function ensureWhatsAppMp4(inputPath, dir) {
    const fixedPath = path.join(dir, 'final.mp4')

    const probe = await execFileAsync(FFPROBE_PATH, [
        '-v', 'error', '-show_entries', 'stream=codec_type,codec_name',
        '-of', 'json', inputPath,
    ], { timeout: 30_000 })

    const streams = JSON.parse(probe.stdout || '{}').streams || []
    const video = streams.find(s => s.codec_type === 'video')
    const audio = streams.find(s => s.codec_type === 'audio')
    if (!video) throw new Error('file contains no video stream')

    const videoOk = /^(?:h264|avc1)$/i.test(video.codec_name || '')
    const audioOk = !audio || /^(?:aac|mp3)$/i.test(audio.codec_name || '')

    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath, '-map', '0:v:0', '-map', '0:a:0?']
    if (videoOk && audioOk) {
        args.push('-c', 'copy')
    } else {
        args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p')
        args.push(...(audio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']))
    }
    args.push('-movflags', '+faststart', fixedPath)

    await execFileAsync(FFMPEG_PATH, args, { timeout: 180_000 })
    const fixed = await fs.promises.readFile(fixedPath)
    if (fixed.length < MIN_VIDEO_BYTES) throw new Error('ffmpeg produced an invalid MP4')
    return fixed
}

// ---------- Plugin ----------
export default {
    command: ['video', 'ytvideo', 'ytv'],
    category: 'downloader',

    async run(ctx) {
        const { sock, message } = ctx
        const msg = message || ctx.msg
        if (!sock || !msg) return

        const jid = msg.key?.remoteJid
        if (!jid) return

        const reply = (text) => sock.sendMessage(jid, { text }, { quoted: msg })
        const react = (emoji) => sock.sendMessage(jid, { react: { text: emoji, key: msg.key } }).catch(() => {})

        const prefix = ctx.prefix || '.'
        const command = ctx.command || 'video'
        let text = ctx.text || ''

        if (!text) {
            const full = msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                msg.message?.imageMessage?.caption ||
                msg.message?.videoMessage?.caption || ''
            text = full.replace(prefix + command, '').trim()
        }

        if (!text) return reply(`Provide video name\nExample: ${prefix}${command} Alan Walker Lily`)

        try {
            await react('🔎')
            const vid = await searchYouTube(text)
            if (!vid?.url) {
                await react('😕')
                return reply('No video found')
            }

            if (vid.duration > MAX_DURATION_SEC) {
                await react('⚠️')
                return reply(`Video is too long (${fmtDuration(vid.duration)}). Max is ${MAX_DURATION_SEC / 60} minutes.`)
            }

            const duration = fmtDuration(vid.duration)
            await react('⬇️')

            const caption = `🎬 *${vid.title}*\n\n⏱️ Duration: ${duration}\n👁️ Views: ${Number(vid.views).toLocaleString()}\n📢 Channel: ${vid.author}\n\n⏳ Downloading...`
            if (vid.thumbnail) {
                await sock.sendMessage(jid, { image: { url: vid.thumbnail }, caption }, { quoted: msg }).catch(() => {})
            } else {
                await reply(caption)
            }

            const videoBuffer = await downloadVideo(vid.url)

            await sock.sendMessage(jid, {
                video: videoBuffer,
                mimetype: 'video/mp4',
                caption: `🎬 *${vid.title}*\n⏱️ ${duration}`,
            }, { quoted: msg })

            await react('✅')
        } catch (error) {
            console.error('[Video Plugin Error]', error)
            await react('❌')
            await reply(`❌ Failed to download video.\n\n*Reason:* ${error.message}`)
        }
    }
}
