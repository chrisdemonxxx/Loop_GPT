import { useState } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { auth, ApiError } from '../lib/api'
import { theme } from '../theme'

export default function Login({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (mode === 'login') {
        const { token } = await auth.login(email.trim(), password)
        if (token) onAuthed()
      } else {
        await auth.register(email.trim(), password, name.trim() || 'Loop user')
        const { token } = await auth.login(email.trim(), password)
        if (token) onAuthed()
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Sign-in failed. Check your details and connection.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.card}>
        <View style={styles.logo}>
          <Text style={styles.logoMark}>✦</Text>
        </View>
        <Text style={styles.title}>Loop GPT</Text>
        <Text style={styles.subtitle}>
          {mode === 'login' ? 'Sign in to your Loop account' : 'Create your Loop account'}
        </Text>
        {mode === 'signup' && (
          <TextInput style={styles.input} placeholder="Name" placeholderTextColor={theme.textMuted}
            value={name} onChangeText={setName} autoCapitalize="words" />
        )}
        <TextInput style={styles.input} placeholder="Email" placeholderTextColor={theme.textMuted}
          value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
        <TextInput style={styles.input} placeholder="Password" placeholderTextColor={theme.textMuted}
          value={password} onChangeText={setPassword} secureTextEntry />
        {error && <Text style={styles.error}>{error}</Text>}
        <Pressable style={({ pressed }) => [styles.button, pressed && { opacity: 0.85 }]} onPress={submit} disabled={busy}>
          {busy
            ? <ActivityIndicator color="#fff" />
            : <Text style={styles.buttonText}>{mode === 'login' ? 'Sign in' : 'Sign up'}</Text>}
        </Pressable>
        <Pressable onPress={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(null) }}>
          <Text style={styles.switch}>
            {mode === 'login' ? 'No account? Sign up' : 'Have an account? Sign in'}
          </Text>
        </Pressable>
        <Text style={styles.note}>Your session stays in memory only. Restarting the app signs you out.</Text>
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg, justifyContent: 'center', padding: 24 },
  card: { gap: 10 },
  logo: { width: 44, height: 44, borderRadius: 14, backgroundColor: theme.accent, alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
  logoMark: { color: '#fff', fontSize: 20 },
  title: { color: theme.text, fontSize: 24, fontWeight: '700', textAlign: 'center', marginTop: 8 },
  subtitle: { color: theme.textMuted, fontSize: 14, textAlign: 'center', marginBottom: 8 },
  input: { backgroundColor: theme.panel, borderWidth: 1, borderColor: theme.border, borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 12, color: theme.text, fontSize: 15 },
  error: { color: theme.error, fontSize: 13, textAlign: 'center' },
  button: { backgroundColor: theme.accent, borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginTop: 4 },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  switch: { color: theme.accent, fontSize: 13, textAlign: 'center', paddingVertical: 8 },
  note: { color: theme.textFaint, fontSize: 11, textAlign: 'center', marginTop: 12 },
})
