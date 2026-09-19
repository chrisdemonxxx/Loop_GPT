import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { conversations, type Conversation } from '../lib/api'
import { theme } from '../theme'

export default function ChatList({ onOpen, onNew, onLogout }: {
  onOpen: (id: string) => void
  onNew: () => void
  onLogout: () => void
}) {
  const [list, setList] = useState<Conversation[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    try { setList(await conversations.list()) } catch { /* leave current list */ } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.brand}>Loop GPT</Text>
        <Pressable onPress={onLogout}><Text style={styles.logout}>Sign out</Text></Pressable>
      </View>
      <Pressable style={({ pressed }) => [styles.newButton, pressed && { opacity: 0.85 }]} onPress={onNew}>
        <Text style={styles.newButtonText}>＋  New session</Text>
      </Pressable>
      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.accent} /></View>
      ) : (
        <FlatList
          data={list}
          keyExtractor={(c) => c.id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} tintColor={theme.accent}
            onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false) }} />}
          ListEmptyComponent={<Text style={styles.empty}>No sessions yet</Text>}
          renderItem={({ item }) => (
            <Pressable style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.panelRaised }]}
              onPress={() => onOpen(item.id)}>
              <Text style={styles.rowTitle} numberOfLines={1}>{item.title || 'New conversation'}</Text>
            </Pressable>
          )}
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg, paddingTop: 56, paddingHorizontal: 16 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  brand: { color: theme.text, fontSize: 20, fontWeight: '700' },
  logout: { color: theme.textMuted, fontSize: 13 },
  newButton: { backgroundColor: theme.accent, borderRadius: 12, paddingVertical: 12, alignItems: 'center', marginBottom: 12 },
  newButtonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  list: { gap: 4, paddingBottom: 24 },
  center: { flex: 1, justifyContent: 'center' },
  empty: { color: theme.textFaint, textAlign: 'center', paddingVertical: 32, fontSize: 13 },
  row: { backgroundColor: theme.panel, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12 },
  rowTitle: { color: theme.text, fontSize: 14 },
})
