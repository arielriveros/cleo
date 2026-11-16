// The Saves panel's pure half: how a slot reads in the list, and what an imported .cleosave becomes.
// No React, no storage, so the tests can take it whole.

import { validateSaveDocument, isValidSlot, type SaveDocument } from 'cleo'

/** Play time as the list shows it: `m:ss`, or `h:mm:ss` from an hour. */
export function formatPlayTime(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** A stored size, in the largest unit that keeps it readable. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** When a save was written: the time today, else the date and time. */
export function formatSavedAt(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const sameDay = d.toDateString() === now.toDateString()
  return sameDay ? time : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`
}

/** The file an exported save is offered as: `<project>-<slot>.cleosave`. */
export function exportFileName(slot: string, projectName: string): string {
  const base = projectName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return `${base ? `${base}-` : ''}${slot}.cleosave`
}

/**
 * Read an imported file as a save document. Throws a message fit for the user: not JSON, not a Cleo save, or
 * one from a newer engine.
 */
export function parseImportedSave(text: string): SaveDocument {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Error('The file is not a Cleo save (it is not JSON).') }
  return validateSaveDocument(raw)
}

/**
 * The slot an import lands in: its own, unless one of `taken` already has it, then `<slot>-2`, `-3`, ...
 * Never overwrites a save.
 */
export function importSlot(wanted: string, taken: readonly string[]): string {
  const base = isValidSlot(wanted) ? wanted : 'imported'
  const used = new Set(taken)
  if (!used.has(base)) return base
  for (let i = 2; i < 1000; i++) {
    const suffix = `-${i}`
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`
    if (!used.has(candidate) && isValidSlot(candidate)) return candidate
  }
  return `imported-${Date.now().toString(36)}`
}

/** The document as the panel shows it: pretty JSON, cut short past `limit` characters. */
export function previewJson(doc: unknown, limit: number = 200_000): { text: string; truncated: boolean } {
  const text = JSON.stringify(doc, null, 2) ?? ''
  return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false }
}
