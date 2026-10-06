#!/usr/bin/env bun
/**
 * pdf2md — agentic PDF-to-Markdown converter on UFR vision models.
 *
 * TypeScript port of the author's former standalone Python script, integrated
 * with the opencode-ufr gateway: every model call goes through the gateway's
 * relay (POST /v1/_relay), so key rotation and soft rate limiting are handled
 * centrally — pages run at full parallelism and the caller never paces itself.
 *
 * Pipeline per page:
 *   1. Render at 300 DPI (pdftoppm)
 *   2. Deduplicate incremental-reveal pages (PowerPoint-style, magick compare)
 *   3. Classify: TEXT / TABLE_MATH / DIAGRAM / MIXED (qwen-3.8-27b)
 *   4. Route to the best model per type:
 *      - TEXT       → glm-5.3-flash (structure + LaTeX, 3-4x faster than the old OCR model)
 *      - TABLE_MATH → glm-5.3-flash + refinement
 *      - DIAGRAM    → 3-model ensemble (glm-5.3-flash, deepseek-v4.1-flash,
 *                     qwen-3.5-397b) full-page + quadrant zoom, adjudicated
 *      - MIXED      → OCR + diagram ensemble, merged
 *   5. Refinement loop (gemma-4-31b compares markdown against the page image)
 *   6. Cross-page table merge
 *
 * External tools: pdftoppm/pdfinfo (poppler-utils) and magick (ImageMagick).
 *
 * Usage:
 *   bun src/client/pdf2md.ts <input.pdf> [output.md] [--workers N] [--dpi 300]
 *       [--no-dedup] [--dedup-threshold 0.98] [--no-refine] [--no-merge] [--verbose]
 */
import { execFile as execFileCb } from "node:child_process"
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { connectGateway, type Gateway, relay } from "./gateway"

const execFile = promisify(execFileCb)

// ─── Configuration ───────────────────────────────────────────────────────────

const OCR_MODEL = process.env.PDF2MD_OCR_MODEL ?? "glm-5.3-flash-llmlb"
const CLASSIFY_MODEL = process.env.PDF2MD_CLASSIFY_MODEL ?? "qwen-3.8-27b-llmlb"
const REFINE_MODEL = process.env.PDF2MD_REFINE_MODEL ?? "gemma-4-31b-llmlb"

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
}
const DEFAULT_DPI = 300
const MAX_REFINE_ROUNDS = 3
const DEDUP_SIMILARITY_THRESHOLD = 0.90
const REQUEST_TIMEOUT_MS = 600_000 // diagrams can think for minutes
const DEFAULT_MAX_TOKENS = 8192 // generous budget so reasoning models don't run out before visible output

// ─── Logging ─────────────────────────────────────────────────────────────────

let VERBOSE = false
const log = (msg: string, force = false): void => {
  if (force || VERBOSE) console.error(`[pdf2md] ${msg}`)
}

const logProgress = (current: number, total: number, label = ""): void => {
  const pct = total ? Math.floor((current * 100) / total) : 0
  const tag = label ? ` ${label}` : ""
  process.stderr.write(`\r[pdf2md] ${current}/${total} (${pct}%)${tag}    `)
  if (current >= total) process.stderr.write("\n")
}

// ─── Model calls (all through the gateway's relay: key rotation + pacing) ────

type Msg = { role: string; content: unknown }

/** One raw model call, returning the upstream JSON body as text. Injectable for tests. */
export type RelayCall = (model: string, messages: Msg[], maxTokens: number) => Promise<{ status: number; body: string; retryAfterMs?: number }>

let gateway: Gateway | null = null

const gatewayCall: RelayCall = async (model, messages, maxTokens) => {
  gateway ??= await connectGateway()
  return relay(gateway, { model, messages, max_tokens: maxTokens, temperature: 0 }, { timeoutMs: REQUEST_TIMEOUT_MS })
}

type ChatOptions = {
  maxTokens?: number
  /** Classification only: when the model thinks past its budget and emits no
   *  visible content, its reasoning_content is parsed for the category instead.
   *  For content generation reasoning is deliberation, never the answer. */
  allowReasoningFallback?: boolean
}

/** Chat completion with the Python script's retry ladder, via the relay.
 *  The gateway already waits for key slots — a 429 here means a wall, a pool
 *  cap or an exhausted budget, all of which are worth a real backoff. */
export async function apiChat(call: RelayCall, model: string, messages: Msg[], o: ChatOptions = {}): Promise<string> {
  const base = { model, temperature: 0, messages }
  let effectiveMax = o.maxTokens ?? DEFAULT_MAX_TOKENS
  let lastError = ""
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) effectiveMax *= 2 ** attempt
    let res: Awaited<ReturnType<RelayCall>>
    try {
      res = await call(model, messages, effectiveMax)
    } catch (e) {
      lastError = `network error: ${(e as Error).message}`
      await Bun.sleep(2 ** attempt * 1000)
      continue
    }
    if (res.status === 429 || res.status === 503) {
      const waitS = Math.min(res.retryAfterMs ? Math.round(res.retryAfterMs / 1000) : 2 ** attempt * 5, 120)
      log(`rate-limited (${res.status}), waiting ${waitS}s before retry...`)
      await Bun.sleep(waitS * 1000)
      lastError = `HTTP ${res.status}`
      continue
    }
    if (res.status !== 200) {
      lastError = `HTTP ${res.status}: ${res.body.slice(0, 500)}`
      continue
    }
    let data: {
      choices?: { message?: { content?: unknown; reasoning_content?: unknown }; finish_reason?: string }[]
    }
    try {
      data = JSON.parse(res.body)
    } catch {
      lastError = "response was not JSON"
      continue
    }
    const choice = data.choices?.[0]
    if (!choice) {
      lastError = "no choices in response"
      continue
    }
    const content = choice.message?.content
    if (typeof content === "string" && content.trim()) return content
    const reasoning = choice.message?.reasoning_content
    if (typeof reasoning === "string" && reasoning.trim() && o.allowReasoningFallback) {
      log(`  model ${model}: content empty, using reasoning_content (${reasoning.length} chars)`)
      return reasoning.trim()
    }
    if (choice.finish_reason === "length") {
      log(`  model ${model}: truncated (finish=length), retrying with larger budget`)
      lastError = "truncated (finish=length)"
      continue
    }
    lastError = `empty content (finish=${choice.finish_reason})`
  }
  throw new Error(`API call failed after 3 attempts (model=${model}): ${lastError}`)
}

const imagePart = (b64: string, mime: string) => ({ type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } })

const apiChatImage = async (call: RelayCall, model: string, b64: string, mime: string, prompt: string, o: ChatOptions = {}) =>
  apiChat(call, model, [{ role: "user", content: [{ type: "text", text: prompt }, imagePart(b64, mime)] }], o)

const apiChatImages = (call: RelayCall, model: string, images: [string, string][], prompt: string, o: ChatOptions = {}) =>
  apiChat(call, model, [{ role: "user", content: [{ type: "text", text: prompt }, ...images.map(([b64, mime]) => imagePart(b64, mime))] }], o)

// ─── Image utilities (no image library, use ImageMagick) ─────────────────────

const cropImage = async (srcPng: string, outputPng: string, x: number, y: number, w: number, h: number): Promise<boolean> => {
  try {
    await execFile("magick", ["convert", srcPng, "-crop", `${w}x${h}+${x}+${y}`, "+repage", outputPng], { timeout: 30_000 })
    return true
  } catch (e) {
    log(`crop failed: ${(e as Error).message}`)
    return false
  }
}

const imageToB64 = async (path: string): Promise<[string, string]> => {
  const mime = MIME[path.slice(path.lastIndexOf(".")).toLowerCase()] ?? "image/png"
  const buf = await Bun.file(path).arrayBuffer()
  return [Buffer.from(buf).toString("base64"), mime]
}

const renderPdfPages = async (pdfPath: string, dpi: number, outDir: string): Promise<string[]> => {
  const prefix = join(outDir, "page")
  try {
    await execFile("pdftoppm", ["-png", "-r", String(dpi), pdfPath, prefix], { timeout: 600_000 })
  } catch (e) {
    throw new Error(`pdftoppm failed (${(e as Error).message}). Install poppler-utils.`)
  }
  const names = (await readdir(outDir)).filter((n) => n.startsWith("page") && n.endsWith(".png")).sort()
  if (names.length === 0) throw new Error("pdftoppm produced no output images")
  return names.map((n) => join(outDir, n))
}

const getPageCount = async (pdfPath: string): Promise<number> => {
  try {
    const { stdout } = await execFile("pdfinfo", [pdfPath], { timeout: 30_000 })
    for (const line of stdout.split("\n")) {
      if (line.startsWith("Pages:")) return Number.parseInt(line.split(":")[1]!.trim(), 10)
    }
  } catch {
    // fall through
  }
  return 0
}

const getImageDims = async (pngPath: string): Promise<[number, number]> => {
  try {
    const { stdout } = await execFile("magick", ["identify", "-format", "%w %h", pngPath], { timeout: 10_000 })
    const [w, h] = stdout.trim().split(/\s+/).map(Number)
    return [w ?? 0, h ?? 0]
  } catch {
    return [0, 0]
  }
}

// ─── Stage 1b: Incremental-reveal deduplication ──────────────────────────────

/** Normalized RMSE via ImageMagick: similarity = 1 - rmse/255, in [0, 1]. */
const imageSimilarity = async (imgA: string, imgB: string): Promise<number> => {
  try {
    // magick compare writes the metric to stderr and exits non-zero on difference
    const res = await execFile("magick", ["compare", "-metric", "RMSE", imgA, imgB, "null:"], { timeout: 30_000 }).catch(
      (e: { stderr?: string }) => ({ stderr: e.stderr ?? "" }),
    )
    const line = (res.stderr ?? "").trim()
    const normalized = /\(([\d.]+)\)/.exec(line)?.[1]
    if (normalized !== undefined) return Math.max(0, 1 - Number.parseFloat(normalized))
    const raw = Number.parseFloat(line.split(/\s+/)[0] ?? "65535")
    return Math.max(0, 1 - (Number.isFinite(raw) ? raw : 65535) / 65535)
  } catch {
    return 0
  }
}

/** PowerPoint-style incremental reveals: consecutive near-identical pages — keep the last of each run. */
export const dedupIncrementalReveals = async (pagePngs: string[], threshold = DEDUP_SIMILARITY_THRESHOLD): Promise<string[]> => {
  if (pagePngs.length <= 1) return pagePngs
  const kept: string[] = []
  let skipped = 0
  for (let i = 0; i < pagePngs.length; i++) {
    const current = pagePngs[i]!
    if (i === pagePngs.length - 1) {
      kept.push(current) // the last page of a run has all the content
      break
    }
    const sim = await imageSimilarity(current, pagePngs[i + 1]!)
    if (sim >= threshold) {
      log(`  page ${i + 1} → ${i + 2}: similarity ${sim.toFixed(4)} ≥ ${threshold}, dropping page ${i + 1}`)
      skipped++
    } else {
      kept.push(current)
    }
  }
  log(skipped > 0 ? `dedup: removed ${skipped} incremental-reveal duplicates, ${kept.length} pages remain` : "dedup: no incremental-reveal duplicates detected")
  return kept
}

// ─── Stage 2: Page classification ────────────────────────────────────────────

const CLASSIFY_PROMPT = `Analyze this document page image and classify it into exactly ONE of these categories:

- TEXT: Mostly text (paragraphs, headings, body text). May contain simple inline figures.
- TABLE_MATH: Contains significant tables, mathematical equations, or structured data.
- DIAGRAM: The page's meaning is carried by a drawing: technical drawings, circuit diagrams, schematics, flowcharts, block diagrams, node graphs, state machines, org charts, or complex figures with labels. Boxes connected by arrows count as DIAGRAM even when drawn simply.
- MIXED: Contains both significant text AND a technical diagram/figure.

Respond with ONLY the category name (TEXT, TABLE_MATH, DIAGRAM, or MIXED). No other text.`

export type PageType = "TEXT" | "TABLE_MATH" | "DIAGRAM" | "MIXED"

export const classifyPage = async (call: RelayCall, pagePng: string): Promise<PageType> => {
  const [b64, mime] = await imageToB64(pagePng)
  try {
    const result = (await apiChatImage(call, CLASSIFY_MODEL, b64, mime, CLASSIFY_PROMPT, { maxTokens: 50, allowReasoningFallback: true })).trim().toUpperCase()
    for (const valid of ["TEXT", "TABLE_MATH", "DIAGRAM", "MIXED"] as const) {
      if (result.includes(valid)) return valid
    }
    return "TEXT"
  } catch (e) {
    log(`classification failed for ${pagePng.split("/").pop()}: ${(e as Error).message}, defaulting to TEXT`)
    return "TEXT"
  }
}

// ─── Stage 3: Per-page-type transcription ────────────────────────────────────

const OCR_PROMPT = `Convert this document page to clean Markdown.
Rules:
- Preserve all headings, lists, tables (as GitHub markdown tables), and code blocks
- For math, use LaTeX: $inline$ and $$block$$
- For figures, output ![Figure N](placeholder_fig_N.png) with a caption if present
- For footnotes, use [^N] syntax
- Output ONLY the markdown, no commentary
- If a table spans the page width, reproduce every cell accurately
- Page {page_info}`

const DIAGRAM_PROMPT = `You are analyzing a page from a technical document that contains a circuit diagram, schematic, flowchart, or node-based graph.

Your task:
1. First, transcribe ALL text on the page (headings, paragraphs, captions, labels) as Markdown.
2. For every visible component (resistors, capacitors, ICs, connectors, ...), read: its reference designator (e.g. R1, C2, U3), its value (e.g. 10kΩ, 100nF), and any pin labels. Output a structured component table:

   | Ref | Type | Value | Notes |
   |-----|------|-------|-------|
   | R1  | Resistor | 10kΩ | |

3. Describe the wiring: every connection you can trace as "A connects to B" (use reference designators and net labels like VIN, GND).
4. If the page contains a flowchart or node-based graph, add a "## Graph" section:
   - every node: its label text exactly as written, and its type (process / decision / input / output / start / end)
   - every edge as "source -> target" with the edge label (e.g. yes/no) if present
   - the whole graph as a Mermaid flowchart (graph TD) with the exact labels
5. End with: ![Diagram](placeholder_diagram_{page_num}.png)
6. Output ONLY Markdown, no commentary.

Page {page_info}`

const QUADRANT_PROMPT = (label: string): string =>
  `Focus on this ${label} quadrant of a technical diagram. List every component label, value, and connection you can read. Output as a Markdown table with columns: Ref, Type, Value, Connection. Only output the table, nothing else.`

/** The ensemble: three independent vision models at two zoom levels disagree in
 *  complementary ways (measured 2026-10-06: glm-5.3-flash read resistor values
 *  right on the full page where deepseek/qwen misread, all three agreed on the
 *  quadrant crops that fixed the full-page misreads). The adjudicator sees the
 *  page plus every reading and resolves conflicts against the image. */
const DIAGRAM_ENSEMBLE = (process.env.PDF2MD_DIAGRAM_ENSEMBLE ?? "glm-5.3-flash-llmlb,deepseek-v4.1-flash-llmlb,qwen-3.5-397b-llmlb")
  .split(",").map((s) => s.trim()).filter(Boolean)
const ADJUDICATOR_MODEL = process.env.PDF2MD_ADJUDICATOR_MODEL ?? "glm-5.3-flash-llmlb"

const pageInfo = (page: number, total: number): string => (total > 1 ? `(Seite ${page} von ${total})` : "")

const transcribeTextPage = async (call: RelayCall, pagePng: string, page: number, total: number): Promise<string> => {
  const [b64, mime] = await imageToB64(pagePng)
  const info = pageInfo(page, total)
  const prompt = OCR_PROMPT.replace("{page_info}", info ? ` ${info}` : "")
  return apiChatImage(call, OCR_MODEL, b64, mime, prompt)
}

/** Diagram/graph page: the full-accuracy path.
 *
 *  Three independent vision models read the full page in parallel, then all
 *  three read each of the four native-resolution quadrant crops (12 more
 *  calls). Each scale/model combination misreads different labels — measured
 *  2026-10-06 on a schematic with R1 10kΩ/R2 4.7kΩ/C1 10µF: glm-5.3-flash read
 *  the resistors right on the full page where the others dropped the "k", the
 *  quadrant crops fixed R1/C1 for everyone but all three dropped the "k" there
 *  instead. The adjudicator then sees the page image plus every reading,
 *  re-examines each disagreement against the image, normalizes equivalent
 *  units (0.1uF = 100nF) and emits the final structure. */
export const transcribeDiagramPage = async (call: RelayCall, pagePng: string, page: number, total: number): Promise<string> => {
  const [b64, mime] = await imageToB64(pagePng)
  const prompt = DIAGRAM_PROMPT.replace("{page_info}", pageInfo(page, total)).replace("{page_num}", String(page))

  // 1. Full-page structured pass: all ensemble models in parallel.
  const fullReads = await Promise.allSettled(DIAGRAM_ENSEMBLE.map((m) => apiChatImage(call, m, b64, mime, prompt)))
  const fullOk: string[] = []
  for (const [i, r] of fullReads.entries()) {
    if (r.status === "fulfilled") fullOk.push(`### Full-page reading (${DIAGRAM_ENSEMBLE[i]})\n\n${r.value}`)
    else log(`full-page pass failed for ${DIAGRAM_ENSEMBLE[i]}: ${(r.reason as Error).message}`)
  }
  if (fullOk.length === 0) throw new Error("every diagram model failed on the full page")

  // 2. Quadrant zoom pass: each model × each native-resolution crop, in parallel.
  const [w, h] = await getImageDims(pagePng)
  const quadrantReads: string[] = []
  if (w > 0 && h > 0) {
    const halfW = Math.floor(w / 2)
    const halfH = Math.floor(h / 2)
    const crops: [string, number, number, number, number][] = [
      ["top-left", 0, 0, halfW, halfH],
      ["top-right", halfW, 0, halfW, halfH],
      ["bottom-left", 0, halfH, halfW, halfH],
      ["bottom-right", halfW, halfH, halfW, halfH],
    ]
    const tempDir = join(pagePng.slice(0, pagePng.lastIndexOf("/")), `quadrants_${pagePng.slice(pagePng.lastIndexOf("/") + 1, -4)}`)
    try {
      await mkdir(tempDir, { recursive: true })
      const jobs: Promise<void>[] = []
      for (const [label, x, y, cw, ch] of crops) {
        const cropPath = join(tempDir, `${label}.png`)
        if (!(await cropImage(pagePng, cropPath, x, y, cw, ch))) continue
        const [qb64, qmime] = await imageToB64(cropPath)
        for (const m of DIAGRAM_ENSEMBLE) {
          jobs.push(
            apiChatImage(call, m, qb64, qmime, QUADRANT_PROMPT(label))
              .then((res) => {
                quadrantReads.push(`### Quadrant ${label} (${m})\n\n${res}`)
              })
              .catch((e) => log(`quadrant pass failed for ${label} (${m}): ${(e as Error).message}`))
              .finally(() => rm(cropPath, { force: true }).catch(() => {})),
          )
        }
      }
      await Promise.allSettled(jobs)
    } finally {
      await rm(tempDir, { force: true, recursive: true }).catch(() => {})
    }
  }

  // 3. Adjudication: the strongest reader re-examines every disagreement
  //    against the page image and emits the final structure.
  const adjudication =
    "You are the adjudicator of a diagram transcription. Below are independent readings " +
    "of the same page: several models read the full page, and several models read each " +
    "quadrant crop at higher effective resolution. The readings DISAGREE in places — each " +
    "reader misread different labels. Re-examine the attached page image yourself and " +
    "resolve every conflict: prefer a value confirmed by multiple readings, but trust the " +
    "image over any reading when you can read the label clearly. Normalize equivalent " +
    "units (0.1uF = 100nF), drop readings of things that are not on the page, and keep " +
    "every correct detail from all readings.\n\n" +
    "Output the final merged Markdown with exactly these sections where applicable: the " +
    "page's text transcription, the component table (Ref/Type/Value/Notes), the wiring " +
    "connections, a '## Graph' section (node list, edge list as source -> target with " +
    "labels, Mermaid graph TD) when the page shows a flowchart or node graph, and the " +
    "placeholder image reference. No commentary about the merging.\n\n" +
    fullOk.join("\n\n") +
    (quadrantReads.length > 0 ? `\n\n## Quadrant readings\n\n${quadrantReads.join("\n\n")}` : "")
  try {
    return await apiChatImage(call, ADJUDICATOR_MODEL, b64, mime, adjudication)
  } catch (e) {
    log(`adjudication failed (${(e as Error).message}), merging text-only`)
    const mergePrompt =
      "Merge these independent readings of the same diagram page into a single accurate " +
      "Markdown document. Deduplicate components, resolve conflicting values in favour of " +
      "the majority and normalize equivalent units (0.1uF = 100nF). Keep every correct " +
      "detail. Output the final merged Markdown only.\n\n" +
      fullOk.join("\n\n") +
      (quadrantReads.length > 0 ? `\n\n## Quadrant readings\n\n${quadrantReads.join("\n\n")}` : "")
    return apiChat(call, REFINE_MODEL, [{ role: "user", content: mergePrompt }])
  }
}

/** Mixed page: OCR for the text, diagram analysis for the figures, merged. */
export const transcribeMixedPage = async (call: RelayCall, pagePng: string, page: number, total: number): Promise<string> => {
  const ocrResult = await transcribeTextPage(call, pagePng, page, total)
  const diagramResult = await transcribeDiagramPage(call, pagePng, page, total)
  const mergePrompt =
    "Below are two transcriptions of the same document page. The first was done " +
    "by an OCR model (good at text), the second by a vision model (good at diagrams). " +
    "Merge them into a single accurate Markdown document. Use the OCR version as the " +
    "base for text content. If the diagram version found component tables or technical " +
    "details missing from the OCR version, incorporate them. Deduplicate. " +
    "Output the final merged Markdown only.\n\n" +
    `## OCR Transcription\n\n${ocrResult}\n\n## Diagram Transcription\n\n${diagramResult}`
  return apiChat(call, REFINE_MODEL, [{ role: "user", content: mergePrompt }])
}

// ─── Stage 4: Refinement loop ────────────────────────────────────────────────

const REFINE_PROMPT = `You are a meticulous editor. Below is Markdown extracted from a document page, and the original page image.
Compare the Markdown against the image and fix any issues:
- Broken or incomplete tables (compare every cell against the image)
- Missing text or labels
- Garbled or misread characters (especially numbers and symbols)
- Inconsistent heading hierarchy
- Missing footnotes or annotations
- Lost or incorrect formatting (bold, italic, code blocks)
- Math equations that don't match the image

Output the corrected Markdown ONLY. No commentary, no explanations about what you changed.

Current Markdown:
{markdown}`

const refinePage = async (call: RelayCall, pagePng: string, markdown: string, round: number): Promise<string> => {
  const [b64, mime] = await imageToB64(pagePng)
  const result = await apiChatImage(call, REFINE_MODEL, b64, mime, REFINE_PROMPT.replace("{markdown}", markdown))
  // Sanity check: if refinement produced empty or much shorter output, keep original
  if (result.trim().length < markdown.trim().length * 0.3) {
    log(`  refine round ${round}: output suspiciously short (${result.length} vs ${markdown.length} chars), keeping previous`)
    return markdown
  }
  return result
}

export const refineLoop = async (call: RelayCall, pagePng: string, markdown: string, maxRounds = MAX_REFINE_ROUNDS): Promise<string> => {
  if (!markdown.trim()) return markdown
  let current = markdown
  for (let r = 1; r <= maxRounds; r++) {
    log(`  refine round ${r}/${maxRounds}...`)
    const refined = await refinePage(call, pagePng, current, r)
    if (refined.trim() === current.trim()) {
      log(`  refine round ${r}: no changes, stopping early`)
      break
    }
    if (refined.trim().length === current.trim().length) {
      log(`  refine round ${r}: same length, likely converged`)
      current = refined
      break
    }
    current = refined
  }
  return current
}

// ─── Full per-page pipeline ──────────────────────────────────────────────────

/** Remove an outermost ```markdown fence that wraps the ENTIRE output — inner
 *  code blocks are preserved. */
export const stripCodeFences = (text: string): string => {
  const stripped = text.trim()
  if (!stripped.startsWith("```")) return text
  const lines = stripped.split("\n")
  if (lines.length < 2) return text
  if (!["```markdown", "```md", "```"].includes(lines[0]!.trim())) return text
  if (lines[lines.length - 1]!.trim() !== "```") return text
  return lines.slice(1, -1).join("\n").trim()
}

export const processPage = async (call: RelayCall, pagePng: string, page: number, total: number, doRefine: boolean): Promise<[number, string]> => {
  const pageType = await classifyPage(call, pagePng)
  log(`page ${page}: classified as ${pageType}`)
  let markdown: string
  try {
    if (pageType === "TEXT" || pageType === "TABLE_MATH") {
      markdown = await transcribeTextPage(call, pagePng, page, total)
    } else if (pageType === "DIAGRAM") {
      try {
        markdown = await transcribeDiagramPage(call, pagePng, page, total)
      } catch (e) {
        log(`page ${page}: diagram model failed (${(e as Error).message}), falling back to OCR`)
        markdown = await transcribeTextPage(call, pagePng, page, total)
      }
    } else {
      try {
        markdown = await transcribeMixedPage(call, pagePng, page, total)
      } catch (e) {
        log(`page ${page}: mixed model failed (${(e as Error).message}), falling back to OCR`)
        markdown = await transcribeTextPage(call, pagePng, page, total)
      }
    }
  } catch (e) {
    log(`page ${page}: transcription failed (${(e as Error).message}), using placeholder`)
    return [page, `<!-- Page ${page}: transcription failed: ${(e as Error).message} -->\n`]
  }

  try {
    if (doRefine) {
      markdown = await refineLoop(call, pagePng, markdown, pageType === "TEXT" ? 1 : MAX_REFINE_ROUNDS)
    }
  } catch (e) {
    log(`page ${page}: refinement failed (${(e as Error).message}), using unrefined output`)
  }
  return [page, stripCodeFences(markdown)]
}

// ─── Concurrency auto-tuning ─────────────────────────────────────────────────

/** Probe throughput at increasing parallelism; the gateway's key pool absorbs
 *  the load, so this measures what the pipeline will actually see. Probes up
 *  to 16 workers — with several keys the pool admits far more than 8 in
 *  parallel, and long documents want every slot. */
export const probeConcurrency = async (call: RelayCall): Promise<number> => {
  log("auto-tuning concurrency...")
  const probeMsg: Msg[] = [{ role: "user", content: "Reply with exactly: OK" }]
  const best = { workers: 3, throughput: 0 }
  for (const n of [1, 3, 5, 8, 12, 16]) {
    try {
      const start = performance.now()
      const results = await Promise.allSettled(Array.from({ length: n }, () => apiChat(call, REFINE_MODEL, probeMsg, { maxTokens: 10 })))
      if (results.some((r) => r.status === "rejected")) throw new Error("a probe request failed")
      const elapsed = (performance.now() - start) / 1000
      const throughput = n / elapsed
      log(`  ${n} parallel requests: ${elapsed.toFixed(1)}s → ${throughput.toFixed(2)} req/s`)
      if (throughput > best.throughput) {
        best.throughput = throughput
        best.workers = n
      }
    } catch (e) {
      log(`  ${n} parallel requests: failed (${(e as Error).message}), backing off`)
      break
    }
  }
  const workers = Math.min(16, Math.max(2, best.workers))
  log(`optimal concurrency: ${workers} workers (${best.throughput.toFixed(2)} req/s)`)
  return workers
}

/** Fixed-size worker pool over an index cursor. */
async function runPool<T>(items: T[], workers: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      await fn(items[i]!, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, worker))
}

// ─── Cross-page table merging ────────────────────────────────────────────────

const TABLE_MERGE_PROMPT = `Below are consecutive pages of Markdown extracted from a PDF.
Some tables may span across page boundaries. Your job:
1. Merge any tables that were split across pages into single coherent tables.
2. Fix heading hierarchy (ensure H1→H2→H3 flow makes sense across pages).
3. Do NOT change the content of individual cells, only merge structure.
4. Do NOT delete anything: keep every heading, paragraph, list, footnote, figure placeholder, caption, code block and component table from every page. If two pages contain the same figure placeholder, keep one and keep its caption.
5. Output the complete merged Markdown.

Pages:
{pages}`

export const crossPageMerge = async (call: RelayCall, pageMarkdowns: string[]): Promise<string> => {
  const joinFinal = (parts: string[]) => parts.join("\n\n---\n\n")
  if (pageMarkdowns.length <= 1) return joinFinal(pageMarkdowns)
  const mergeChunk = async (chunk: string[]): Promise<string> => {
    const text = chunk.join("\n\n---PAGE BREAK---\n\n")
    try {
      return await apiChat(call, REFINE_MODEL, [{ role: "user", content: TABLE_MERGE_PROMPT.replace("{pages}", text) }])
    } catch {
      return joinFinal(chunk)
    }
  }
  const joined = pageMarkdowns.join("\n\n---PAGE BREAK---\n\n")
  // For large documents, merge in chunks to avoid context overflow
  const maxChunkChars = 100_000 // ~25K tokens, safe for 128K context models
  if (joined.length <= maxChunkChars) {
    const merged = await mergeChunk(pageMarkdowns)
    return merged.replaceAll("\n\n---PAGE BREAK---\n\n", "\n\n---\n\n").replaceAll("---PAGE BREAK---", "---")
  }
  log(`document is large (${joined.length} chars), merging in chunks...`)
  const chunks: string[] = []
  let current: string[] = []
  let size = 0
  for (const md of pageMarkdowns) {
    if (size + md.length > maxChunkChars && current.length > 0) {
      chunks.push(await mergeChunk(current))
      current = [md]
      size = md.length
    } else {
      current.push(md)
      size += md.length
    }
  }
  if (current.length > 0) chunks.push(await mergeChunk(current))
  return chunks.join("\n\n---\n\n").replaceAll("---PAGE BREAK---", "---")
}

// ─── Main pipeline ───────────────────────────────────────────────────────────

const argValue = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const VALUE_FLAGS = new Set(["--workers", "--dpi", "--dedup-threshold"])

/** Positional arguments = everything that is not a flag or a flag's value. */
const positionals = (args: string[]): string[] => {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a.startsWith("--")) {
      if (VALUE_FLAGS.has(a)) i++ // skip the flag's value
      continue
    }
    if (VALUE_FLAGS.has(args[i - 1] ?? "")) continue // a flag value that looks positional
    out.push(a)
  }
  return out
}

export async function main(argv: string[], call: RelayCall = gatewayCall): Promise<number> {
  const [input, output] = positionals(argv)
  if (!input) {
    console.error("usage: pdf2md.ts <input.pdf> [output.md] [--workers N] [--dpi 300] [--no-dedup] [--dedup-threshold 0.98] [--no-refine] [--no-merge] [--verbose]")
    return 2
  }
  VERBOSE = argv.includes("--verbose") || argv.includes("-v")
  const dpi = Number(argValue(argv, "--dpi") ?? DEFAULT_DPI)
  const dedupThreshold = Number(argValue(argv, "--dedup-threshold") ?? DEDUP_SIMILARITY_THRESHOLD)
  const noDedup = argv.includes("--no-dedup")
  const noRefine = argv.includes("--no-refine")
  const noMerge = argv.includes("--no-merge")

  if (!(await Bun.file(input).exists())) {
    console.error(`input not found: ${input}`)
    return 2
  }
  const pageCount = await getPageCount(input)
  if (pageCount === 0) {
    console.error("could not determine page count (pdfinfo not available or failed)")
    return 2
  }
  log(`PDF: ${input.split("/").pop()} (${pageCount} pages)`)

  const tempDir = await mkdtemp(join(tmpdir(), "pdf2md-"))
  try {
    log(`rendering ${pageCount} pages at ${dpi} DPI...`)
    let pagePngs = await renderPdfPages(input, dpi, tempDir)
    log(`rendered ${pagePngs.length} page images`)
    if (pagePngs.length !== pageCount) {
      log(`WARNING: pdfinfo said ${pageCount} pages but rendered ${pagePngs.length} images`)
    }

    if (!noDedup && pagePngs.length > 1) {
      log("deduplicating incremental-reveal pages...")
      pagePngs = await dedupIncrementalReveals(pagePngs, dedupThreshold)
      if (pagePngs.length === 0) {
        console.error("all pages were deduplicated — nothing to process")
        return 2
      }
    }
    const total = pagePngs.length

    let workers = Number(argValue(argv, "--workers") ?? 0)
    if (!Number.isFinite(workers) || workers <= 0) {
      workers = total <= 2 ? total : await probeConcurrency(call)
    }
    log(`processing ${total} pages with ${workers} workers...`)

    const results = new Map<number, string>()
    let completed = 0
    await runPool(pagePngs, workers, async (png, idx) => {
      try {
        const [page, markdown] = await processPage(call, png, idx + 1, total, !noRefine)
        results.set(idx, markdown)
      } catch (e) {
        log(`page ${idx + 1} FAILED: ${(e as Error).message}`, true)
        results.set(idx, `<!-- Page ${idx + 1} failed: ${(e as Error).message} -->\n`)
      }
      completed++
      logProgress(completed, total, `page ${idx + 1}`)
    })

    const ordered = Array.from({ length: total }, (_, i) => results.get(i) ?? `<!-- Page ${i + 1} missing -->\n`)

    let finalMd: string
    if (!noMerge && total > 1 && total <= 200) {
      log("cross-page table merging...")
      finalMd = await crossPageMerge(call, ordered)
    } else {
      if (total > 200) log(`skipping cross-page merge (document too large: ${total} pages)`)
      finalMd = ordered.join("\n\n---\n\n")
    }

    if (output) {
      await Bun.write(output, finalMd)
      log(`output written to ${output} (${finalMd.length} chars)`, true)
    } else {
      process.stdout.write(finalMd)
    }
  } finally {
    await rm(tempDir, { force: true, recursive: true }).catch(() => {})
  }
  return 0
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)))
}
