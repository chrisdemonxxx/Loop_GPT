import { useState } from 'react'
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import { theme } from '../theme'

/** Product origin for the web app's /build route. EXPO_PUBLIC_WEB_URL overrides
 *  the hosted site. The Expo app has no LOOPIT_ENABLED flag, so this screen
 *  is always in the navigation. */
const WEB_ORIGIN = (process.env.EXPO_PUBLIC_WEB_URL || 'https://loop-gpt.cyou').replace(/\/+$/, '')
export const BUILD_URL = `${WEB_ORIGIN}/build/`

export default function Build({ onClose }: { onClose: () => void }) {
  const [error, setError] = useState('')

  async function open() {
    setError('')
    try {
      await Linking.openURL(BUILD_URL)
    } catch {
      setError('Could not open the Build page.')
    }
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={onClose}><Text style={styles.back}>‹ Chats</Text></Pressable>
        <Text style={styles.title}>Build</Text>
      </View>
      <Text style={styles.body}>
        Build runs in the web app. This opens the /build page in the browser.
      </Text>
      <Pressable style={({ pressed }) => [styles.button, pressed && { opacity: 0.85 }]} onPress={() => { void open() }}>
        <Text style={styles.buttonText}>Open Build</Text>
      </Pressable>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Text style={styles.url}>{BUILD_URL}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg, paddingTop: 56, paddingHorizontal: 16 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 20 },
  back: { color: '#e79d7f', fontSize: 15 },
  title: { color: theme.text, fontSize: 20, fontWeight: '700' },
  body: { color: theme.textMuted, fontSize: 14, lineHeight: 20, marginBottom: 16 },
  button: { backgroundColor: theme.accent, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  error: { color: theme.error, fontSize: 13, marginTop: 12 },
  url: { color: theme.textFaint, fontSize: 12, marginTop: 16 },
})
