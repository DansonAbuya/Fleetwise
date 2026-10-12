import { getGoogleAccessToken, googleFetch, googleNetworkMessage, type GoogleFetchInit } from '@/lib/google'
import { APP_FILE_NAMES } from '@/lib/plates'
import type { DriveItem } from '@/lib/types'

const DRIVE = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'

async function token() {
  const { token } = await getGoogleAccessToken()
  return token
}

async function driveFetch(url: string, init: GoogleFetchInit = {}) {
  const access = await token()
  const res = await googleFetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${access}`,
      ...(init.headers || {}),
    },
  })
  if (!res.ok) {
    const text = await res.text()
    if (res.status === 401 || res.status === 403) {
      throw new Error('Google Drive access expired or was not granted. Sign out and in again.')
    }
    throw new Error(text || `Drive request failed (${res.status})`)
  }
  return res
}

function withDriveParams(params: Record<string, string>) {
  const search = new URLSearchParams({
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
    ...params,
  })
  return search
}

export async function driveGet<T>(path: string, params: Record<string, string> = {}) {
  const res = await driveFetch(`${DRIVE}${path}?${withDriveParams(params)}`)
  return res.json() as Promise<T>
}

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const MAX_NESTED_FOLDERS = 80

export async function listFolderFiles(folderId: string): Promise<DriveItem[]> {
  const files: DriveItem[] = []
  const queue = [folderId]
  const seen = new Set<string>()
  while (queue.length && seen.size < MAX_NESTED_FOLDERS) {
    const current = queue.shift()
    if (!current || seen.has(current)) continue
    seen.add(current)
    const children = await listDirectChildren(current)
    for (const child of children) {
      if (child.mimeType === FOLDER_MIME) {
        if (!seen.has(child.id) && seen.size + queue.length < MAX_NESTED_FOLDERS) queue.push(child.id)
        continue
      }
      if (!APP_FILE_NAMES.has(child.name)) files.push(child)
    }
  }
  return files
}

async function listDirectChildren(folderId: string): Promise<DriveItem[]> {
  const files: DriveItem[] = []
  let pageToken = ''
  do {
    const data = await driveGet<{ files?: DriveItem[]; nextPageToken?: string }>('/files', {
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id,name,mimeType,modifiedTime,webViewLink,iconLink,parents,shortcutDetails(targetId,targetMimeType))',
      pageSize: '1000',
      corpora: 'allDrives',
      ...(pageToken ? { pageToken } : {}),
    })
    files.push(...(data.files || []))
    pageToken = data.nextPageToken || ''
  } while (pageToken)
  return files
}

export async function listChildFolders(parentId: string): Promise<DriveItem[]> {
  const children = await listDirectChildren(parentId)
  return children.filter((child) => child.mimeType === FOLDER_MIME)
}

export async function createFolder(parentId: string, name: string): Promise<DriveItem> {
  const res = await driveFetch(`${DRIVE}/files?${withDriveParams({ fields: 'id,name,webViewLink,mimeType,parents' })}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  })
  return res.json() as Promise<DriveItem>
}

export function folderViewLink(id: string, webViewLink?: string) {
  return webViewLink || `https://drive.google.com/drive/folders/${id}`
}

function byFolderName(items: DriveItem[]) {
  return uniqueById(items).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

function asPickerFolder(item: DriveItem): DriveItem | null {
  if (item.mimeType === FOLDER_MIME) return item
  const target = item.shortcutDetails
  if (item.mimeType === 'application/vnd.google-apps.shortcut' && target?.targetId && (!target.targetMimeType || target.targetMimeType === FOLDER_MIME)) {
    return { id: target.targetId, name: item.name, mimeType: FOLDER_MIME, webViewLink: item.webViewLink, parents: item.parents }
  }
  return null
}

async function listChildPickerFolders(parentId: string): Promise<DriveItem[]> {
  const fromAllDrives = await listDirectChildren(parentId)
  let folders = fromAllDrives.map(asPickerFolder).filter((item): item is DriveItem => Boolean(item))
  if (!folders.length) {
    const fromUser = await listFiles({
      q: `'${parentId}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
      corpora: 'user',
    })
    folders = fromUser.map(asPickerFolder).filter((item): item is DriveItem => Boolean(item))
  }
  if (folders.length) return byFolderName(folders)
  try {
    return byFolderName(await listFiles({
      q: `mimeType = '${FOLDER_MIME}' and trashed = false`,
      corpora: 'drive',
      driveId: parentId,
    }))
  } catch {
    return []
  }
}

export async function listFolders(parentId?: string): Promise<DriveItem[]> {
  if (!parentId) {
    const [mine, sharedWithMe] = await Promise.allSettled([
      listFiles({
        q: `mimeType = '${FOLDER_MIME}' and trashed = false and 'root' in parents`,
        corpora: 'user',
      }),
      listFiles({
        q: `mimeType = '${FOLDER_MIME}' and trashed = false and sharedWithMe = true`,
        corpora: 'user',
      }),
    ])
    const folders = [
      ...(sharedWithMe.status === 'fulfilled' ? sharedWithMe.value.map((folder) => ({ ...folder, name: folder.name.includes('(Shared') ? folder.name : `${folder.name} (Shared with me)` })) : []),
      ...(mine.status === 'fulfilled' ? mine.value : []),
    ]
    if (!folders.length && (mine.status === 'rejected' || sharedWithMe.status === 'rejected')) {
      throw (mine.status === 'rejected' ? mine.reason : sharedWithMe.reason)
    }
    return byFolderName(folders)
  }
  return listChildPickerFolders(parentId)
}

export async function searchFolders(query: string): Promise<DriveItem[]> {
  const needle = query.trim().replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  if (!needle) return listFolders()
  const q = `mimeType = '${FOLDER_MIME}' and trashed = false and name contains '${needle}'`
  const [mine, all] = await Promise.all([
    listFiles({ q, corpora: 'user', pageSize: '80' }),
    listFiles({ q, corpora: 'allDrives', pageSize: '80' }).catch(() => [] as DriveItem[]),
  ])
  return byFolderName([...all, ...mine])
}

export async function listSpreadsheets(): Promise<DriveItem[]> {
  const [mine, shared, inSharedDrives] = await Promise.all([
    listFiles({
      q: "mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
      corpora: 'user',
      orderBy: 'modifiedTime desc',
      pageSize: '100',
    }),
    listFiles({
      q: "mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false and sharedWithMe = true",
      corpora: 'user',
      orderBy: 'modifiedTime desc',
      pageSize: '100',
    }),
    listFiles({
      q: "mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
      corpora: 'allDrives',
      orderBy: 'modifiedTime desc',
      pageSize: '100',
    }),
  ])
  return uniqueById([
    ...shared.map((file) => ({ ...file, name: file.name.includes('(Shared') ? file.name : `${file.name} (Shared with me)` })),
    ...inSharedDrives,
    ...mine,
  ])
}

async function listFiles(input: { q: string; corpora: string; orderBy?: string; pageSize?: string; driveId?: string }) {
  const files: DriveItem[] = []
  let pageToken = ''
  do {
    const data = await driveGet<{ files?: DriveItem[]; nextPageToken?: string }>('/files', {
      q: input.q,
      fields: 'nextPageToken, files(id,name,mimeType,modifiedTime,webViewLink)',
      pageSize: input.pageSize || '200',
      corpora: input.corpora,
      ...(input.orderBy ? { orderBy: input.orderBy } : {}),
      ...(input.driveId ? { driveId: input.driveId } : {}),
      ...(pageToken ? { pageToken } : {}),
    })
    files.push(...(data.files || []))
    pageToken = data.nextPageToken || ''
  } while (pageToken && files.length < 400)
  return files
}

function uniqueById(items: DriveItem[]) {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

export async function findFleetAssetsWorkbook(): Promise<DriveItem | null> {
  for (const name of ['Fleet Assets - KE', 'Fleet Assets']) {
    const data = await driveGet<{ files?: DriveItem[] }>('/files', {
      q: `mimeType = 'application/vnd.google-apps.spreadsheet' and name = '${name.replace(/'/g, "\\'")}' and trashed = false`,
      fields: 'files(id,name,modifiedTime,webViewLink)',
      pageSize: '5',
      corpora: 'allDrives',
    })
    if (data.files?.[0]) return data.files[0]
  }
  return null
}

export async function listSharedDrives(): Promise<DriveItem[]> {
  const access = await token()
  const res = await fetch(`${DRIVE}/drives?pageSize=100&fields=drives(id,name)`, {
    headers: { Authorization: `Bearer ${access}` },
  })
  if (!res.ok) return []
  const data = await res.json() as { drives?: { id: string; name: string }[] }
  return (data.drives || []).map((drive) => ({ id: drive.id, name: drive.name, mimeType: 'application/vnd.google-apps.folder' }))
}

export async function getFile(id: string) {
  return driveGet<DriveItem>(`/files/${id}`, { fields: 'id,name,mimeType,modifiedTime,webViewLink,parents' })
}

export async function findFileByName(name: string): Promise<DriveItem | null> {
  return (await findOwnedFileByName(name)) || newestFile(await listNamedFiles(name, false))
}

export async function findOwnedFileByName(name: string): Promise<DriveItem | null> {
  return newestFile(await listNamedFiles(name, true))
}

async function listNamedFiles(name: string, ownedOnly: boolean) {
  const escaped = name.replace(/'/g, "\\'")
  const q = ownedOnly
    ? `name = '${escaped}' and trashed = false and 'me' in owners`
    : `name = '${escaped}' and trashed = false`
  const fields = 'files(id,name,modifiedTime,parents)'
  const [mine, shared] = await Promise.all([
    driveGet<{ files?: DriveItem[] }>('/files', { q, fields, pageSize: '10', corpora: 'user' }).catch(() => ({ files: [] })),
    ownedOnly
      ? Promise.resolve({ files: [] as DriveItem[] })
      : driveGet<{ files?: DriveItem[] }>('/files', { q, fields, pageSize: '10', corpora: 'allDrives' }).catch(() => ({ files: [] })),
  ])
  return uniqueById([...(mine.files || []), ...(shared.files || [])])
}

function newestFile(files: DriveItem[]) {
  return [...files].sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || ''))[0] || null
}

export async function readJsonFile<T>(fileId: string): Promise<T | null> {
  const res = await driveFetch(`${DRIVE}/files/${fileId}?${withDriveParams({ alt: 'media' })}`)
  const text = await res.text()
  if (!text) return null
  return JSON.parse(text) as T
}

export async function upsertJsonFile(folderId: string, name: string, data: unknown, existingId?: string) {
  const body = JSON.stringify(data, null, 2)
  if (existingId) {
    const res = await driveFetch(`${UPLOAD}/files/${existingId}?${withDriveParams({ uploadType: 'media', fields: 'id,name,modifiedTime,parents' })}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    return res.json() as Promise<DriveItem>
  }
  const metadata = { name, mimeType: 'application/json', parents: [folderId] }
  const boundary = `fleetwise_${Date.now()}`
  const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`
  const res = await driveFetch(`${UPLOAD}/files?${withDriveParams({ uploadType: 'multipart', fields: 'id,name,modifiedTime,parents' })}`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: multipart,
  })
  return res.json() as Promise<DriveItem>
}

export async function appendTextFile(folderId: string, name: string, line: string, existingId?: string) {
  let previous = ''
  if (existingId) {
    const res = await driveFetch(`${DRIVE}/files/${existingId}?${withDriveParams({ alt: 'media' })}`)
    previous = await res.text()
  }
  const next = `${previous}${previous && !previous.endsWith('\n') ? '\n' : ''}${line}\n`
  const metadata = { name, mimeType: 'text/plain', ...(existingId ? {} : { parents: [folderId] }) }
  const boundary = `fleetwise_${Date.now()}`
  const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: text/plain\r\n\r\n${next}\r\n--${boundary}--`
  const url = existingId
    ? `${UPLOAD}/files/${existingId}?${withDriveParams({ uploadType: 'multipart' })}`
    : `${UPLOAD}/files?${withDriveParams({ uploadType: 'multipart' })}`
  const res = await driveFetch(url, {
    method: existingId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: multipart,
  })
  return res.json() as Promise<DriveItem>
}

export async function uploadBinary(folderId: string, name: string, bytes: Buffer, mimeType: string) {
  const metadata = { name, parents: [folderId] }
  const boundary = `fleetwise_${Date.now()}`
  const metaPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`
  const fileHeader = `--${boundary}\r\nContent-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`
  const end = `\r\n--${boundary}--`
  const body = Buffer.concat([Buffer.from(metaPart, 'utf8'), Buffer.from(fileHeader, 'utf8'), bytes, Buffer.from(end, 'utf8')])
  const res = await driveFetch(`${UPLOAD}/files?${withDriveParams({ uploadType: 'multipart', fields: 'id,name,webViewLink,modifiedTime,parents' })}`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  })
  return res.json() as Promise<DriveItem>
}

export async function moveAndRename(fileId: string, { name, addParent, removeParent }: { name?: string; addParent?: string; removeParent?: string }) {
  const params = withDriveParams({
    fields: 'id,name,webViewLink,modifiedTime,parents',
    ...(addParent ? { addParents: addParent } : {}),
    ...(removeParent ? { removeParents: removeParent } : {}),
  })
  const res = await driveFetch(`${DRIVE}/files/${fileId}?${params}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(name ? { name } : {}),
  })
  return res.json() as Promise<DriveItem>
}

export async function readTextFile(fileId: string) {
  const res = await driveFetch(`${DRIVE}/files/${fileId}?${withDriveParams({ alt: 'media' })}`)
  return res.text()
}

export async function downloadBinary(fileId: string, attempt = 0): Promise<Buffer> {
  try {
    const res = await driveFetch(`${DRIVE}/files/${fileId}?${withDriveParams({ alt: 'media' })}`, { timeoutMs: 180_000 })
    return Buffer.from(await readResponseBytes(res, 180_000))
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    if (attempt < 1 && /timeout|timed out|aborted|dropped|slow|longer than/i.test(detail)) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      return downloadBinary(fileId, attempt + 1)
    }
    if (err instanceof Error && /Google Drive|connection to Google|Could not reach Google/i.test(err.message)) throw err
    throw new Error(googleNetworkMessage(detail, 180_000))
  }
}

async function readResponseBytes(res: Response, timeoutMs: number) {
  try {
    return await res.arrayBuffer()
  } catch (err) {
    throw new Error(googleNetworkMessage(err instanceof Error ? err.message : String(err), timeoutMs))
  }
}

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
}

export async function downloadNamedFile(fileId: string) {
  const meta = await getFile(fileId)
  if (meta.mimeType === FOLDER_MIME) throw new Error('That item is a folder, not a file.')
  const googleDoc = (meta.mimeType || '').startsWith('application/vnd.google-apps.')
  const exportMime = 'application/pdf'
  const res = googleDoc
    ? await driveFetch(`${DRIVE}/files/${fileId}/export?${withDriveParams({ mimeType: exportMime })}`, { timeoutMs: 180_000 })
    : await driveFetch(`${DRIVE}/files/${fileId}?${withDriveParams({ alt: 'media' })}`, { timeoutMs: 180_000 })
  const bytes = Buffer.from(await readResponseBytes(res, 180_000))
  const mime = googleDoc ? exportMime : (meta.mimeType || res.headers.get('content-type') || 'application/octet-stream')
  return { bytes, mime, filename: fileDownloadName(meta.name || 'document', mime) }
}

export function fileDownloadName(name: string, mime: string) {
  const base = name.replace(/[/\\?%*:|"<>]/g, '-').trim() || 'document'
  if (/\.[a-z0-9]{2,5}$/i.test(base)) return base
  const ext = MIME_EXT[mime.split(';')[0].trim()]
  return ext ? `${base}.${ext}` : base
}
