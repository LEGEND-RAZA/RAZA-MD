import { spawn } from 'node:child_process'
import ffmpegStatic from 'ffmpeg-static'
import { Readable } from 'node:stream'

const FFMPEG = ffmpegStatic || 'ffmpeg'

export function createPcmStream(source) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(FFMPEG, [
      '-i', source,
      '-f', 'f32le',
      '-ac', '1',
      '-ar', '16000',
      'pipe:1'
    ])

    let buffer = Buffer.alloc(0)
    const chunks = []

    ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk))
    
    ffmpeg.on('error', reject)
    ffmpeg.on('close', (code) => {
      if (code !== 0) return reject(new Error('FFmpeg audio conversion failed'))
      buffer = Buffer.concat(chunks)
      
      const stream = new Readable({
        read() {
          const chunkSize = 960 * 4 // 960 samples * 4 bytes per float
          if (buffer.length === 0) {
            this.push(null)
            return
          }
          const chunk = buffer.subarray(0, chunkSize)
          buffer = buffer.subarray(chunkSize)
          const floatArray = new Float32Array(chunk.buffer, chunk.byteOffset, chunk.length / 4)
          this.push(floatArray)
        }
      })
      resolve(stream)
    })
  })
}
