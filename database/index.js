import mysql from 'mysql2/promise'

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'defaultdb',
  ssl: {
    rejectUnauthorized: false
  },
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0
})

const cache = new Map()
const saveQueues = new Map()

await pool.execute(`
  CREATE TABLE IF NOT EXISTS bot_database (
    filename VARCHAR(255) NOT NULL PRIMARY KEY,
    data JSON NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ON UPDATE CURRENT_TIMESTAMP
  )
`)

const [rows] = await pool.execute(
  'SELECT filename, data FROM bot_database'
)

for (const row of rows) {
  try {
    cache.set(
      row.filename,
      typeof row.data === 'string'
        ? JSON.parse(row.data)
        : row.data
    )
  } catch (err) {
    console.error(
      `[DB LOAD ERROR] ${row.filename}:`,
      err.message
    )
  }
}

console.log(`[DB] MySQL connected: ${rows.length} database entries loaded`)

/**
 * Reads data from MySQL
 */
export function getDb(filename, defaultData = {}) {
  const key = filename.endsWith('.json')
    ? filename
    : `${filename}.json`

  if (!cache.has(key)) {
    cache.set(key, structuredClone(defaultData))

    saveDb(key, defaultData)
  }

  return cache.get(key)
}

/**
 * Saves data to MySQL
 */
export function saveDb(filename, data) {
  const key = filename.endsWith('.json')
    ? filename
    : `${filename}.json`

  cache.set(key, data)

  const previousSave = saveQueues.get(key) || Promise.resolve()

  const currentSave = previousSave
    .catch(() => {})
    .then(async () => {
      try {
        await pool.execute(
          `
          INSERT INTO bot_database (filename, data)
          VALUES (?, ?)
          ON DUPLICATE KEY UPDATE
            data = VALUES(data),
            updated_at = CURRENT_TIMESTAMP
          `,
          [
            key,
            JSON.stringify(data)
          ]
        )
      } catch (err) {
        console.error(
          `[DB SAVE ERROR] ${key}:`,
          err.message
        )
      }
    })

  saveQueues.set(key, currentSave)

  return true
}

/**
 * Closes MySQL connection
 */
export async function closeDb() {
  await pool.end()
}
