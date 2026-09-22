import { useCallback, useEffect, useRef, useState } from 'react'
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { conversations, type Message } from '../lib/api'
import { runAgentStream, parseCommand, type RunMode } from '../lib/stream'
import { theme } from '../theme'

interface Bubble { key: string; role: 'user' | 'assistant' | 'thinking'; content: string }

const RUN_MODES: Array<{ id: RunMode; label: string }> = [
  { id: 'auto', label: 'Auto' },
  { id: 'plan', label: 'Plan' },
  { id: 'step', label: 'Ask first' },
  { id: 'accept', label: 'Accept' },
]

export default function Chat({ conversationId, onOpenConversation }: {
  conversationId: string | null
  onOpenConversation: (id: string) => void
}) {
  const [bubbles, setBubbles] = useState<Bubble[]>([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [runMode, setRunMode] = useState<RunMode>('auto')
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
    const thinkingKey = `thinking-${Date.now()}`
    setBubbles((prev) => [...prev, { key: answerKey, role: 'assistant', content: '' }])
    const append = (delta: string) => setBubbles((prev) => prev.map((b) =>
      b.key === answerKey ? { ...b, content: b.content + delta } : b))
    cancelRef.current = runAgentStream(conversationId ?? 'new', { content: prompt, mode, runMode }, {
      onStatus: (message) => {
        setStatus(message)
        const match = message.match(/conversation:(\S+)/)
        if (match && !conversationId) onOpenConversation(match[1])
      },
      onThinking: (text) => setBubbles((prev) => {
        const i = prev.findIndex((b) => b.key === thinkingKey)
        const thinking: Bubble = { key: thinkingKey, role: 'thinking', content: (i >= 0 ? prev[i].content : '') + text }
        return i >= 0 ? prev.map((b) => (b.key === thinkingKey ? thinking : b)) : [...prev, thinking]
      }),
      onDelta: append,
      onFinal: (content) => setBubbles((prev) => prev.map((b) =>
        b.key === answerKey ? { ...b, content } : b)),
      onError: (message) => setBubbles((prev) => prev.map((b) =>
        b.key === answerKey ? { ...b, content: b.content || `⚠️ ${message}` } : b)),
      onDone: () => { setRunning(false); setStatus(null) },
    })
  }, [input, running, conversationId, runMode, onOpenConversation])

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      <FlatList
        data={bubbles}
        keyExtractor={(b) => b.key}
        contentContainerStyle={styles.list}
        ListEmptyComponent={<Text style={styles.empty}>How can I help you today?</Text>}
        renderItem={({ item }) => (
          item.role === 'thinking' ? (
            <View style={[styles.bubble, styles.thinkingBubble]}>
              <Text style={styles.thinkingLabel}>Thoughts</Text>
              <Text style={styles.thinkingText} numberOfLines={6}>{item.content}</Text>
            </View>
          ) : (
            <View style={[styles.bubble, item.role === 'user' ? styles.userBubble : styles.assistantBubble]}>
              <Text style={item.role === 'user' ? styles.userText : styles.assistantText}>{item.content}</Text>
            </View>
          )
        )}
      />
      {status && <Text style={styles.status}>{status}</Text>}
      {/* Run-mode chips (parity with the web composer §7a) */}
      <View style={styles.modes}>
        {RUN_MODES.map((m) => (
          <Pressable
            key={m.id}
            onPress={() => setRunMode(m.id)}
            style={[styles.modeChip, runMode === m.id && styles.modeChipActive]}
          >
            <Text style={[styles.modeText, runMode === m.id && styles.modeTextActive]}>{m.label}</Text>
          </Pressable>
        ))}
      </View>
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
  thinkingBubble: { alignSelf: 'flex-start', backgroundColor: theme.panel, borderWidth: 1, borderColor: theme.border, borderLeftWidth: 2, borderLeftColor: theme.accent },
  thinkingLabel: { color: theme.textMuted, fontSize: 11, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 },
  thinkingText: { color: theme.textMuted, fontSize: 13, lineHeight: 19 },
  userText: { color: theme.text, fontSize: 15, lineHeight: 22 },
  assistantText: { color: theme.text, fontSize: 15, lineHeight: 22 },
  status: { color: theme.textMuted, fontSize: 12, paddingHorizontal: 16, paddingBottom: 6 },
  modes: { flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingBottom: 8 },
  modeChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.panel },
  modeChipActive: { borderColor: theme.accent, backgroundColor: 'rgba(201,100,66,0.12)' },
  modeText: { color: theme.textMuted, fontSize: 12 },
  modeTextActive: { color: '#e79d7f', fontWeight: '600' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 12 },
  input: { flex: 1, backgroundColor: theme.panel, borderWidth: 1, borderColor: theme.border, borderRadius: 14,
    paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12, color: theme.text, fontSize: 15, maxHeight: 120 },
  send: { backgroundColor: theme.accent, borderRadius: 12, paddingHorizontal: 18, paddingVertical: 13 },
  sendDisabled: { opacity: 0.3 },
  sendText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  stop: { borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingHorizontal: 18, paddingVertical: 13 },
  stopText: { color: theme.text, fontSize: 14 },
})
