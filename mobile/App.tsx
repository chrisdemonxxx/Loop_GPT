import { useEffect, useState } from 'react'
import { StatusBar } from 'expo-status-bar'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { clearAuth, getToken } from './src/lib/api'
import Login from './src/screens/Login'
import ChatList from './src/screens/ChatList'
import Chat from './src/screens/Chat'
import Settings from './src/screens/Settings'
import Projects from './src/screens/Projects'
import { theme } from './src/theme'

/** Lightweight state router; a navigation library arrives with the mature app. */
type Screen = 'list' | 'chat' | 'settings' | 'projects'

export default function App() {
  const [authed, setAuthed] = useState(false)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [screen, setScreen] = useState<Screen>('list')
  const [listKey, setListKey] = useState(0)

  useEffect(() => { setAuthed(!!getToken()) }, [])

  if (!authed) return <Login onAuthed={() => setAuthed(true)} />

  const goList = () => { setConversationId(null); setScreen('list'); setListKey((k) => k + 1) }

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      {screen === 'chat' ? (
        <Chat conversationId={conversationId} onOpenConversation={(id) => setConversationId(id)} />
      ) : screen === 'settings' ? (
        <Settings onClose={goList} />
      ) : screen === 'projects' ? (
        <Projects onClose={goList} />
      ) : (
        <ChatList
          key={listKey}
          onOpen={(id) => { setConversationId(id); setScreen('chat') }}
          onNew={() => { setConversationId(null); setScreen('chat') }}
          onLogout={() => { clearAuth(); setConversationId(null); setListKey((k) => k + 1); setAuthed(false) }}
          onOpenSettings={() => setScreen('settings')}
          onOpenProjects={() => setScreen('projects')}
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({ root: { flex: 1, backgroundColor: theme.bg } })
