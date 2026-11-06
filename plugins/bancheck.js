/**
 * .banchecker — WhatsApp ban-status checker
 * Usage: Reply to a user + .banchecker   OR   .banchecker <number>
 */

const BARON_API_BASE = 'https://baron0.com'
const BARON_API_KEY = String(
    process.env.BANCHECK_API_KEY || process.env.BARON_API_KEY || ''
).trim()

// ── Number parsing ───────────────────────────────────────────────────
function normalizeNumber(input) {
    if (!input) return null
    let num = String(input).replace(/[^0-9+]/g, '')
    if (!num) return null
    if (num.startsWith('+')) num = num.slice(1)
    if (num.endsWith('@s.whatsapp.net')) {
        num = num.replace('@s.whatsapp.net', '')
    }
    if (num.length < 8 || num.length > 15) return null
    return num
}

// ── Country lookup ───────────────────────────────────────────────────
function getCountry(num) {
    const codes = [
        ['1', 'United States/Canada'], ['20', 'Egypt'], ['27', 'South Africa'],
        ['30', 'Greece'], ['31', 'Netherlands'], ['33', 'France'],
        ['34', 'Spain'], ['36', 'Hungary'], ['39', 'Italy'],
        ['43', 'Austria'], ['44', 'United Kingdom'], ['45', 'Denmark'],
        ['46', 'Sweden'], ['47', 'Norway'], ['48', 'Poland'],
        ['49', 'Germany'], ['51', 'Peru'], ['52', 'Mexico'],
        ['54', 'Argentina'], ['55', 'Brazil'], ['56', 'Chile'],
        ['57', 'Colombia'], ['58', 'Venezuela'], ['60', 'Malaysia'],
        ['61', 'Australia'], ['62', 'Indonesia'], ['63', 'Philippines'],
        ['64', 'New Zealand'], ['65', 'Singapore'], ['66', 'Thailand'],
        ['81', 'Japan'], ['82', 'South Korea'], ['84', 'Vietnam'],
        ['86', 'China'], ['90', 'Turkey'], ['91', 'India'],
        ['92', 'Pakistan'], ['93', 'Afghanistan'], ['94', 'Sri Lanka'],
        ['95', 'Myanmar'], ['98', 'Iran'],
        ['212', 'Morocco'], ['213', 'Algeria'], ['216', 'Tunisia'],
        ['218', 'Libya'], ['220', 'Gambia'], ['221', 'Senegal'],
        ['222', 'Mauritania'], ['223', 'Mali'], ['224', 'Guinea'],
        ['225', 'Ivory Coast'], ['226', 'Burkina Faso'], ['227', 'Niger'],
        ['228', 'Togo'], ['229', 'Benin'], ['230', 'Mauritius'],
        ['231', 'Liberia'], ['232', 'Sierra Leone'], ['233', 'Ghana'],
        ['234', 'Nigeria'], ['235', 'Chad'], ['237', 'Cameroon'],
        ['243', 'DR Congo'], ['254', 'Kenya'], ['255', 'Tanzania'],
        ['256', 'Uganda'], ['257', 'Burundi'], ['258', 'Mozambique'],
        ['260', 'Zambia'], ['263', 'Zimbabwe'], ['267', 'Botswana'],
        ['268', 'Eswatini'], ['269', 'Comoros'],
    ]
    const sorted = codes.slice().sort((a, b) => b[0].length - a[0].length)
    for (const [code, name] of sorted) {
        if (num.startsWith(code)) return name
    }
    return 'Unknown'
}

async function checkWithBaron(number) {
    if (!BARON_API_KEY) throw new Error('Baron API key is not configured. Add BANCHECK_API_KEY to your environment variables.')
    
    const res = await fetch(`${BARON_API_BASE}/api/v2/check`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${BARON_API_KEY}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: JSON.stringify({ number: `+${number}` }),
        signal: AbortSignal.timeout(20000),
    })

    let body
    try {
        body = await res.json()
    } catch (_) {
        throw new Error(`Baron API returned HTTP ${res.status} with a non-JSON response`)
    }

    if (!res.ok) {
        const detail = body?.detail || body?.error || `HTTP ${res.status}`
        throw new Error(`${body?.title || 'Baron API error'}: ${detail}`)
    }
    if (typeof body?.banned !== 'boolean') {
        throw new Error('Baron API returned an invalid ban result')
    }
    return body
}

export default {
    command: ['bancheck', 'checkban', 'isbanned'],
    category: 'owner',
    description: 'Accurately check if a WhatsApp number is banned or active',

    async run(ctx) {
        const { sock, message } = ctx
        const msg = message || ctx.msg
        if (!sock || !msg) return

        const jid = msg.key?.remoteJid
        if (!jid) return

        const reply = (text) => sock.sendMessage(jid, { text }, { quoted: msg })
        const react = (emoji) => sock.sendMessage(jid, { react: { text: emoji, key: msg.key } }).catch(() => {})
        const prefix = ctx.prefix || '.'

        // 1. Get target number from reply or arguments
        let target = null
        try {
            const contextInfo = msg.message?.extendedTextMessage?.contextInfo || msg.message?.imageMessage?.contextInfo
            const who = contextInfo?.participant || contextInfo?.remoteJid
            if (who && who.endsWith('@s.whatsapp.net')) target = normalizeNumber(who)
        } catch (_) {}

        if (!target) {
            target = normalizeNumber(String(ctx.text || '').trim())
        }

        if (!target) {
            return reply(
                `*╔══ 🛡️ ʙᴀɴ ᴄʜᴇᴄᴋᴇʀ ══╗*\n` +
                `║  ʙᴀʀᴏɴ ᴀᴘɪ ᴠᴇʀɪꜰɪᴄᴀᴛɪᴏɴ  ║\n` +
                `╚════════════════════╝\n\n` +
                `*ᴜsᴀɢᴇ:*\n` +
                `▸ ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴜsᴇʀ + *${prefix}${ctx.command}*\n` +
                `▸ ${prefix}${ctx.command} <ɴᴜᴍʙᴇʀ>\n` +
                `*ᴇxᴀᴍᴘʟᴇ:* ${prefix}${ctx.command} 2349127814853`
            )
        }

        try {
            await react('⏳')
            
            const baron = await checkWithBaron(target)
            const isBanned = baron.banned === true
            const country = getCountry(target)
            
            const statusIcon = isBanned ? '🔴' : '🟢'
            const statusText = isBanned ? 'ʙᴀɴɴᴇᴅ' : 'ᴀᴄᴛɪᴠᴇ (ᴜɴʙᴀɴɴᴇᴅ)'
            const reasonText = baron.reason ? `\n┃ 📝 ʀᴇᴀsᴏɴ: ${baron.reason}` : ''

            const resultText = 
                `╭━━━〔 ☠️ ʙᴀɴ ᴄʜᴇᴄᴋᴇʀ ☠️ 〕━━━┈⊷\n` +
                `┃\n` +
                `┃ 📱 ɴᴜᴍʙᴇʀ: +${target}\n` +
                `┃ 🌍 ʀᴇɢɪᴏɴ: ${country}\n` +
                `┃ \n` +
                `┃ 📊 sᴛᴀᴛᴜs: ${statusIcon} *${statusText}*${reasonText}\n` +
                `┃\n` +
                `╰━━━━━━━━━━━━━━━━━━━━┈⊷\n\n` +
                `> 🛡️ ᴠᴇʀɪꜰɪᴇᴅ ʙʏ ʙᴀʀᴏɴ ᴀᴘɪ\n` +
                `> 🤖 ʀᴀᴢᴀ-ᴍᴅ`

            await reply(resultText)
            await react('✅')

        } catch (error) {
            console.error('[BanChecker] API failed:', error.message)
            await react('❌')
            return reply(`❌ ʙᴀɴ ᴄʜᴇᴄᴋ ꜰᴀɪʟᴇᴅ:\n${error.message}`)
        }
    }
}
