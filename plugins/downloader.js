import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ffmpegStatic from 'ffmpeg-static'

const execFileAsync = promisify(execFile)
const FFMPEG_PATH = ffmpegStatic || 'ffmpeg'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const MAX_BYTES = 60 * 1024 * 1024
const MIN_BYTES = 10_000

/* ==========================================
   SHARED HELPERS
========================================== */
const isHttp = v => typeof v === 'string' && /^https?:\/\//i.test(v.trim())

function getQuotedText(msg) {
    const q = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
    return q?.conversation || q?.extendedTextMessage?.text || ''
}

async function getJson(url, { timeout = 25_000, headers = {} } = {}) {
    const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', ...headers },
        signal: AbortSignal.timeout(timeout),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    if (/^\s*</.test(text)) throw new Error('provider returned HTML instead of JSON')
    return JSON.parse(text)
}

async function remux(data) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'media-'))
    const rawPath = path.join(dir, 'raw.mp4')
    const fixedPath = path.join(dir, 'fixed.mp4')
    try {
        await fs.promises.writeFile(rawPath, data)
        await execFileAsync(FFMPEG_PATH, [
            '-hide_banner', '-loglevel', 'error', '-y',
            '-i', rawPath, '-c', 'copy', '-movflags', '+faststart', fixedPath,
        ], { timeout: 120_000 })
        const fixed = await fs.promises.readFile(fixedPath)
        return fixed.length >= MIN_BYTES ? fixed : data
    } catch (err) {
        console.error('[Social Plugin] remux failed, using original:', err.message)
        return data
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
}

/* ==========================================
   YT-DLP FALLBACK ENGINE
========================================== */
const BIN_DIR = path.join(process.cwd(), 'bin')
const BIN_PATH = path.join(BIN_DIR, 'yt-dlp')
const BIN_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000
let binPromise = null

async function downloadBinary() {
    const file = process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'
    const res = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${file}`, { redirect: 'follow' })
    if (!res.ok) throw new Error(`yt-dlp download failed: HTTP ${res.status}`)
    await fs.promises.mkdir(BIN_DIR, { recursive: true })
    const tmp = BIN_PATH + '.tmp'
    await fs.promises.writeFile(tmp, Buffer.from(await res.arrayBuffer()))
    await fs.promises.chmod(tmp, 0o755)
    await fs.promises.rename(tmp, BIN_PATH)
}

async function ensureYtDlp() {
    if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH
    if (process.platform !== 'linux') return 'yt-dlp'
    const exists = fs.existsSync(BIN_PATH)
    if (exists && Date.now() - fs.statSync(BIN_PATH).mtimeMs < BIN_MAX_AGE_MS) return BIN_PATH
    if (!binPromise) {
        binPromise = downloadBinary().catch(err => { if (!exists) throw err }).finally(() => { binPromise = null })
    }
    await binPromise
    return BIN_PATH
}

async function downloadWithYtDlp(url, isPlaylist = false) {
    const bin = await ensureYtDlp()
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ytdl-'))
    
    let cookiesPath = null
    let value = process.env.IG_COOKIES_B64 ? Buffer.from(process.env.IG_COOKIES_B64, 'base64').toString('utf8') : (process.env.IG_COOKIES || '')
    if (value) {
        if (!value.includes('\n') && !value.includes('=') && fs.existsSync(value)) value = fs.readFileSync(value, 'utf8')
        value = value.replace(/\\n/g, '\n').trim()
        if (!/instagram\.com\t/.test(value)) {
            const lines = ['# Netscape HTTP Cookie File']
            for (const part of value.split(';')) {
                const i = part.indexOf('=')
                if (i < 1) continue
                lines.push(`.instagram.com\tTRUE\t/\tTRUE\t2147483647\t${part.slice(0, i).trim()}\t${part.slice(i + 1).trim()}`)
            }
            value = lines.join('\n')
        }
        cookiesPath = path.join(os.tmpdir(), 'ig-cookies.txt')
        fs.writeFileSync(cookiesPath, value + '\n')
    }

    try {
        await execFileAsync(bin, [
            '-o', path.join(dir, 'media_%(autonumber)s.%(ext)s'),
            '-f', 'b[ext=mp4]/bv*[ext=mp4]+ba[ext=m4a]/b/bv*+ba',
            '--merge-output-format', 'mp4',
            isPlaylist ? '--yes-playlist' : '--no-playlist',
            '--no-warnings', '--no-check-certificates',
            '--max-filesize', '60M',
            '--ffmpeg-location', FFMPEG_PATH,
            ...(cookiesPath ? ['--cookies', cookiesPath] : []),
            ...(process.env.YTDLP_PROXY ? ['--proxy', process.env.YTDLP_PROXY] : []),
            url,
        ], { timeout: 150_000, maxBuffer: 10 * 1024 * 1024 })
    } catch (err) {
        throw new Error(String(err.stderr || err.message).split('\n').filter(Boolean).pop())
    }

    try {
        const names = (await fs.promises.readdir(dir)).filter(f => f.startsWith('media_') && !f.endsWith('.part')).sort()
        const items = []
        for (const name of names) {
            const buffer = await fs.promises.readFile(path.join(dir, name))
            if (buffer.length < 1024 || buffer.length > MAX_BYTES) continue
            const ext = path.extname(name).toLowerCase()
            if (['.mp4', '.mov', '.webm', '.mkv'].includes(ext)) items.push({ buffer: await remux(buffer), isVideo: true })
            else if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) items.push({ buffer, isVideo: false })
        }
        if (!items.length) throw new Error('yt-dlp found no media')
        return items
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
}

/* ==========================================
   INSTAGRAM ENGINE
========================================== */
const IG_APP_ID = '936619743392459'
const IG_URL_RE = /https?:\/\/(?:www\.|m\.)?instagram\.com\/(?:p|reel|reels|tv|share(?:\/reel|\/p)?)\/[^\s]+/i

function htmlDecode(v) { return String(v || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'") }

function metaContent(html, prop) {
    const p = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']+)["']`, 'i')) ||
        html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${p}["']`, 'i'))
    return htmlDecode(m?.[1] || '')
}

function looksLikeMedia(buf, type) {
    const t = String(type || '').toLowerCase()
    if (t.includes('text/html') || t.includes('application/json')) return false
    if (t.includes('video/') || t.includes('image/')) return true
    if (buf.length < 12) return false
    return buf.subarray(4, 8).toString('ascii') === 'ftyp' ||
        (buf[0] === 0xff && buf[1] === 0xd8) ||
        buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
}

async function downloadMediaIg(url) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'video/mp4,image/*,*/*;q=0.5' }, redirect: 'follow', signal: AbortSignal.timeout(90_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status} downloading media`)
    const type = res.headers.get('content-type') || ''
    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.length < 512) throw new Error('downloaded file is too small')
    if (buffer.length > MAX_BYTES) throw new Error(`file too large (${(buffer.length / 1048576).toFixed(1)} MB)`)
    if (!looksLikeMedia(buffer, type)) throw new Error(`not image/video (content-type: ${type || 'unknown'})`)
    const isVideo = type.includes('video/') || buffer.subarray(4, 8).toString('ascii') === 'ftyp'
    return { buffer: isVideo ? await remux(buffer) : buffer, isVideo }
}

async function fromVercel(postUrl) {
    const url = `https://instagram-reels-downloader-tau.vercel.app/api/video?postUrl=${encodeURIComponent(postUrl)}&url=${encodeURIComponent(postUrl)}&enhanced=true`
    const data = await getJson(url)
    const payload = data?.data || {}
    const medias = Array.isArray(payload.medias) ? payload.medias : []
    const best = medias.find(m => m?.type === 'video' && isHttp(m?.url)) || medias.find(m => isHttp(m?.url))
    const mediaUrl = best?.url || (isHttp(payload.videoUrl) ? payload.videoUrl : '')
    if (!isHttp(mediaUrl)) throw new Error('no usable media url')
    return { mediaUrl, caption: String(payload.title || '').trim(), author: String(payload.author || payload.owner?.username || '').trim() }
}

async function fromReelApi(postUrl) {
    const data = await getJson(`https://instagram-reel-api.onrender.com/?url=${encodeURIComponent(postUrl)}`, { timeout: 55_000 })
    if (!isHttp(data?.download_link)) throw new Error('no download_link')
    return { mediaUrl: data.download_link, caption: String(data?.title || data?.description || '').trim(), author: '' }
}

async function fromPage(postUrl) {
    const res = await fetch(postUrl, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' }, signal: AbortSignal.timeout(20_000) })
    const html = await res.text()
    if (!res.ok || !html) throw new Error(`page HTTP ${res.status}`)
    const video = metaContent(html, 'og:video') || metaContent(html, 'twitter:player:stream') || html.match(/"video_url"\s*:\s*"(https?:\\?[^"\\]+)"/i)?.[1]?.replace(/\\u0026/g, '&').replace(/\\\//g, '/')
    const image = metaContent(html, 'og:image')
    const mediaUrl = isHttp(video) ? video : (isHttp(image) ? image : '')
    if (!mediaUrl) throw new Error('page had no public media url')
    return { mediaUrl, caption: metaContent(html, 'og:description'), author: '' }
}

async function resolvePostIg(postUrl) {
    const cleanUrl = postUrl.replace(/[?#].*$/, '')
    let lastError = null
    for (const [name, provider] of [['vercel', fromVercel], ['reel-api', fromReelApi], ['page', fromPage]]) {
        try {
            const info = await provider(cleanUrl)
            const media = await downloadMediaIg(info.mediaUrl)
            return { items: [media], caption: info.caption, author: info.author, provider: name }
        } catch (err) { lastError = err }
    }
    try {
        const items = await downloadWithYtDlp(cleanUrl, true)
        return { items, caption: '', author: '', provider: 'yt-dlp' }
    } catch (err) { lastError = err }
    throw lastError || new Error('No provider returned usable media')
}

function usernameFromInput(value) {
    const raw = String(value || '').trim().replace(/^@/, '')
    if (!raw) return ''
    try { if (/^https?:\/\//i.test(raw)) return (new URL(raw).pathname.split('/').filter(Boolean)[0] || '').replace(/^@/, '').toLowerCase() } catch { }
    return raw.split(/[?/#]/)[0].toLowerCase()
}

const validUsername = u => /^[a-z0-9._]{1,30}$/i.test(u)
const fmt = v => (Number.isFinite(Number(v)) && v !== '' && v != null) ? Number(v).toLocaleString('en-US') : (v ? String(v) : '—')

async function lookupPrexzy(username) {
    const payload = await getJson(`https://prexzyapis.com/stalk/igstalkV2?user=${encodeURIComponent(username)}`, { timeout: 30_000 })
    if (!payload?.status || !payload?.data) throw new Error('profile not found')
    const d = payload.data
    return { username: usernameFromInput(d.username || username), fullName: d.name || username, biography: d.bio || d.biography || '', followers: d.followers, following: d.following, postsCount: d.uploads, verified: Boolean(d.verified), avatar: d.avatar || d.profilePic || d.profile_pic || '', posts: Array.isArray(d.posts) ? d.posts : [] }
}

async function lookupInstagramWeb(username) {
    const body = await getJson(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`, { timeout: 20_000, headers: { 'x-ig-app-id': IG_APP_ID, 'x-requested-with': 'XMLHttpRequest' } })
    const user = body?.data?.user || body?.user || body?.graphql?.user
    if (!user) throw new Error('profile unavailable')
    const timeline = user.edge_owner_to_timeline_media || {}
    return { username: user.username || username, fullName: user.full_name || username, biography: user.biography || '', followers: user.edge_followed_by?.count, following: user.edge_follow?.count, postsCount: timeline.count, verified: Boolean(user.is_verified), private: Boolean(user.is_private), avatar: user.profile_pic_url_hd || user.profile_pic_url || '', posts: (timeline.edges || []).map(e => e?.node).filter(Boolean).slice(0, 6).map(n => ({ shortcode: n.shortcode || '', image: n.display_url || n.thumbnail_src || '' })) }
}

async function lookupProfile(username) {
    try { return await lookupPrexzy(username) } catch { return lookupInstagramWeb(username) }
}

/* ==========================================
   FACEBOOK ENGINE
========================================== */
const FB_RE = /https?:\/\/(?:[\w-]+\.)?(?:facebook\.com|fb\.watch|fb\.com)\/[^\s]+/i

function pickFacebookVideoUrl(payload) {
    if (!payload) return null
    const roots = [payload, payload.data, payload.result, payload.data?.result].filter(Boolean)
    for (const root of roots) {
        const links = root.download_links || root.downloads || root.links
        if (Array.isArray(links)) {
            const preferred = links.find(i => /720|1080|hd/i.test(i?.quality || i?.label || '')) || links[0]
            const url = typeof preferred === 'string' ? preferred : preferred?.url
            if (isHttp(url)) return url
        }
        for (const key of ['hd', 'sd', 'video', 'videoUrl', 'video_url', 'download_url', 'downloadUrl', 'mp4', 'url']) {
            if (isHttp(root[key])) return root[key]
        }
    }
    return null
}

async function downloadAndFixFb(url) {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(90_000) })
    const type = res.headers.get('content-type') || ''
    if (!res.ok || !/video|octet-stream/i.test(type)) throw new Error(`bad file (status ${res.status}, type "${type}")`)
    const data = Buffer.from(await res.arrayBuffer())
    if (data.length < MIN_BYTES) throw new Error(`file too small (${data.length} bytes)`)
    if (data.length > MAX_BYTES) throw new Error(`file too large (${(data.length / 1048576).toFixed(1)} MB)`)
    return remux(data)
}

const FB_ENGINES = [
    { name: 'EliteProTech', url: u => `https://eliteprotech-apis.zone.id/download/facebook?url=${encodeURIComponent(u)}` },
    { name: 'Prexzy', url: u => `https://prexzyapis.com/download/facebook?url=${encodeURIComponent(u)}` },
    { name: 'Prexzy v2', url: u => `https://prexzyapis.com/download/facebookv2?url=${encodeURIComponent(u)}` },
    { name: 'Maher', url: u => `https://api.maher-zubair.tech/download/facebook?url=${encodeURIComponent(u)}` },
    { name: 'Siputzx', url: u => `https://api.siputzx.my.id/api/d/facebook?url=${encodeURIComponent(u)}` }
]

async function getVideoFb(url) {
    for (const engine of FB_ENGINES) {
        try {
            const json = await getJson(engine.url(url))
            if (json?.success === false || json?.status === false) continue
            const videoUrl = pickFacebookVideoUrl(json)
            if (!videoUrl) continue
            const buffer = await downloadAndFixFb(videoUrl)
            return { buffer, engine: engine.name }
        } catch (err) { }
    }
    try {
        const items = await downloadWithYtDlp(url, false)
        if (!items.length) throw new Error('No video found')
        return { buffer: items[0].buffer, engine: 'yt-dlp' }
    } catch (err) {
        return { buffer: null, error: err.message }
    }
}

/* ==========================================
   TIKTOK ENGINE
========================================== */
const TIKTOK_RE = /https?:\/\/(?:www\.|vm\.|vt\.|m\.)?tiktok\.com\/[^\s]+/i
const MAX_TT_IMAGES = 10

function absUrl(u) {
    if (!u || typeof u !== 'string') return null
    if (/^https?:\/\//.test(u)) return u
    if (u.startsWith('/')) return `https://www.tikwm.com${u}`
    return null
}

function firstUrl(v) {
    if (typeof v === 'string' && /^https?:\/\//.test(v)) return v
    if (Array.isArray(v) && typeof v[0] === 'string') return firstUrl(v[0])
    return null
}

async function fromTikwm(url) {
    const json = await getJson(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`)
    const d = json?.data
    if (!d) return null
    const meta = { title: d.title || 'TikTok', author: d.author?.nickname || d.author?.unique_id || 'Unknown', music: absUrl(d.music) }
    if (Array.isArray(d.images) && d.images.length) return { images: d.images.map(absUrl).filter(Boolean), meta }
    const videos = [absUrl(d.hdplay), absUrl(d.play), absUrl(d.wmplay)].filter(Boolean)
    return videos.length ? { videos, meta } : null
}

async function fromPrexzyTikTok(url) {
    const endpoints = [
        `https://prexzyapis.com/download/tiktokvideo?url=${encodeURIComponent(url)}`,
        `https://prexzyapis.com/download/tiktok?url=${encodeURIComponent(url)}`,
    ]
    for (const ep of endpoints) {
        try {
            const d = await getJson(ep)
            const root = d?.data || d?.result || d || {}
            const videos = [root.no_watermark, root.nowm, root.hdplay, root.play, root.video, root.url, root.download_url, root.videoUrl].map(firstUrl).filter(Boolean)
            if (videos.length) return { videos, meta: { title: root.title || root.desc || 'TikTok', author: root.author?.nickname || (typeof root.author === 'string' ? root.author : '') || root.username || 'Unknown' } }
        } catch { }
    }
    return null
}

async function resolveTikTok(url) {
    for (const fn of [fromTikwm, fromPrexzyTikTok]) {
        try {
            const out = await fn(url)
            if (out && (out.videos?.length || out.images?.length)) return out
        } catch (err) { console.error(`[TikTok Plugin] ${fn.name} failed:`, err.message) }
    }
    return null
}

async function downloadAndFixVideoTikTok(url) {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60_000) })
    const type = res.headers.get('content-type') || ''
    if (!res.ok || !(type.includes('video') || type.includes('octet-stream'))) throw new Error(`bad candidate (status ${res.status}, type "${type}")`)
    const data = Buffer.from(await res.arrayBuffer())
    if (data.length < MIN_BYTES) throw new Error(`file too small (${data.length} bytes)`)
    if (data.length > MAX_BYTES) throw new Error(`file too large (${(data.length / 1048576).toFixed(1)} MB)`)
    return remux(data)
}

/* ==========================================
   MAIN COMMAND ROUTER
========================================== */
export default {
    command: ['instagram', 'insta', 'ig', 'igdl', 'iguser', 'igstalk', 'facebook', 'fb', 'fbdl', 'fbvideo', 'tiktok', 'tt', 'ttdl', 'dl'],
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
        const command = ctx.command || 'dl'
        const arg = String(ctx.text || '').trim()
        const fullText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || ''
        
        const igUrl = arg.match(IG_URL_RE)?.[0] || fullText.match(IG_URL_RE)?.[0] || getQuotedText(msg).match(IG_URL_RE)?.[0]
        const fbUrl = arg.match(FB_RE)?.[0] || fullText.match(FB_RE)?.[0] || getQuotedText(msg).match(FB_RE)?.[0]
        const ttUrl = arg.match(TIKTOK_RE)?.[0] || fullText.match(TIKTOK_RE)?.[0] || getQuotedText(msg).match(TIKTOK_RE)?.[0]

        const isIgCmd = ['instagram', 'insta', 'ig', 'igdl', 'iguser', 'igstalk'].includes(command)
        const isFbCmd = ['facebook', 'fb', 'fbdl', 'fbvideo'].includes(command)
        const isTtCmd = ['tiktok', 'tt', 'ttdl'].includes(command)

        /* --- FACEBOOK ROUTE --- */
        if (isFbCmd || (command === 'dl' && fbUrl)) {
            if (!fbUrl) return reply(`🎬 *FACEBOOK DOWNLOADER*\nUsage: ${prefix}${command} <link>`)
            try {
                await react('⏳')
                const result = await getVideoFb(fbUrl)
                if (!result.buffer) {
                    await react('❌')
                    return reply(`❌ Failed to download.\n*Last error:* ${result.error || 'no engine returned a video'}`)
                }
                await sock.sendMessage(jid, { video: result.buffer, mimetype: 'video/mp4', caption: `🎬 *FACEBOOK DOWNLOADER*\n\n🚀 Engine: ${result.engine}\n\n> RAZA-MD` }, { quoted: msg })
                await react('✅')
            } catch (error) {
                await react('❌')
                await reply(`❌ An error occurred: ${error.message}`)
            }
            return
        }

        /* --- TIKTOK ROUTE --- */
        if (isTtCmd || (command === 'dl' && ttUrl)) {
            if (!ttUrl) return reply(`🎵 *TIKTOK DOWNLOADER*\nUsage: ${prefix}${command} <link>`)
            try {
                await react('⏳')
                const result = await resolveTikTok(ttUrl)
                if (!result) {
                    await react('❌')
                    return reply('❌ Failed to download. The video may be private, removed, or the URL is invalid.')
                }

                const { meta } = result
                const caption = `🎵 *${meta.title}*\n👤 ${meta.author}\n\n> RAZA-MD`

                if (result.images?.length) {
                    for (const [i, img] of result.images.slice(0, MAX_TT_IMAGES).entries()) {
                        await sock.sendMessage(jid, { image: { url: img }, ...(i === 0 ? { caption } : {}) }, { quoted: msg }).catch(() => {})
                    }
                    if (meta.music) {
                        await sock.sendMessage(jid, { audio: { url: meta.music }, mimetype: 'audio/mpeg' }, { quoted: msg }).catch(() => {})
                    }
                    return await react('✅')
                }

                let videoBuffer = null
                for (const candidate of result.videos) {
                    try {
                        videoBuffer = await downloadAndFixVideoTikTok(candidate)
                        if (videoBuffer) break
                    } catch (err) { }
                }

                if (!videoBuffer) {
                    await react('❌')
                    return reply('❌ Downloaded video was invalid or corrupted. Try again or send a different link.')
                }

                await sock.sendMessage(jid, { video: videoBuffer, mimetype: 'video/mp4', caption }, { quoted: msg })
                await react('✅')
            } catch (error) {
                await react('❌')
                await reply(`❌ An error occurred while downloading.\n\n*Reason:* ${error.message}`)
            }
            return
        }

        /* --- INSTAGRAM ROUTE --- */
        if (isIgCmd || (command === 'dl' && igUrl)) {
            if (igUrl) {
                try {
                    await react('⏳')
                    const { items, caption, author } = await resolvePostIg(igUrl)
                    const header = [ items[0].isVideo ? '📸 *Instagram Video*' : '📸 *Instagram Photo*', author ? `👤 ${author}` : '', caption ? `\n${caption.slice(0, 400)}` : '', '\n> RAZA-MD' ].filter(Boolean).join('\n')

                    for (const [i, item] of items.slice(0, 10).entries()) {
                        const cap = i === 0 ? header : undefined
                        if (item.isVideo) await sock.sendMessage(jid, { video: item.buffer, mimetype: 'video/mp4', caption: cap }, { quoted: msg })
                        else await sock.sendMessage(jid, { image: item.buffer, caption: cap }, { quoted: msg })
                    }
                    return await react('✅')
                } catch (error) {
                    await react('❌')
                    return reply(`❌ Could not download that Instagram post.\n*Reason:* ${error.message}`)
                }
            }

            const username = usernameFromInput(arg)
            if (!username) return reply(`📸 *INSTAGRAM DOWNLOADER*\n\n• Post: ${prefix}${command} <url>\n• Profile: ${prefix}${command} <username>`)
            if (!validUsername(username)) return reply(`📸 Use a valid Instagram username.`)

            try {
                await react('⏳')
                const p = await lookupProfile(username)
                const posts = (p.posts || []).filter(x => x?.shortcode).slice(0, 6)
                const caption = [ '📸 *Instagram Profile*', `@${usernameFromInput(p.username || username)}${p.verified ? ' ✓' : ''}`, `*${p.fullName || username}*`, '', `${fmt(p.postsCount)} posts · ${fmt(p.followers)} followers · ${fmt(p.following)} following`, p.private ? '🔒 Private account' : '', p.biography ? `\n${String(p.biography).slice(0, 500)}` : '', `\n🔗 https://instagram.com/${usernameFromInput(p.username || username)}`, posts.length ? `\n*Recent posts*\n${posts.map((x, i) => `${i + 1}. https://instagram.com/p/${x.shortcode}/`).join('\n')}` : '', '\n> RAZA-MD' ].filter(Boolean).join('\n')

                if (isHttp(p.avatar)) await sock.sendMessage(jid, { image: { url: p.avatar }, caption }, { quoted: msg }).catch(() => reply(caption))
                else await reply(caption)
                await react('✅')
            } catch (error) {
                await react('❌')
                await reply(`❌ I could not read @${username} right now.`)
            }
            return
        }

        /* --- FALLBACK HELP --- */
        reply(`📥 *SOCIAL MEDIA DOWNLOADER*\n\n• ${prefix}ig <url/username>\n• ${prefix}fb <url>\n• ${prefix}tt <url>\n• ${prefix}dl <url> (auto-detect)`)
    }
}
