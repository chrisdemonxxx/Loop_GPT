import { useCallback, useEffect, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { memory, skills, stylesApi, connectors } from '../lib/api'
import { theme } from '../theme'

/**
 * Settings (web-IA parity, §2/§3/§5/§4): Memory (toggle + list + delete),
 * Personalization (active style), Skills (toggles), Connectors (status list).
 */
export default function Settings({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<'memory' | 'style' | 'skills' | 'connectors'>('memory')

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={onClose}><Text style={styles.back}>‹ Chats</Text></Pressable>
        <Text style={styles.title}>Settings</Text>
      </View>
      <View style={styles.tabs}>
        {(['memory', 'style', 'skills', 'connectors'] as const).map((s) => (
          <Pressable key={s} onPress={() => setSection(s)} style={[styles.tab, section === s && styles.tabActive]}>
            <Text style={[styles.tabText, section === s && styles.tabTextActive]}>
              {s === 'style' ? 'Style' : s[0].toUpperCase() + s.slice(1)}
            </Text>
          </Pressable>
        ))}
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        {section === 'memory' && <MemorySection />}
        {section === 'style' && <StyleSection />}
        {section === 'skills' && <SkillsSection />}
        {section === 'connectors' && <ConnectorsSection />}
      </ScrollView>
    </View>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  )
}

function MemorySection() {
  const [rows, setRows] = useState<any[]>([])
  const [enabled, setEnabled] = useState(true)
  const [text, setText] = useState('')

  const load = useCallback(() => {
    memory.list().then((d: any) => { setRows(d.memories || []); setEnabled(d.enabled !== false) }).catch(() => {})
  }, [])
  useEffect(() => { load() }, [load])

  return (
    <>
      <Section title="Use memory across conversations">
        <View style={styles.rowBetween}>
          <Text style={styles.muted}>Memories are included in every new chat.</Text>
          <Switch
            value={enabled}
            onValueChange={(v) => { setEnabled(v); memory.setEnabled(v).catch(() => {}) }}
            trackColor={{ true: theme.accent, false: theme.border }}
            thumbColor="#fff"
          />
        </View>
      </Section>
      <Section title="Add a memory">
        <View style={styles.rowBetween}>
          <TextInput style={styles.input} value={text} onChangeText={setText} placeholder="e.g. I prefer concise answers" placeholderTextColor={theme.textMuted} />
          <Pressable style={styles.smallBtn} onPress={() => { if (!text.trim()) return; memory.add(text.trim()).then(() => { setText(''); load() }).catch(() => {}) }}>
            <Text style={styles.smallBtnText}>Add</Text>
          </Pressable>
        </View>
      </Section>
      <Section title={`Memories (${rows.length})`}>
        {rows.length === 0 && <Text style={styles.muted}>Nothing remembered yet. Say “remember that…” in a chat.</Text>}
        {rows.map((m) => (
          <View key={m.id} style={styles.card}>
            <View style={styles.cardBody}>
              <Text style={styles.cardText}>{m.content}</Text>
              <Text style={styles.badge}>{m.source === 'agent' ? 'learned' : 'you added'}</Text>
            </View>
            <Pressable onPress={() => { memory.remove(m.id).then(load).catch(() => {}) }}>
              <Text style={styles.delete}>Delete</Text>
            </Pressable>
          </View>
        ))}
      </Section>
    </>
  )
}

function StyleSection() {
  const [rows, setRows] = useState<any[]>([])
  useEffect(() => { stylesApi.list().then(setRows).catch(() => {}) }, [])
  return (
    <Section title="Active writing style">
      <Text style={styles.muted}>Pick the default style used in every conversation. Presets: Normal, Concise, Explanatory, Formal (create or fine-tune them on the web).</Text>
      <View style={{ height: 12 }} />
      {rows.map((s) => (
        <Pressable key={s.id} style={[styles.card, s.isDefault && styles.cardActive]} onPress={() => { stylesApi.makeDefault(s.id).then(() => setRows((p) => p.map((x) => ({ ...x, isDefault: x.id === s.id })))).catch(() => {}) }}>
          <View style={styles.cardBody}>
            <Text style={styles.cardText}>{s.name}</Text>
          </View>
          {s.isDefault && <Text style={styles.activeBadge}>active</Text>}
        </Pressable>
      ))}
    </Section>
  )
}

function SkillsSection() {
  const [rows, setRows] = useState<any[]>([])
  useEffect(() => { skills.list().then(setRows).catch(() => {}) }, [])
  return (
    <Section title="Skills">
      <Text style={styles.muted}>Skills teach the assistant reusable workflows. Full editing lives on the web app.</Text>
      <View style={{ height: 12 }} />
      {rows.map((s) => (
        <View key={s.id} style={styles.card}>
          <View style={styles.cardBody}>
            <Text style={styles.cardText}>{s.name}{s.builtin ? '  (built-in)' : ''}</Text>
            <Text style={styles.muted} numberOfLines={2}>{s.description}</Text>
          </View>
          <Switch
            value={s.enabled}
            onValueChange={(v) => { setRows((p) => p.map((x) => (x.id === s.id ? { ...x, enabled: v } : x))); skills.toggle(s.id, v).catch(() => {}) }}
            trackColor={{ true: theme.accent, false: theme.border }}
            thumbColor="#fff"
          />
        </View>
      ))}
    </Section>
  )
}

function ConnectorsSection() {
  const [data, setData] = useState<any>(null)
  useEffect(() => { connectors.list().then(setData).catch(() => {}) }, [])
  return (
    <Section title="Connectors">
      <Text style={styles.muted}>Live status of your app connections. Connect and test them in the web app (Settings → Connectors).</Text>
      <View style={{ height: 12 }} />
      {(data?.configured ?? []).length === 0 && <Text style={styles.muted}>Nothing connected yet.</Text>}
      {(data?.configured ?? []).map((c: any) => (
        <View key={c.id} style={styles.card}>
          <View style={styles.cardBody}>
            <Text style={styles.cardText}>{c.name}</Text>
            <Text style={[styles.badge, c.lastTestOk === false && { color: theme.error }]}>
              {c.lastTestOk === null || c.lastTestOk === undefined ? 'not tested' : c.lastTestOk ? 'connection OK' : 'test failed'}
            </Text>
          </View>
        </View>
      ))}
      {(data?.configured ?? []).length > 0 && (
        <Text style={styles.muted}>{(data?.types ?? []).length} connectors available · {(data?.marketplace ?? []).length} in the marketplace (web)</Text>
      )}
    </Section>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderBottomWidth: 1, borderBottomColor: theme.border },
  back: { color: '#e79d7f', fontSize: 15 },
  title: { color: theme.text, fontSize: 17, fontWeight: '700' },
  tabs: { flexDirection: 'row', paddingHorizontal: 12, paddingTop: 12, gap: 6 },
  tab: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 12, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.panel },
  tabActive: { borderColor: theme.accent, backgroundColor: 'rgba(201,100,66,0.12)' },
  tabText: { color: theme.textMuted, fontSize: 13 },
  tabTextActive: { color: '#e79d7f', fontWeight: '600' },
  body: { padding: 16, gap: 12, paddingBottom: 40 },
  section: { gap: 10 },
  sectionTitle: { color: theme.text, fontSize: 14, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  muted: { color: theme.textMuted, fontSize: 13, lineHeight: 19, flex: 1 },
  input: { flex: 1, backgroundColor: theme.panel, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, color: theme.text, fontSize: 14 },
  smallBtn: { backgroundColor: theme.accent, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 11 },
  smallBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  card: { backgroundColor: theme.panel, borderWidth: 1, borderColor: theme.border, borderRadius: 14, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 },
  cardActive: { borderColor: theme.accent },
  cardBody: { flex: 1, gap: 2 },
  cardText: { color: theme.text, fontSize: 14 },
  badge: { color: theme.textMuted, fontSize: 11 },
  activeBadge: { color: '#e79d7f', fontSize: 11, fontWeight: '600' },
  delete: { color: theme.error, fontSize: 12 },
})
