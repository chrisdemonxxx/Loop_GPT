import { useCallback, useMemo, useState, type ComponentType, type ReactElement } from 'react'
import { ActivityIndicator, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { theme } from '../theme'

/** Product origin for the web app's /build route. EXPO_PUBLIC_WEB_URL overrides
 *  the hosted site. The Expo app has no LOOPIT_ENABLED flag, so this screen
 *  is always in the navigation. */
const WEB_ORIGIN = (process.env.EXPO_PUBLIC_WEB_URL || 'https://loop-gpt.cyou').replace(/\/+$/, '')
export const BUILD_URL = `${WEB_ORIGIN}/build/`

/** Prefer in-app WebView (Phase 3.5). Falls back to Linking when the native
 *  module is unavailable (Expo Go without the package, or web). */
let WebViewComponent: ComponentType<{
  source: { uri: string }
  style?: object
  onError?: () => void
  startInLoadingState?: boolean
  renderLoading?: () => ReactElement
}> | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  WebViewComponent = require('react-native-webview').WebView
} catch {
  WebViewComponent = null
}

export default function Build({ onClose }: { onClose: () => void }) {
  const [error, setError] = useState('')
  const [useExternal, setUseExternal] = useState(false)
  const canEmbed = useMemo(() => Boolean(WebViewComponent) && Platform.OS !== 'web' && !useExternal, [useExternal])

  const openExternal = useCallback(async () => {
    setError('')
    try {
      await Linking.openURL(BUILD_URL)
    } catch {
      setError('Could not open the Build page.')
    }
  }, [])

  if (canEmbed && WebViewComponent) {
    const WebView = WebViewComponent
    return (
      <View style={styles.root}>
        <View style={styles.header}>
          <Pressable onPress={onClose}><Text style={styles.back}>‹ Chats</Text></Pressable>
          <Text style={styles.title}>Build</Text>
          <Pressable onPress={() => { void openExternal() }}>
            <Text style={styles.link}>Browser</Text>
          </Pressable>
        </View>
        <WebView
          source={{ uri: BUILD_URL }}
          style={styles.webview}
          startInLoadingState
          renderLoading={() => (
            <View style={styles.loading}>
              <ActivityIndicator color={theme.accent} />
            </View>
          )}
          onError={() => {
            setUseExternal(true)
            setError('In-app Build view failed — use Open in browser.')
          }}
        />
        {error ? <Text style={styles.errorBanner}>{error}</Text> : null}
      </View>
    )
  }

  return (
    <View style={styles.rootPad}>
      <View style={styles.header}>
        <Pressable onPress={onClose}><Text style={styles.back}>‹ Chats</Text></Pressable>
        <Text style={styles.title}>Build</Text>
      </View>
      <Text style={styles.body}>
        {WebViewComponent
          ? 'Build opens in the system browser on this platform.'
          : 'Install react-native-webview for an in-app Build view. Until then this opens /build in the browser.'}
      </Text>
      <Pressable style={({ pressed }) => [styles.button, pressed && { opacity: 0.85 }]} onPress={() => { void openExternal() }}>
        <Text style={styles.buttonText}>Open Build</Text>
      </Pressable>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Text style={styles.url}>{BUILD_URL}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg, paddingTop: 56 },
  rootPad: { flex: 1, backgroundColor: theme.bg, paddingTop: 56, paddingHorizontal: 16 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12, paddingHorizontal: 16 },
  back: { color: '#e79d7f', fontSize: 15 },
  title: { color: theme.text, fontSize: 20, fontWeight: '700', flex: 1 },
  link: { color: theme.accent, fontSize: 13 },
  body: { color: theme.textMuted, fontSize: 14, lineHeight: 20, marginBottom: 16 },
  button: { backgroundColor: theme.accent, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  error: { color: theme.error, fontSize: 13, marginTop: 12 },
  errorBanner: { color: theme.error, fontSize: 12, padding: 8, textAlign: 'center' },
  url: { color: theme.textFaint, fontSize: 12, marginTop: 16 },
  webview: { flex: 1, backgroundColor: theme.bg },
  loading: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.bg },
})
