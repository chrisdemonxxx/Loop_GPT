import { useCallback, useEffect, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { projects, workspaces, type Project } from '../lib/api'
import { theme } from '../theme'

/**
 * Projects (web-IA parity, §8): workspace resolution, the project list with
 * chats/knowledge counts, selection, creation, and deletion. Knowledge file
 * upload and instructions editing live on the web app.
 */
export default function Projects({ onClose }: { onClose: () => void }) {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [rows, setRows] = useState<Project[]>([])
  const [name, setName] = useState('')
  const [instructions, setInstructions] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    if (!workspaceId) return
    projects.list(workspaceId).then(setRows).catch(() => {})
  }, [workspaceId])

  useEffect(() => {
    workspaces.personal().then((d: any) => setWorkspaceId(d.workspace?.id || d.id)).catch(() => setError('Could not load your workspace.'))
  }, [])
  useEffect(() => { load() }, [load])

  const create = async () => {
    if (!workspaceId || !name.trim()) return
    setBusy(true); setError('')
    try {
      await projects.create(workspaceId, name.trim(), instructions.trim())
      setName(''); setInstructions(''); load()
    } catch { setError('Could not create the project.') } finally { setBusy(false) }
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={onClose}><Text style={styles.back}>‹ Chats</Text></Pressable>
        <Text style={styles.title}>Projects</Text>
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.form}>
          <Text style={styles.label}>New project</Text>
          <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="Project name" placeholderTextColor={theme.textMuted} />
          <TextInput
            style={[styles.input, styles.tall]}
            value={instructions}
            onChangeText={setInstructions}
            placeholder="Custom instructions for the agent in this project (optional)"
            placeholderTextColor={theme.textMuted}
            multiline
          />
          <Pressable style={[styles.createBtn, busy && { opacity: 0.5 }]} onPress={create} disabled={busy || !name.trim()}>
            <Text style={styles.createBtnText}>{busy ? 'Creating…' : 'Create project'}</Text>
          </Pressable>
        </View>

        <Text style={styles.sectionTitle}>Your projects ({rows.length})</Text>
        {rows.length === 0 && <Text style={styles.muted}>No projects yet. Projects scope chats to instructions and a searchable knowledge base.</Text>}
        {rows.map((p) => (
          <View key={p.id} style={styles.card}>
            <View style={styles.cardBody}>
              <Text style={styles.cardTitle}>{p.name}</Text>
              {p.instructions ? <Text style={styles.muted} numberOfLines={2}>{p.instructions}</Text> : null}
              <Text style={styles.meta}>
                {p._count?.conversations ?? 0} chats · {p._count?.knowledgeChunks ?? 0} knowledge chunks
              </Text>
            </View>
            <Pressable onPress={() => { if (workspaceId) projects.remove(workspaceId, p.id).then(load).catch(() => {}) }}>
              <Text style={styles.delete}>Delete</Text>
            </Pressable>
          </View>
        ))}
        <Text style={styles.muted}>Open a project from the web app to scope chats and upload knowledge files.</Text>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderBottomWidth: 1, borderBottomColor: theme.border },
  back: { color: '#e79d7f', fontSize: 15 },
  title: { color: theme.text, fontSize: 17, fontWeight: '700' },
  body: { padding: 16, gap: 12, paddingBottom: 40 },
  form: { backgroundColor: theme.panel, borderWidth: 1, borderColor: theme.border, borderRadius: 16, padding: 14, gap: 10 },
  label: { color: theme.text, fontSize: 13, fontWeight: '700' },
  input: { backgroundColor: theme.bubble, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, color: theme.text, fontSize: 14 },
  tall: { minHeight: 80, textAlignVertical: 'top' },
  createBtn: { backgroundColor: theme.accent, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  createBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  sectionTitle: { color: theme.text, fontSize: 14, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1 },
  card: { backgroundColor: theme.panel, borderWidth: 1, borderColor: theme.border, borderRadius: 14, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 },
  cardBody: { flex: 1, gap: 3 },
  cardTitle: { color: theme.text, fontSize: 15, fontWeight: '600' },
  muted: { color: theme.textMuted, fontSize: 13, lineHeight: 19 },
  meta: { color: theme.textMuted, fontSize: 11 },
  delete: { color: theme.error, fontSize: 12 },
  error: { color: theme.error, fontSize: 13 },
})
