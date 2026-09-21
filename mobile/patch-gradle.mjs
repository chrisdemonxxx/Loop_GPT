import { createRequire } from 'node:module'
const require = createRequire('C:/Users/chris/Desktop/Workspace/dev-projects/loop-gpt/mobile/node_modules/expo/package.json')
import fs from 'node:fs'
import path from 'node:path'

// Fix 1: Patch all expo module build.gradle files (replace expo-module-gradle-plugin)
const modulesDir = path.join(path.dirname(require.resolve('expo/package.json')), '..')
if (fs.existsSync(modulesDir)) {
  for (const name of fs.readdirSync(modulesDir)) {
    const bgPath = path.join(modulesDir, name, 'android', 'build.gradle')
    if (fs.existsSync(bgPath)) {
      let content = fs.readFileSync(bgPath, 'utf8')
      if (content.includes("id 'expo-module-gradle-plugin'")) {
        content = content.replace(
          "plugins {\n  id 'com.android.library'\n  id 'expo-module-gradle-plugin'\n}",
          "apply plugin: 'com.android.library'\napply from: new File(project(':expo-modules-core').projectDir, 'android/ExpoModulesCorePlugin.gradle')\napplyKotlinExpoModulesCorePlugin()"
        )
        fs.writeFileSync(bgPath, content, 'utf8')
        console.log('FIX1 PATCHED:', name)
      }
    }
  }
}

// Fix 2: Fix expo/android/build.gradle plugin path
const expoBuildGradle = path.join(path.dirname(require.resolve('expo/package.json')), 'android', 'build.gradle')
if (fs.existsSync(expoBuildGradle)) {
  let content = fs.readFileSync(expoBuildGradle, 'utf8')
  if (content.includes('"ExpoModulesCorePlugin.gradle"') && !content.includes('android/')) {
    content = content.replace('"ExpoModulesCorePlugin.gradle"', '"android/ExpoModulesCorePlugin.gradle"')
  }
  // Remove useDefaultAndroidSdkVersions (it doesn't work) and set SDK versions directly
  content = content.replace('\nuseDefaultAndroidSdkVersions()', '')
  if (!content.includes('// force SDK versions')) {
    content = content.replace(
      'useExpoPublishing()',
      'useExpoPublishing()\n// force SDK versions for EAS compatibility\nandroid.compileSdkVersion = 35\nandroid.defaultConfig.targetSdkVersion = 34\nandroid.defaultConfig.minSdkVersion = 24'
    )
  }
  fs.writeFileSync(expoBuildGradle, content, 'utf8')
  console.log('FIX2: expo build.gradle patched')
}
