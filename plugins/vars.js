const HEROKU_API = 'https://api.heroku.com'

function getConfig() {
  const apiKey = (process.env.HEROKU_API_KEY || '').trim()
  const appName = (process.env.HEROKU_APP_NAME || '').trim()
  if (!apiKey) throw new Error('HEROKU_API_KEY is not set on this dyno')
  if (!appName) throw new Error('HEROKU_APP_NAME is not set on this dyno')
  return { apiKey, appName }
}

async function heroku(method, route, body) {
  const { apiKey } = getConfig()
  const res = await fetch(HEROKU_API + route, {
    method,
    headers: {
      Accept: 'application/vnd.heroku+json; version=3',
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000)
  })
  const text = await res.text()
  let data
  try { data = text ? JSON.parse(text) : {} } catch { data = {} }
  if (!res.ok) {
    throw new Error(data.message || data.id || `Heroku ${res.status}`)
  }
  return data
}

async function patchVars(vars) {
  const { appName } = getConfig()
  return heroku('PATCH', `/apps/${encodeURIComponent(appName)}/config-vars`, vars)
}

function maskValue(key, value) {
  const v = String(value)
  const sensitive = /(SECRET|TOKEN|PASSWORD|PASS|CREDENTIAL|PRIVATE|SESSION_ID|API_KEY|AUTH)/i.test(key)
  if (!sensitive) return v
  if (v.length <= 8) return '*'.repeat(v.length)
  return `${v.slice(0, 3)}…${v.slice(-3)} (${v.length} chars)`
}

/*
 * Tokenize text into words, keeping quoted segments together.
 *   KEY="hello world" OTHER=token
 * → ["KEY=\"hello world\"", "OTHER=token"]
 */
function tokenize(text) {
  const tokens = []
  let cur = ''
  let quote = null
  for (const ch of text) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      cur += ch
      quote = ch
    } else if (/\s/.test(ch)) {
      if (cur) { tokens.push(cur); cur = '' }
    } else {
      cur += ch
    }
  }
  if (cur) tokens.push(cur)
  return tokens
}

function parseSetOperations(text) {
  const tokens = tokenize(text)
  const vars = {}
  const errors = []
  for (const token of tokens) {
    const eq = token.indexOf('=')
    if (eq <= 0) { errors.push(`missing '=' in: ${token}`); continue }
    const key = token.slice(0, eq).trim()
    let value = token.slice(eq + 1)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      errors.push(`invalid key: ${key}`)
      continue
    }
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    vars[key] = value
  }
  return { vars, errors }
}

async function reply(sock, jid, message, text) {
  return sock.sendMessage(jid, { text }, { quoted: message }).catch(() => {})
}

export default {
  command: ['setvar', 'delvar'],
  category: 'owner',
  description: 'Set or delete Heroku config vars',

  async run({ sock, message, args, text, command, isOwner }) {
    const jid = message?.key?.remoteJid
    if (!jid) return

    if (!isOwner) {
      return reply(sock, jid, message, '❌ ᴏɴʟʏ ᴛʜᴇ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴍᴀɴᴀɢᴇ ʜᴇʀᴏᴋᴜ ᴠᴀʀꜱ')
    }

    try {
      getConfig()
    } catch (e) {
      return reply(sock, jid, message,
        `❌ ʜᴇʀᴏᴋᴜ ᴀᴄᴄᴇꜱꜱ ɴᴏᴛ ᴄᴏɴꜰɪɢᴜʀᴇᴅ\n\n${e.message}\n\n` +
        `ꜱᴇᴛ ᴏɴᴄᴇ ᴠɪᴀ ᴄʟɪ:\n` +
        `heroku config:set HEROKU_API_KEY=<key> HEROKU_APP_NAME=<app> -a <app>`)
    }

    /* ── SETVAR ── */
    if (command === 'setvar') {
      const { vars, errors } = parseSetOperations(text)
      if (errors.length) {
        return reply(sock, jid, message,
          '❌ ɪɴᴠᴀʟɪᴅ ɪɴᴘᴜᴛ\n\n' + errors.map(e => '• ' + e).join('\n'))
      }
      const keys = Object.keys(vars)
      if (!keys.length) {
        return reply(sock, jid, message,
          '⚠️ ᴜꜱᴀɢᴇ: .ꜱᴇᴛᴠᴀʀ KEY=value [KEY2=value2 …]')
      }

      const preview = keys.map(k => `│ ${k} = ${maskValue(k, vars[k])}`).join('\n')

      await reply(sock, jid, message,
        `⚙️ ꜱᴇᴛᴛɪɴɢ ${keys.length} ᴠᴀʀ(ꜱ)…\n\n${preview}\n\nᴛʜᴇ ʙᴏᴛ ᴡɪʟʟ ʀᴇꜱᴛᴀʀᴛ ɪɴ 5-30ꜱ`)

      try {
        await patchVars(vars)
        console.log(`[HEROKUVAR] Set: ${keys.join(', ')}`)
        return reply(sock, jid, message,
          `✅ ꜱᴇᴛ ꜱᴜᴄᴄᴇꜱꜱꜰᴜʟ\n\n` +
          keys.map(k => `• ${k} = ${maskValue(k, vars[k])}`).join('\n') +
          `\n\n⏳ ʀᴇꜱᴛᴀʀᴛɪɴɢ ɴᴏᴡ — ʙᴏᴛ ᴡɪʟʟ ʙᴇ ʙᴀᴄᴋ ꜱʜᴏʀᴛʟʏ`)
      } catch (e) {
        console.error('[HEROKUVAR] Set failed:', e.message)
        return reply(sock, jid, message, `❌ ꜱᴇᴛ ꜰᴀɪʟᴇᴅ\n\n${e.message}`)
      }
    }

    /* ── DELVAR ── */
    if (command === 'delvar') {
      const keys = args.map(k => String(k || '').trim()).filter(Boolean)
      if (!keys.length) {
        return reply(sock, jid, message,
          '⚠️ ᴜꜱᴀɢᴇ: .ᴅᴇʟᴠᴀʀ KEY [KEY2 …]')
      }
      const invalid = keys.filter(k => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
      if (invalid.length) {
        return reply(sock, jid, message,
          `❌ ɪɴᴠᴀʟɪᴅ ᴋᴇʏ(ꜱ): ${invalid.join(', ')}`)
      }

      const payload = {}
      for (const k of keys) payload[k] = null

      await reply(sock, jid, message,
        `⚙️ ᴅᴇʟᴇᴛɪɴɢ ${keys.length} ᴠᴀʀ(ꜱ)…\n\n${keys.map(k => `• ${k}`).join('\n')}\n\nᴛʜᴇ ʙᴏᴛ ᴡɪʟʟ ʀᴇꜱᴛᴀʀᴛ ɪɴ 5-30ꜱ`)

      try {
        await patchVars(payload)
        console.log(`[HEROKUVAR] Deleted: ${keys.join(', ')}`)
        return reply(sock, jid, message,
          `✅ ᴅᴇʟᴇᴛᴇᴅ\n\n${keys.map(k => `• ${k}`).join('\n')}\n\n⏳ ʀᴇꜱᴛᴀʀᴛɪɴɢ ɴᴏᴡ`)
      } catch (e) {
        console.error('[HEROKUVAR] Delete failed:', e.message)
        return reply(sock, jid, message, `❌ ᴅᴇʟᴇᴛᴇ ꜰᴀɪʟᴇᴅ\n\n${e.message}`)
      }
    }
  }
}
