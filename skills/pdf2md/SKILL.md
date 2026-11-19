---
name: PDF to Markdown
description: Convert a PDF to clean Markdown using UFR vision models — full OCR with tables, math (LaTeX), circuit diagrams (component tables via quadrant zoom), a refinement loop and cross-page table merging. Use whenever the user asks to convert a PDF or scanned document to Markdown, especially with tables, formulas or technical drawings where plain text extraction fails.
---

Convert a PDF to Markdown with the UFR vision pipeline:

```
bun {{PDF2MD_SCRIPT}} <input.pdf> [output.md] [options]
```

Options: `--workers N` (0 = auto-tune, default), `--dpi 300`, `--no-dedup`, `--dedup-threshold 0.98`, `--no-refine`, `--no-merge`, `--verbose` / `-v`.

## Workflow

1. Check the prerequisites are on PATH: `pdftoppm`/`pdfinfo` (poppler-utils) and `magick` (ImageMagick). If missing, tell the user to install them (`poppler-utils` and `imagemagick` packages) instead of trying another conversion path.
2. Run the command. Prefer giving an explicit `output.md` next to the input (stdout is the fallback); report the output path and page count.
3. For large documents (> 20 pages), start with `--no-refine --no-merge` for a fast first pass, then refine only the pages the user cares about.

## What the pipeline does

- Renders each page at 300 DPI and drops PowerPoint-style incremental-reveal duplicates.
- Classifies each page (TEXT / TABLE_MATH / DIAGRAM / MIXED) and routes it to the best model: glm-5.3-flash for text and tables (structure + LaTeX), and for diagrams an ensemble of three vision models (glm-5.3-flash, deepseek-v4.1-flash, qwen-3.5-397b) that each read the full page and every quadrant crop, followed by an adjudication pass that resolves disagreements against the image. Flowcharts and node graphs additionally get a node/edge list and a Mermaid rendering.
- Runs a refinement loop that compares the markdown against the page image (3 rounds for tables/diagrams, 1 for text).
- Merges tables that span page breaks at the end.

## Notes

- Every model call goes through the local opencode-ufr gateway, which rotates keys and paces requests automatically — **never add artificial sleeps between runs**; parallelism is handled and safe.
- The first run with > 2 pages auto-tunes concurrency with a few lightweight probe requests.
- Progress and page logs go to stderr; only the final markdown goes to stdout/the output file.
- The script needs the gateway running (it starts one automatically if the plugin is installed); model availability depends on the Uni Freiburg connection like every other UFR model.
