import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// Use yt-dlp-exec for reliable downloading
import ytDlp from 'yt-dlp-exec'

const execFileAsync = promisify(execFile)

// Safe dynamic imports for other dependencies
let axios, ffmpegPath, ffprobeStatic
let libError = null

try {
    axios = (await import('axios')).default
    const ffmpegMod = await import('ffmpeg-static')
    ffmpegPath = ffmpegMod.default || ffmpegMod
    const ffprobeMod = await import('ffprobe-static')
    ffprobeStatic = ffprobeMod.default || ffprobeMod
} catch (err) {
    libError = err.message
    console.error('[YouTube Plugin] Dependency error:', err.message)
}

const FFMPEG_PATH = ffmpegPath || 'ffmpeg'
const FFPROBE_PATH = ffprobeStatic?.path || 'ffprobe'

const USER_AGENT = 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36'
const JSON_TIMEOUT_MS = 18_000
const DOWNLOAD_TIMEOUT_MS = 75_000
const MAX_VIDEO_BYTES = 60 * 1024 * 1024
const MIN_VIDEO_BYTES = 16 * 1024

const PIPED_APIS = (process.env.YOUTUBE_PIPED_APIS || [
    'https://pipedapi.kavin.rocks',
    'https://pipedapi-libre.kavin.rocks',
    'https://pipedapi.adminforge.de',
    'https://api.piped.yt',
    'https://pipedapi.owo.si',
    'https://pipedapi.ducks.party',
    'https://piped-api.codespace.cz',
    'https://pipedapi.reallyaweso.me',
].join(','))
    .split(',')
    .map(value => value.trim().replace(/\/$/, ''))
    .filter(Boolean)

function isHttpUrl(value) {
    return typeof value === 'string' && /^https?:\/\//i.test(value.trim())
}

function isYouTubeSourceUrl(value) {
    return /(?:youtube\.com|youtu\.be|youtube-nocookie\.com)/i.test(value)
}

function isImageOrAudioUrl(value, keyPath) {
    const lowerUrl = value.toLowerCase().split('?')[0]
    const lowerPath = keyPath.toLowerCase()
    return /(?:thumbnail|thumb|image|avatar|cover|poster|audio|music|song)/i.test(lowerPath)
        || /\.(?:jpe?g|png|webp|gif|svg|mp3|m4a|ogg|wav)(?:$|[?#])/i.test(lowerUrl)
}

function mediaQuality(label, url) {
    const match = `${label || ''} ${url || ''}`.match(/(?:^|[^0-9])(144|240|360|480|540|720|1080|1440|2160|4320)p?(?:[^0-9]|$)/i)
    return match ? Number(match[1]) : 0
}

function rankMediaCandidates(candidates) {
    const deduped = new Map()
    for (const candidate of candidates) {
        if (!isHttpUrl(candidate?.url) || isYouTubeSourceUrl(candidate.url)) continue
        const url = candidate.url.trim()
        if (!deduped.has(url)) {
            deduped.set(url, {
                url,
                label: String(candidate.label || ''),
                quality: mediaQuality(candidate.label, url),
            })
        }
    }

    return [...deduped.values()].sort((a, b) => {
        const aPreferred = a.quality > 0 && a.quality <= 720 ? 1 : 0
        const bPreferred = b.quality > 0 && b.quality <= 720 ? 1 : 0
        if (aPreferred !== bPreferred) return bPreferred - aPreferred
        if (a.quality !== b.quality) return b.quality - a.quality
        return 0
    })
}

function collectMediaUrls(payload) {
    const found = []
    const visit = (node, keyPath = [], depth = 0) => {
        if (node == null || depth > 9) return
        if (typeof node === 'string') {
            const value = node.trim()
            if (isHttpUrl(value) && !isYouTubeSourceUrl(value) && !isImageOrAudioUrl(value, keyPath.join('.'))) {
                found.push({ url: value, label: keyPath.join('.') })
            }
            return
        }
        if (Array.isArray(node)) {
            node.forEach((entry, index) => visit(entry, [...keyPath, String(index)], depth + 1))
            return
        }
        if (typeof node !== 'object') return
        for (const [key, value] of Object.entries(node)) {
            visit(value, [...keyPath, key], depth + 1)
        }
    }
    visit(payload)
    return rankMediaCandidates(found)
}

function extractYouTubeId(url) {
    if (!isHttpUrl(url)) return null
    try {
        const parsed = new URL(url)
        if (parsed.hostname === 'youtu.be') return parsed.pathname.slice(1).match(/^[A-Za-z0-9_-]{6,}/)?.[0] || null
        const queryId = parsed.searchParams.get('v')
        if (queryId) return queryId.match(/^[A-Za-z0-9_-]{6,}/)?.[0] || null
        const pathMatch = parsed.pathname.match(/\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{6,})/i)
        return pathMatch ? pathMatch[1] : null
    } catch (_) {
        return null
    }
}

async function getJson(url, options = {}) {
    const response = await axios.get(url, {
        timeout: JSON_TIMEOUT_MS,
        maxContentLength: 2 * 1024 * 1024,
        maxBodyLength: 2 * 1024 * 1024,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/plain, */*', ...options.headers },
        validateStatus: () => true,
        ...options,
    })
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`)
    if (typeof response.data === 'string' && /^\s*</.test(response.data)) throw new Error('provider returned HTML instead of JSON')
    return response.data
}

// ==========================================
// SEARCH FUNCTION (Using Piped API)
// ==========================================
async function searchYouTube(query) {
    for (const api of PIPED_APIS) {
        try {
            const data = await getJson(`${api}/search`, { 
                params: { q: query, filter: 'videos' },
                timeout: 10_000
            })
            if (data?.items?.length > 0) {
                const v = data.items.find(item => item.type === 'stream' || item.url?.includes('/watch'))
                if (v) {
                    return {
                        url: v.url.startsWith('http') ? v.url : `https://www.youtube.com${v.url}`,
                        title: v.title || 'YouTube Video',
                        thumbnail: v.thumbnail || '',
                        author: v.uploaderName || 'Unknown',
                        duration: v.duration || 0,
                        views: v.views || 0
                    }
                }
            }
        } catch (err) {
            console.error(`[video] Piped search failed on ${api}:`, err.message)
        }
    }
    return null
}

// ==========================================
// DOWNLOAD FUNCTION (Using yt-dlp)
// ==========================================
async function downloadWithYtDlp(url, quality = '720') {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yt-dlp-'))
    const outputPath = path.join(tempDir, 'video.mp4')

    try {
        console.log(`[Video Plugin] Downloading with yt-dlp: ${url}`)
        
        // yt-dlp-exec options
        const options = {
            output: outputPath,
            format: `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]`,
            mergeOutputFormat: 'mp4',
            noPlaylist: true,
            noWarnings: true,
            noCallHome: true,
            noCheckCertificate: true,
            preferFreeFormats: true,
            youtubeSkipDashManifest: true,
            referer: 'https://www.youtube.com/',
            // Use ffmpeg-static if available
            ...(ffmpegPath ? { ffmpegLocation: path.dirname(ffmpegPath) } : {})
        }

        // Execute yt-dlp
        await ytDlp(url, options)

        // Verify the file exists and is valid
        if (!fs.existsSync(outputPath)) {
            throw new Error('yt-dlp did not create an output file')
        }

        const stats = await fs.promises.stat(outputPath)
        if (stats.size < MIN_VIDEO_BYTES) {
            throw new Error(`Downloaded file is too small (${stats.size} bytes)`)
        }
        if (stats.size > MAX_VIDEO_BYTES) {
            throw new Error(`Downloaded file exceeds limit (${(stats.size / 1024 / 1024).toFixed(1)} MB)`)
        }

        // Read the file into a buffer
        const videoBuffer = await fs.promises.readFile(outputPath)

        // Verify it's a valid video using ffprobe
        await validateAndRemux(videoBuffer)

        return videoBuffer

    } finally {
        // Clean up temporary files
        await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
}

async function validateAndRemux(buffer) {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sukuna-video-'))
    const rawPath = path.join(directory, 'input.bin')
    const fixedPath = path.join(directory, 'output.mp4')
    await fs.promises.writeFile(rawPath, buffer)

    try {
        const probe = await execFileAsync(FFPROBE_PATH, [
            '-v', 'error', '-show_entries', 'stream=codec_type,codec_name',
            '-of', 'json', rawPath,
        ], { timeout: 30_000 })
        
        const streams = JSON.parse(probe.stdout || '{}').streams || []
        const videoStream = streams.find(stream => stream.codec_type === 'video')
        const audioStream = streams.find(stream => stream.codec_type === 'audio')
        
        if (!videoStream) throw new Error('file contains no video stream')

        const videoReady = /^(?:h264|avc1)$/i.test(String(videoStream.codec_name || ''))
        const audioReady = !audioStream || /^(?:aac|mp3)$/i.test(String(audioStream.codec_name || ''))
        const needsTranscode = !videoReady || !audioReady
        
        const ffmpegArgs = [
            '-hide_banner', '-loglevel', 'error', '-y', '-i', rawPath,
            '-map', '0:v:0', '-map', '0:a:0?',
        ]
        
        if (needsTranscode) {
            ffmpegArgs.push(
                '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
                '-pix_fmt', 'yuv420p',
                ...(audioStream ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
            )
        } else {
            ffmpegArgs.push('-c', 'copy')
        }
        ffmpegArgs.push('-movflags', '+faststart', fixedPath)

        try {
            await execFileAsync(FFMPEG_PATH, ffmpegArgs, { timeout: 180_000 })
            const fixed = await fs.promises.readFile(fixedPath)
            if (fixed.length >= MIN_VIDEO_BYTES) return fixed
            throw new Error('ffmpeg produced an empty or invalid MP4')
        } catch (error) {
            if (needsTranscode) {
                throw new Error(`unsupported codec ${videoStream.codec_name || 'unknown'} & conversion failed: ${error.message}`)
            }
            return buffer
        }
    } finally {
        await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {})
    }
}

// ==========================================
// PLUGIN EXPORT
// ==========================================
export default {
    command: ['video', 'ytvideo', 'ytv'],
    category: 'downloader',

    async run(ctx) {
        const { sock, message, isGroup, isOwner } = ctx
        const msg = message || ctx.msg
        if (!sock || !msg) return

        const jid = msg.key?.remoteJid
        if (!jid) return

        const reply = (text) => sock.sendMessage(jid, { text }, { quoted: msg })

        if (libError) {
            return reply(`❌ Plugin failed to load dependencies.\n\n*Reason:* ${libError}\n\nPlease run: npm install axios ffprobe-static ffmpeg-static yt-dlp-exec`)
        }

        let text = ctx.text || ''
        let prefix = ctx.prefix || '.'
        let command = ctx.command || 'video'

        if (!text) {
            const fullText = msg.message?.conversation || 
                             msg.message?.extendedTextMessage?.text || 
                             msg.message?.imageMessage?.caption || 
                             msg.message?.videoMessage?.caption || ''
            text = fullText.replace(prefix + command, '').trim()
        }

        if (!text) {
            return reply(`Provide video name\nExample: ${prefix}${command} Alan Walker Lily`)
        }

        try {
            console.log(`[Video Plugin] Executing for query: "${text}"`)
            await sock.sendMessage(jid, { react: { text: '🔎', key: msg.key } }).catch(() => {})

            const vid = await searchYouTube(text)
            
            if (!vid?.url) {
                await sock.sendMessage(jid, { react: { text: '😕', key: msg.key } }).catch(() => {})
                return reply('No video found')
            }

            const title = String(vid.title || 'YouTube Video')
            const author = String(vid.author || 'Unknown')
            const duration = vid.duration ? `${Math.floor(vid.duration / 60)}:${(vid.duration % 60).toString().padStart(2, '0')}` : 'Unknown'
            const views = Number(vid.views || 0).toLocaleString()

            await sock.sendMessage(jid, { react: { text: '⬇️', key: msg.key } }).catch(() => {})
            await sock.sendMessage(jid, {
                image: { url: vid.thumbnail },
                caption:
                    `🎬 *${title}*\n\n` +
                    `⏱️ Duration: ${duration}\n` +
                    `👁️ Views: ${views}\n` +
                    `📢 Channel: ${author}\n\n` +
                    `⏳ Downloading...`,
            }, { quoted: msg }).catch(() => {})

            const videoBuffer = await downloadWithYtDlp(vid.url)
            
            await sock.sendMessage(jid, {
                video: videoBuffer,
                mimetype: 'video/mp4',
                caption: `🎬 *${title}*\n⏱️ ${duration}`,
            }, { quoted: msg })

            await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } }).catch(() => {})
        } catch (error) {
            console.error('[Video Plugin Error]', error.message)
            await sock.sendMessage(jid, { react: { text: '❌', key: msg.key } }).catch(() => {})
            await reply(`❌ Failed to download video.\n\n*Reason:* ${error.message}`)
        }
    }
}
