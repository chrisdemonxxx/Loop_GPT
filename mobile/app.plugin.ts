/**
 * Expo config plugin to patch the Android project after prebuild.
 * Fixes the expo-modules-core Gradle plugin path and SDK versions.
 * Applied automatically by EAS during the prebuild phase.
 */
const { withAppBuildGradle, withProjectBuildGradle, withSettingsGradle } = require('@expo/config-plugins')

module.exports = function withAndroidPatch(config) {
  // Patch settings.gradle: include expo-modules-core project
  config = withSettingsGradle(config, (cfg) => {
    if (!cfg.modResults.contents.includes('expo-modules-core')) {
      cfg.modResults.contents += `

// [loop-gpt-patch] expo-modules-core include for direct Gradle compatibility
def emcRoot = new File(["node", "--print", "require.resolve('expo-modules-core/package.json', { paths: [require.resolve('expo/package.json')] })"].execute(null, rootDir).text.trim()).getParentFile()
include ':expo-modules-core'
project(':expo-modules-core').projectDir = emcRoot
`
    }
    return cfg
  })

  // Patch app/build.gradle: force SDK versions
  config = withAppBuildGradle(config, (cfg) => {
    const lines = cfg.modResults.contents.split('\n')
    const headerEnd = lines.findIndex(l => l.includes('def projectRoot'))
    if (headerEnd >= 0 && !lines.some(l => l.includes('compileSdkVersion'))) {
      lines.splice(headerEnd, 0, 'project.ext.compileSdkVersion = 35')
      lines.splice(headerEnd, 0, 'project.ext.targetSdkVersion = 34')
      lines.splice(headerEnd, 0, 'project.ext.minSdkVersion = 24')
      cfg.modResults.contents = lines.join('\n')
    }
    return cfg
  })

  // Patch expo/android/build.gradle plugin path (this is in node_modules so it persists)
  try {
    const fs = require('fs')
    const path = require('path')
    const expoBuildGradle = path.join(
      require.resolve('expo/package.json').replace('package.json', ''),
      'android', 'build.gradle'
    )
    if (fs.existsSync(expoBuildGradle)) {
      let content = fs.readFileSync(expoBuildGradle, 'utf8')
      if (content.includes('"ExpoModulesCorePlugin.gradle"') && !content.includes('android/ExpoModulesCorePlugin.gradle"')) {
        content = content.replace(
          '"ExpoModulesCorePlugin.gradle"',
          '"android/ExpoModulesCorePlugin.gradle"'
        )
        fs.writeFileSync(expoBuildGradle, content, 'utf8')
      }
    }
  } catch {}
  return config
}
