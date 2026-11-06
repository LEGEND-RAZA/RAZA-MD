import fs from 'node:fs'
import path from 'node:path'

if (process.platform !== 'linux') process.exit(0)

const file = process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'
const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${file}`
const dir = path.join('node_modules', 'yt-dlp-exec', 'bin')
const dest = path.join(dir, 'yt-dlp')

try {
    fs.mkdirSync(dir, { recursive: true })
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
    fs.chmodSync(dest, 0o755)
    console.log('[postinstall] yt-dlp standalone binary installed')
} catch (err) {
    console.error('[postinstall] yt-dlp download failed:', err.message)
}
