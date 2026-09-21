/**
 * Expo config plugin to patch the Android project after prebuild.
 * Only patches settings.gradle and root build.gradle.
 * The patch-gradle.mjs script handles node_modules-level fixes.
 */
const { withSettingsGradle, withProjectBuildGradle } = require('@expo/config-plugins')

module.exports = function withAndroidPatch(expoConfig) {
  let config = expoConfig

  // Patch settings.gradle: include expo-modules-core
  config = withSettingsGradle(config, (cfg) => {
    if (!cfg.modResults.contents.includes('expo-modules-core')) {
      cfg.modResults.contents += `

// [loop-gpt-patch] include expo-modules-core (direct Gradle build compatibility)
def emcRoot = new File(["node", "--print", "require.resolve('expo-modules-core/package.json', { paths: [require.resolve('expo/package.json')] })"].execute(null, rootDir).text.trim()).getParentFile()
include ':expo-modules-core'
project(':expo-modules-core').projectDir = emcRoot
`
    }
    return cfg
  })

  // Patch root build.gradle: ensure ext properties for subproject SDK versions
  config = withProjectBuildGradle(config, (cfg) => {
    if (!cfg.modResults.contents.includes('[loop-gpt-patch]')) {
      cfg.modResults.contents += '\n\n// [loop-gpt-patch] expo modules SDK\nproject.ext.compileSdkVersion = 35\nproject.ext.targetSdkVersion = 34\nproject.ext.minSdkVersion = 24\n'
    }
    return cfg
  })

  return config
}
