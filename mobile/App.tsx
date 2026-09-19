import { useEffect, useState } from 'react'
import { StatusBar } from 'expo-status-bar'
import { StyleSheet, View } from 'react-native'
import { clearAuth, getToken } from './src/lib/api'
import Login from './src/screens/Login'
import ChatList from './src/screens/ChatList'
import Chat from './src/screens/Chat'
import { theme } from './src/theme'

/** Lightweight state router; a navigation library arrives with the mature app. */
export default function App() {
  const [authed, setAuthed] = useState(false)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [listKey, setListKey] = useState(0)

  useEffect(() => { setAuthed(!!getToken()) }, [])

  if (!authed) return <Login onAuthed={() => setAuthed(true)} />
  if (conversationId) {
    return (
      <View style={styles.root}>
        <StatusBar style="light" />
        <Chat conversationId={conversationId} onOpenConversation={(id) => setConversationId(id)} />
      </View>
    )
  }
  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <ChatList
        key={listKey}
        onOpen={(id) => setConversationId(id)}
        onNew={() => setConversationId(null)}
        onLogout={() => { clearAuth(); setConversationId(null); setListKey((k) => k + 1); setAuthed(false) }}
      />
    </View>
  )
}

const styles = StyleSheet.create({ root: { flex: 1, backgroundColor: theme.bg } })
