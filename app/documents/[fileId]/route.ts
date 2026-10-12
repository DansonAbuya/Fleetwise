import { downloadNamedFile } from '@/lib/drive'
import { requireSession } from '@/lib/session'

export const runtime = 'nodejs'
export const maxDuration = 300

export async function GET(request: Request, context: { params: Promise<{ fileId: string }> }) {
  try {
    await requireSession()
  } catch {
    return new Response('Sign in to download documents.', { status: 401 })
  }
  const { fileId } = await context.params
  if (!/^[a-zA-Z0-9_-]+$/.test(fileId)) {
    return new Response('Invalid file.', { status: 400 })
  }
  const preview = new URL(request.url).searchParams.get('preview') === '1'
  try {
    const file = await downloadNamedFile(fileId)
    const ascii = file.filename.replace(/[^\x20-\x7E]/g, '_')
    return new Response(file.bytes, {
      headers: {
        'Content-Type': file.mime,
        'Content-Disposition': preview
          ? `inline; filename="${ascii}"`
          : `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        'Cache-Control': preview ? 'private, max-age=60' : 'private, no-store',
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to download that file.'
    return new Response(message, { status: 404 })
  }
}
