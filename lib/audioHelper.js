// lib/audioHelper.js
import ffmpeg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'
import fs from 'node:fs'
import { Readable } from 'node:stream'

ffmpeg.setFfmpegPath(ffmpegStatic)

/**
 * Converts an audio file or URL to a Readable stream of Float32Array (16kHz mono)
 * @param {string} source - File path or HTTP URL
 * @returns {Readable} - Stream of Float32Array chunks (960 samples per chunk)
 */
export function createPcmStream(source) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const command = ffmpeg(source)
      .audioFrequency(16000)
      .audioChannels(1)
      .format('f32le') // 32-bit float little-endian
      .on('error', (err) => reject(err))
      .on('end', () => {
        // Combine all chunks into one big buffer
        const buffer = Buffer.concat(chunks)
        // Create a stream that emits 960-sample Float32Arrays
        const stream = new Readable({
          read() {
            const chunkSize = 960 * 4 // 960 samples * 4 bytes per float
            if (buffer.length === 0) {
              this.push(null)
              return
            }
            const chunk = buffer.subarray(0, chunkSize)
            // Remove the chunk we just took
            buffer = buffer.subarray(chunkSize) 
            // Convert Buffer to Float32Array
            const floatArray = new Float32Array(chunk.buffer, chunk.byteOffset, chunk.length / 4)
            this.push(floatArray)
          }
        })
        resolve(stream)
      })

    const stream = command.pipe()
    stream.on('data', (chunk) => chunks.push(chunk))
  })
}
