'use client'

/**
 * IndexedDB draft persistence (brief §2.5): in-progress composer text survives
 * refreshes and conversation switches. One tiny key-value store, no deps.
 */
const DB_NAME = 'loop-gpt'
const STORE = 'drafts'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no idb'))
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T | null> {
  try {
    const db = await open()
    return await new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const req = fn(tx.objectStore(STORE))
      req.onsuccess = () => resolve(req.result as T)
      req.onerror = () => reject(req.error)
      tx.oncomplete = () => db.close()
    })
  } catch {
    return null // drafts are best-effort; never break the composer
  }
}

export const getDraft = (key: string) => withStore<string>('readonly', (s) => s.get(key))
export const setDraft = (key: string, value: string) => withStore<IDBValidKey>('readwrite', (s) => s.put(value, key))
export const deleteDraft = (key: string) => withStore<undefined>('readwrite', (s) => s.delete(key))
