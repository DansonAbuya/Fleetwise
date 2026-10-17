export function cleanInboxEmail(value?: string) {
  return String(value || '').trim().toLowerCase()
}

export function isInboxEmail(value?: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanInboxEmail(value))
}

export function mailboxSearchQuery(email: string) {
  const value = cleanInboxEmail(email).replace(/"/g, '')
  const quoted = `"${value}"`
  return `has:attachment newer_than:21d (to:${quoted} OR from:${quoted} OR deliveredto:${quoted} OR cc:${quoted})`
}
