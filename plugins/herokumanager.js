import { getDb, saveDb } from '../database/index.js'

export default {
  command: ['hb'],
  description: 'Heroku manager',

  async run({
    sock,
    message,
    args,
    isOwner
  }) {
    if (!isOwner) return

    const jid =
      message?.key?.remoteJid

    if (!jid) return

    const send = async (text) => {
      return sock.sendMessage(
        jid,
        { text },
        { quoted: message }
      )
    }

    const db =
      getDb('heroku.json', {})

    const cmd =
      args?.[0]?.toLowerCase() || ''

    // SET API
    if (cmd === 'set') {
      const api =
        args
          .slice(1)
          .join(' ')
          .trim()

      if (!api) {
        return send(
          'Use: .hb set HEROKU_API_KEY'
        )
      }

      db.heroku_api_key = api

      saveDb(
        'heroku.json',
        db
      )

      return send(
        '✅ Heroku API key saved'
      )
    }

    const api =
      db.heroku_api_key

    if (!api) {
      return send(
        '❌ Heroku API not set\n\n' +
        'Use:\n.hb set HEROKU_API_KEY'
      )
    }

    const headers = {
      Authorization:
        `Bearer ${api}`,

      Accept:
        'application/vnd.heroku+json; version=3'
    }

    try {

      // LIST ALL APPS
      if (cmd === 'list') {
        const res =
          await fetch(
            'https://api.heroku.com/apps',
            { headers }
          )

        const apps =
          await res.json()

        if (!res.ok) {
          return send(
            JSON.stringify(
              apps,
              null,
              2
            )
          )
        }

        if (!apps.length) {
          return send(
            'No Heroku apps found.'
          )
        }

        return send(
          '📦 Heroku Apps\n\n' +
          apps
            .map(
              (a, i) =>
                `${i + 1}. ${a.name}`
            )
            .join('\n')
        )
      }

      // DELETE ONE APP
      if (cmd === 'del') {
        const appName =
          args[1]

        if (!appName) {
          return send(
            'Use: .hb del APP_NAME'
          )
        }

        const res =
          await fetch(
            `https://api.heroku.com/apps/${encodeURIComponent(appName)}`,
            {
              method: 'DELETE',
              headers
            }
          )

        if (
          res.status === 202 ||
          res.status === 204
        ) {
          return send(
            `✅ Deleted: ${appName}`
          )
        }

        const data =
          await res
            .json()
            .catch(() => ({}))

        return send(
          '❌ Delete failed:\n' +
          JSON.stringify(
            data,
            null,
            2
          )
        )
      }

      // DELETE ALL
      if (cmd === 'delall') {
        const res =
          await fetch(
            'https://api.heroku.com/apps',
            { headers }
          )

        const apps =
          await res.json()

        if (!res.ok) {
          return send(
            JSON.stringify(
              apps,
              null,
              2
            )
          )
        }

        if (!apps.length) {
          return send(
            'No Heroku apps found.'
          )
        }

        return send(
          `⚠️ ${apps.length} apps found.\n\n` +
          apps
            .map(
              a => `• ${a.name}`
            )
            .join('\n') +
          '\n\nConfirm with:\n' +
          '.hb confirmall'
        )
      }

      // CONFIRM DELETE ALL
      if (cmd === 'confirmall') {
        const res =
          await fetch(
            'https://api.heroku.com/apps',
            { headers }
          )

        const apps =
          await res.json()

        if (!res.ok) {
          return send(
            JSON.stringify(
              apps,
              null,
              2
            )
          )
        }

        if (!apps.length) {
          return send(
            'No Heroku apps found.'
          )
        }

        let deleted = 0
        const failed = []

        for (const app of apps) {
          try {
            const r =
              await fetch(
                `https://api.heroku.com/apps/${encodeURIComponent(app.name)}`,
                {
                  method: 'DELETE',
                  headers
                }
              )

            if (
              r.status === 202 ||
              r.status === 204
            ) {
              deleted++
            } else {
              failed.push(
                app.name
              )
            }

          } catch {
            failed.push(
              app.name
            )
          }
        }

        return send(
          `🗑️ Delete all completed\n\n` +
          `✅ Deleted: ${deleted}\n` +
          `❌ Failed: ${failed.length}` +
          (
            failed.length
              ? `\n\n${failed.join('\n')}`
              : ''
          )
        )
      }

      // KEEP SELECTED APPS
      if (cmd === 'expect') {
        const keep =
          args
            .slice(1)
            .join(' ')
            .split(',')
            .map(
              x => x.trim()
            )
            .filter(Boolean)

        if (!keep.length) {
          return send(
            'Use: .hb expect APP1,APP2,APP3'
          )
        }

        const res =
          await fetch(
            'https://api.heroku.com/apps',
            { headers }
          )

        const apps =
          await res.json()

        if (!res.ok) {
          return send(
            JSON.stringify(
              apps,
              null,
              2
            )
          )
        }

        const remove =
          apps.filter(
            app =>
              !keep.includes(
                app.name
              )
          )

        if (!remove.length) {
          return send(
            'Nothing to delete.\n\n' +
            'Kept:\n' +
            keep
              .map(
                x => `• ${x}`
              )
              .join('\n')
          )
        }

        let deleted = 0
        const failed = []

        for (const app of remove) {
          try {
            const r =
              await fetch(
                `https://api.heroku.com/apps/${encodeURIComponent(app.name)}`,
                {
                  method: 'DELETE',
                  headers
                }
              )

            if (
              r.status === 202 ||
              r.status === 204
            ) {
              deleted++
            } else {
              failed.push(
                app.name
              )
            }

          } catch {
            failed.push(
              app.name
            )
          }
        }

        return send(
          `🛡️ Expect deletion completed\n\n` +
          `✅ Deleted: ${deleted}\n` +
          `❌ Failed: ${failed.length}\n\n` +
          `Kept:\n${keep.join('\n')}` +
          (
            failed.length
              ? `\n\nFailed:\n${failed.join('\n')}`
              : ''
          )
        )
      }

      // HELP
      return send(
        `Heroku Commands:\n\n` +
        `.hb set HEROKU_API_KEY\n` +
        `.hb list\n` +
        `.hb del APP_NAME\n` +
        `.hb delall\n` +
        `.hb confirmall\n` +
        `.hb expect APP1,APP2`
      )

    } catch (e) {
      return send(
        '❌ Error: ' +
        (e?.message || e)
      )
    }
  }
}