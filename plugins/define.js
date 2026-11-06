/**
 * Define Command — Get word definitions
 * Usage: .define <word>
 */

async function getDefinition(word) {
    const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    return await res.json()
}

export default {
    command: ['define', 'dictionary', 'meaning', 'def'],
    category: 'ai',
    description: 'Get the definition of a word',

    async run(ctx) {
        const { sock, message } = ctx
        const msg = message || ctx.msg
        if (!sock || !msg) return

        const jid = msg.key?.remoteJid
        if (!jid) return

        const reply = (text) => sock.sendMessage(jid, { text }, { quoted: msg })
        const prefix = ctx.prefix || '.'
        const command = ctx.command || 'define'

        // Get the first word from the arguments
        const word = String(ctx.text || '').trim().split(/\s+/)[0].toLowerCase()

        if (!word) {
            return reply(
                `📚 *ᴅɪᴄᴛɪᴏɴᴀʀʏ*\n\n` +
                `ᴜsᴀɢᴇ: ${prefix}${command} <ᴡᴏʀᴅ>\n` +
                `ᴇxᴀᴍᴘʟᴇ: ${prefix}${command} sᴇʀᴇɴᴅɪᴘɪᴛʏ`
            )
        }

        try {
            const data = await getDefinition(word)
            
            if (data.title === 'No Definitions Found' || !data || !data.length) {
                return reply(`❌ ɴᴏ ᴅᴇꜰɪɴɪᴛɪᴏɴ ꜰᴏᴜɴᴅ ꜰᴏʀ "${word}".`)
            }

            const entry = data[0]
            let response = `📚 *ᴅᴇꜰɪɴɪᴛɪᴏɴ: ${entry.word}*\n`
            
            if (entry.phonetic) {
                response += `🔊 ${entry.phonetic}\n`
            }
            response += `\n`

            entry.meanings.slice(0, 3).forEach((meaning, idx) => {
                response += `*${idx + 1}. ${meaning.partOfSpeech}*\n`
                meaning.definitions.slice(0, 2).forEach((def, dIdx) => {
                    response += `   ${dIdx + 1}. ${def.definition}\n`
                    if (def.example) {
                        response += `      💬 "${def.example}"\n`
                    }
                })
                response += `\n`
            })

            response += `> RAZA-MD`
            reply(response)

        } catch (err) {
            reply(`❌ ᴄᴏᴜʟᴅ ɴᴏᴛ ꜰɪɴᴅ ᴅᴇꜰɪɴɪᴛɪᴏɴ ꜰᴏʀ "${word}".`)
        }
    }
}
