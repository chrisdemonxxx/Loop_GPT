import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { WorkspaceError } from './workspaces'

function vaultKey(): Buffer {
  const encoded = process.env.CONNECTION_ENCRYPTION_KEY || ''
  const key = Buffer.from(encoded, 'base64')
  if (key.length !== 32 || key.toString('base64') !== encoded) throw new WorkspaceError(503, 'Connection encryption is not configured')
  return key
}

export function encryptConnectionConfig(workspaceId: string, connectionId: string, config: Record<string, string>): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', vaultKey(), iv)
  cipher.setAAD(Buffer.from(`connection:v1:${workspaceId}:${connectionId}`))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(config), 'utf8'), cipher.final()])
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') })
}

export function decryptConnectionConfig(workspaceId: string, connectionId: string, envelope: string): Record<string, string> {
  const key = vaultKey()
  try {
    const record = JSON.parse(envelope)
    if (record.v !== 1) throw new Error('Unsupported envelope')
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'))
    decipher.setAAD(Buffer.from(`connection:v1:${workspaceId}:${connectionId}`))
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'))
    const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]).toString('utf8'))
    if (!value || Array.isArray(value) || typeof value !== 'object' || Object.values(value).some((item) => typeof item !== 'string')) throw new Error('Invalid configuration')
    return value
  } catch {
    throw new WorkspaceError(503, 'Connection credentials could not be decrypted')
  }
}
