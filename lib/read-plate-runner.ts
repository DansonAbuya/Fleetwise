import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function isServerlessHost() {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME)
}

export function readPlateScriptPath() {
  const candidates = [
    join(process.cwd(), 'scripts', 'read-plate.mjs'),
    join(process.cwd(), 'scripts/read-plate.mjs'),
  ]
  for (const file of candidates) {
    if (existsSync(file)) return file
  }
  throw new Error("Couldn't start document OCR. scripts/read-plate.mjs is missing from the server bundle. Keep that file and scripts/tessdata/eng.traineddata.gz in the repo, then redeploy.")
}

export async function extractPlateText(bytes: Buffer, kind: string) {
  const href = pathToFileURL(readPlateScriptPath()).href
  const importer = new Function('u', 'return import(u)') as (url: string) => Promise<{
    extractPlateText: (data: Buffer, readKind: string) => Promise<string>
  }>
  const mod = await importer(href)
  return mod.extractPlateText(bytes, kind)
}
