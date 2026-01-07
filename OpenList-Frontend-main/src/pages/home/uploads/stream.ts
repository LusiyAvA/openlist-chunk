import { password } from "~/store"
import { getSetting } from "~/store"
import { EmptyResp } from "~/types"
import { r } from "~/utils"
import { SetUpload, Upload } from "./types"
import { calculateHash } from "./util"

// Default chunk size: 95MB (below Cloudflare's 100MB limit)
const DEFAULT_CHUNK_SIZE = 95 * 1024 * 1024

// Get chunk size from server settings or use default
const getChunkSize = (): number => {
  const configuredSize = getSetting("stream_upload_chunk_size")
  if (configuredSize) {
    return parseInt(configuredSize) * 1024 * 1024
  }
  return DEFAULT_CHUNK_SIZE
}

// Chunked stream upload for large files
async function chunkedStreamUpload(
  uploadPath: string,
  file: File,
  setUpload: SetUpload,
  overwrite: boolean,
  chunkSize: number,
): Promise<undefined> {
  const totalSize = file.size
  const totalChunks = Math.ceil(totalSize / chunkSize)

  console.log(`[Stream Chunked] Starting: ${file.name}`)
  console.log(`[Stream Chunked] Size: ${(totalSize / 1024 / 1024).toFixed(2)} MB, Chunks: ${totalChunks}`)

  // State for speed calculation
  let totalUploadedBytes = 0
  const startTime = Date.now()
  let lastTime = startTime
  let lastLoaded = 0

  // Upload each chunk
  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize
    const end = Math.min(start + chunkSize, totalSize)
    const chunk = file.slice(start, end)  // Blob.slice - no memory copy
    const chunkRealSize = end - start

    let attempt = 0
    let success = false

    while (attempt < 3 && !success) {
      try {
        attempt++
        const retryMsg = attempt > 1 ? ` (Retry ${attempt}/3)` : ""
        setUpload("msg", `Uploading chunk ${i + 1}/${totalChunks}${retryMsg}`)

        const chunkStartTime = Date.now()

        // PUT request with Content-Range header
        const resp: any = await r.put("/fs/put", chunk, {
          headers: {
            "File-Path": encodeURIComponent(uploadPath),
            "Content-Type": file.type || "application/octet-stream",
            "Content-Range": `bytes ${start}-${end - 1}/${totalSize}`,
            "Last-Modified": file.lastModified,
            Password: password(),
            Overwrite: overwrite.toString(),
          },
          onUploadProgress: (progressEvent: any) => {
            if (progressEvent.total) {
              const currentTotal = totalUploadedBytes + progressEvent.loaded
              const now = Date.now()
              const duration = (now - lastTime) / 1000

              if (duration > 0.5) {
                const loadedDiff = currentTotal - lastLoaded
                const instantSpeed = loadedDiff / duration
                setUpload("speed", instantSpeed)
                lastTime = now
                lastLoaded = currentTotal
              }

              // Overall progress
              const overallProgress = ((totalUploadedBytes + progressEvent.loaded) / totalSize) * 100
              setUpload("progress", overallProgress)
            }
          },
        })

        if (resp.code !== 200) {
          throw new Error(`Server returned ${resp.code}: ${resp.message}`)
        }

        totalUploadedBytes += chunkRealSize
        const elapsed = Date.now() - chunkStartTime
        const chunkSpeed = chunkRealSize / (elapsed / 1000)

        console.log(
          `[Stream Chunked] Chunk ${i + 1}/${totalChunks} done (${(chunkSpeed / 1024 / 1024).toFixed(2)} MB/s)`
        )

        // Check if upload is complete
        if (resp.data?.complete) {
          console.log(`[Stream Chunked] Upload complete!`)
        }

        success = true
      } catch (e: any) {
        console.error(
          `[Stream Chunked] Chunk ${i + 1} attempt ${attempt} failed: ${e.message}`
        )
        if (attempt >= 3) {
          throw new Error(`Chunk ${i + 1} failed after 3 attempts: ${e.message}`)
        }
        // Wait 1s before retry
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
  }

  setUpload("progress", 100)
  setUpload("msg", "")
  console.log(`[Stream Chunked] All chunks uploaded successfully`)
}

// Direct stream upload for small files (original logic)
async function directStreamUpload(
  uploadPath: string,
  file: File,
  setUpload: SetUpload,
  asTask: boolean,
  overwrite: boolean,
  rapid: boolean,
): Promise<undefined> {
  let oldTimestamp = new Date().valueOf()
  let oldLoaded = 0
  let headers: { [k: string]: any } = {
    "File-Path": encodeURIComponent(uploadPath),
    "As-Task": asTask,
    "Content-Type": file.type || "application/octet-stream",
    "Last-Modified": file.lastModified,
    Password: password(),
    Overwrite: overwrite.toString(),
  }
  if (rapid) {
    const { md5, sha1, sha256 } = await calculateHash(file)
    headers["X-File-Md5"] = md5
    headers["X-File-Sha1"] = sha1
    headers["X-File-Sha256"] = sha256
  }
  const resp: EmptyResp = await r.put("/fs/put", file, {
    headers: headers,
    onUploadProgress: (progressEvent) => {
      if (progressEvent.total) {
        const complete =
          ((progressEvent.loaded / progressEvent.total) * 100) | 0
        setUpload("progress", complete)

        const timestamp = new Date().valueOf()
        const duration = (timestamp - oldTimestamp) / 1000
        if (duration > 1) {
          const loaded = progressEvent.loaded - oldLoaded
          const speed = loaded / duration
          const remain = progressEvent.total - progressEvent.loaded
          const remainTime = remain / speed
          setUpload("speed", speed)
          console.log(remainTime)

          oldTimestamp = timestamp
          oldLoaded = progressEvent.loaded
        }

        if (complete === 100) {
          setUpload("status", "backending")
        }
      }
    },
  })
  if (resp.code === 200) {
    return
  } else {
    throw new Error(resp.message)
  }
}

export const StreamUpload: Upload = async (
  uploadPath: string,
  file: File,
  setUpload: SetUpload,
  asTask = false,
  overwrite = false,
  rapid = false,
): Promise<undefined> => {
  const chunkSize = getChunkSize()

  // Use chunked upload for large files
  if (file.size > chunkSize) {
    console.log(
      `[Stream Upload] ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB) > ${(chunkSize / 1024 / 1024).toFixed(0)} MB threshold, using chunked stream upload`
    )
    return chunkedStreamUpload(uploadPath, file, setUpload, overwrite, chunkSize)
  }

  // Use direct upload for small files
  console.log(`[Stream Upload] ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB) using direct stream upload`)
  return directStreamUpload(uploadPath, file, setUpload, asTask, overwrite, rapid)
}
