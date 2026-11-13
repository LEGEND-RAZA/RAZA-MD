import ffmpegPkg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'
import { Readable } from 'node:stream'

const ffmpeg = ffmpegPkg
ffmpeg.setFfmpegPath(ffmpegStatic)

/**
 * Converts an audio source (file path or URL) to a stream of Float32Array chunks.
 * @param {string} source - File path or HTTP URL
 * @returns {Promise<Readable>} - Stream emitting Float32Array chunks (960 samples each)
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
        const buffer = Buffer.concat(chunks)
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

    const stream = command.pipe()
    stream.on('data', (chunk) => chunks.push(chunk))
  })
}
