/**
 * Expo config plugin to patch the Android project after prebuild.
 * Now only patches root build.gradle ext properties.
 * The patch-gradle.mjs script handles node_modules-level fixes.
 */
const { withSettingsGradle, withProjectBuildGradle } = require('@expo/config-plugins')

module.exports = function withAndroidPatch(expoConfig) {
  let config = expoConfig

  // Patch root build.gradle: ensure ext properties for subproject SDK versions
  config = withProjectBuildGradle(config, (cfg) => {
    if (!cfg.modResults.contents.includes('[loop-gpt-patch]')) {
      cfg.modResults.contents += '\n\nproject.ext.compileSdkVersion = 35\nproject.ext.targetSdkVersion = 34\nproject.ext.minSdkVersion = 24\n// [loop-gpt-patch] expo modules SDK\n'
    }
    return cfg
  })

  return config
}
