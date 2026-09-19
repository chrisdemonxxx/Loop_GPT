import { useCallback, useEffect, useRef, useState } from 'react'
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { conversations, type Message } from '../lib/api'
import { runAgentStream, parseCommand } from '../lib/stream'
import { theme } from '../theme'

interface Bubble { key: string; role: 'user' | 'assistant'; content: string }

export default function Chat({ conversationId, onOpenConversation }: {
  conversationId: string | null
  onOpenConversation: (id: string) => void
}) {
  const [bubbles, setBubbles] = useState<Bubble[]>([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const cancelRef = useRef<{ cancel: () => void } | null>(null)

  useEffect(() => {
    setBubbles([])
    if (!conversationId) return
    conversations.messages(conversationId).then((rows) => {
      setBubbles(rows.map((m: Message) => ({ key: m.id, role: m.role, content: m.content })))
    }).catch(() => {})
  }, [conversationId])

  useEffect(() => () => cancelRef.current?.cancel(), [])

  const send = useCallback(() => {
    const text = input.trim()
    if (!text || running) return
    setInput('')
    setRunning(true)
    setStatus('Preparing…')
    setBubbles((prev) => [...prev, { key: `user-${Date.now()}`, role: 'user', content: text }])
    const { mode, text: prompt } = parseCommand(text)
    const answerKey = `assistant-${Date.now()}`
    setBubbles((prev) => [...prev, { key: answerKey, role: 'assistant', content: '' }])
    const append = (delta: string) => setBubbles((prev) => prev.map((b) =>
      b.key === answerKey ? { ...b, content: b.content + delta } : b))
    cancelRef.current = runAgentStream(conversationId ?? 'new', { content: prompt, mode }, {
      onStatus: (message) => {
        setStatus(message)
        const match = message.match(/conversation:(\S+)/)
        if (match && !conversationId) onOpenConversation(match[1])
      },
      onDelta: append,
      onFinal: (content) => setBubbles((prev) => prev.map((b) =>
        b.key === answerKey ? { ...b, content } : b)),
      onError: (message) => setBubbles((prev) => prev.map((b) =>
        b.key === answerKey ? { ...b, content: b.content || `⚠️ ${message}` } : b)),
      onDone: () => { setRunning(false); setStatus(null) },
    })
  }, [input, running, conversationId, onOpenConversation])

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      <FlatList
        data={bubbles}
        keyExtractor={(b) => b.key}
        contentContainerStyle={styles.list}
        ListEmptyComponent={<Text style={styles.empty}>How can I help you today?</Text>}
        renderItem={({ item }) => (
          <View style={[styles.bubble, item.role === 'user' ? styles.userBubble : styles.assistantBubble]}>
            <Text style={item.role === 'user' ? styles.userText : styles.assistantText}>{item.content}</Text>
          </View>
        )}
      />
      {status && <Text style={styles.status}>{status}</Text>}
      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Message Loop GPT…"
          placeholderTextColor={theme.textMuted}
          multiline
          editable={!running}
        />
        {running ? (
          <Pressable style={styles.stop} onPress={() => { cancelRef.current?.cancel(); setRunning(false); setStatus(null) }}>
            <Text style={styles.stopText}>Stop</Text>
          </Pressable>
        ) : (
          <Pressable style={({ pressed }) => [styles.send, !input.trim() && styles.sendDisabled, pressed && { opacity: 0.85 }]}
            onPress={send} disabled={!input.trim()}>
            <Text style={styles.sendText}>Send</Text>
          </Pressable>
        )}
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  list: { padding: 16, gap: 10, paddingBottom: 24 },
  empty: { color: theme.textMuted, textAlign: 'center', paddingTop: 80, fontSize: 16 },
  bubble: { maxWidth: '85%', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10 },
  userBubble: { alignSelf: 'flex-end', backgroundColor: theme.bubble, borderWidth: 1, borderColor: theme.border },
  assistantBubble: { alignSelf: 'flex-start' },
  userText: { color: theme.text, fontSize: 15, lineHeight: 22 },
  assistantText: { color: theme.text, fontSize: 15, lineHeight: 22 },
  status: { color: theme.textMuted, fontSize: 12, paddingHorizontal: 16, paddingBottom: 6 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 12 },
  input: { flex: 1, backgroundColor: theme.panel, borderWidth: 1, borderColor: theme.border, borderRadius: 14,
    paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12, color: theme.text, fontSize: 15, maxHeight: 120 },
  send: { backgroundColor: theme.accent, borderRadius: 12, paddingHorizontal: 18, paddingVertical: 13 },
  sendDisabled: { opacity: 0.3 },
  sendText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  stop: { borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingHorizontal: 18, paddingVertical: 13 },
  stopText: { color: theme.text, fontSize: 14 },
})
