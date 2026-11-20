import type { InferenceSource } from 'firebase/ai'
import { transcribeImage, type SpeedMode } from './susGenerator'

export interface ReadResult {
  text: string
  /** How the text was obtained, for the badge next to the file name. */
  how: 'pdf-text' | 'text-file' | InferenceSource
  pages?: number
  note?: string
}

export type ReadProgress = (message: string) => void

const MAX_PDF_PAGES = 30
const MAX_SCANNED_PAGES = 4
const MAX_IMAGE_SIDE = 1280

export const ACCEPTED_FILES = '.pdf,application/pdf,image/*,.txt,.md,text/plain'

export function describeFileKind(file: File): 'pdf' | 'image' | 'text' | null {
  const name = file.name.toLowerCase()
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf'
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('text/') || name.endsWith('.txt') || name.endsWith('.md')) return 'text'
  return null
}

/** Reads a PDF, photo or text file into plain study notes. */
export async function readStudyFile(file: File, mode: SpeedMode, progress: ReadProgress): Promise<ReadResult> {
  const kind = describeFileKind(file)
  if (kind === 'text') {
    return { text: (await file.text()).trim(), how: 'text-file' }
  }
  if (kind === 'image') {
    progress(mode === 'private' ? 'Reading your photo on this laptop…' : 'Reading your photo…')
    const jpeg = await imageToJpegBase64(file)
    const { text, source } = await transcribeImage(jpeg, mode)
    if (text.length < 20) throw new Error("Couldn't find any notes in that photo. Try a clearer, closer shot.")
    return { text, how: source }
  }
  if (kind === 'pdf') return readPdf(file, mode, progress)
  throw new Error('Sus can read PDFs, photos (JPG, PNG) and text files.')
}

// ---------- PDF ----------

async function loadPdfJs() {
  const pdfjs = await import('pdfjs-dist')
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  return pdfjs
}

async function readPdf(file: File, mode: SpeedMode, progress: ReadProgress): Promise<ReadResult> {
  progress('Opening PDF…')
  const pdfjs = await loadPdfJs()
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise
  const total = doc.numPages
  const pages = Math.min(total, MAX_PDF_PAGES)

  // 1) Text layer: instant, and never leaves the device.
  const chunks: string[] = []
  for (let n = 1; n <= pages; n++) {
    progress(`Reading page ${n} of ${pages}…`)
    const page = await doc.getPage(n)
    const content = await page.getTextContent()
    let line = ''
    const lines: string[] = []
    for (const item of content.items) {
      if (!('str' in item)) continue
      line += item.str
      if (item.hasEOL) {
        lines.push(line)
        line = ''
      } else if (item.str && !item.str.endsWith(' ')) {
        line += ' '
      }
    }
    if (line.trim()) lines.push(line)
    chunks.push(lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n'))
  }
  const text = chunks.filter(Boolean).join('\n\n').trim()
  const cut = total > pages ? `Used the first ${pages} of ${total} pages.` : undefined
  if (text.length >= 100) return { text, how: 'pdf-text', pages, note: cut }

  // 2) No text layer (a scan or photos saved as PDF): read the first pages as images.
  const scanned = Math.min(total, MAX_SCANNED_PAGES)
  const parts: string[] = []
  let source: InferenceSource = 'in_cloud'
  for (let n = 1; n <= scanned; n++) {
    progress(`Scanned PDF: reading page ${n} of ${scanned} with AI…`)
    const page = await doc.getPage(n)
    const viewport = page.getViewport({ scale: 1 })
    const scale = Math.min(2, MAX_IMAGE_SIDE / Math.max(viewport.width, viewport.height))
    const scaled = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(scaled.width)
    canvas.height = Math.round(scaled.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Your browser could not render this PDF.')
    await page.render({ canvasContext: ctx, viewport: scaled }).promise
    const result = await transcribeImage(canvasToBase64(canvas), mode)
    source = result.source
    if (result.text) parts.push(result.text)
  }
  const scannedText = parts.join('\n\n').trim()
  if (scannedText.length < 20) throw new Error("Couldn't find any text in this PDF.")
  return {
    text: scannedText,
    how: source,
    pages: scanned,
    note: total > scanned ? `Scanned PDF: read the first ${scanned} of ${total} pages.` : 'Scanned PDF.',
  }
}

// ---------- Images ----------

/** Decodes any browser-supported image, downsizes it and re-encodes as JPEG (what on-device AI accepts). */
async function imageToJpegBase64(file: File): Promise<string> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error("This image format can't be opened here. Try a JPG or PNG (iPhone: share as JPG).")
  }
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Your browser could not process this image.')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return canvasToBase64(canvas)
}

function canvasToBase64(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/jpeg', 0.85).split(',')[1]
}
