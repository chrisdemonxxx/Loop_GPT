/**
 * Per-use face-lock consent. The user confirms that the person in an attached
 * photo is them, or that they have that person's consent. The flag lives in a
 * tiny shared store so the composer checkbox and the send hook agree without
 * prop-drilling, and it is deliberately NOT persisted: it resets after every
 * send so each use is a fresh attestation.
 */
import { useSyncExternalStore } from 'react'

let consent = false
const listeners = new Set<() => void>()

function emit() { listeners.forEach((l) => l()) }

export function getFaceLockConsent(): boolean { return consent }

export function setFaceLockConsent(value: boolean): void {
  if (consent === value) return
  consent = value
  emit()
}

/** Read the flag for a send and clear it, so consent never carries over. */
export function consumeFaceLockConsent(): boolean {
  const value = consent
  setFaceLockConsent(false)
  return value
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useFaceLockConsent(): [boolean, (value: boolean) => void] {
  const value = useSyncExternalStore(subscribe, getFaceLockConsent, () => false)
  return [value, setFaceLockConsent]
}
