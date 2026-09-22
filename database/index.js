import fs from 'node:fs'
import path from 'node:path'

const DB_DIR = path.join(process.cwd(), 'database')

// Ensure directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true })
}

/**
 * Reads data from a JSON file in the database directory
 */
export function getDb(filename, defaultData = {}) {
  const filePath = path.join(DB_DIR, filename.endsWith('.json') ? filename : `${filename}.json`)
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2))
      return defaultData
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (err) {
    console.error(`[DB READ ERROR] ${filename}:`, err.message)
    return defaultData
  }
}

/**
 * Saves data to a JSON file in the database directory
 */
export function saveDb(filename, data) {
  const filePath = path.join(DB_DIR, filename.endsWith('.json') ? filename : `${filename}.json`)
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
    return true
  } catch (err) {
    console.error(`[DB SAVE ERROR] ${filename}:`, err.message)
    return false
  }
}