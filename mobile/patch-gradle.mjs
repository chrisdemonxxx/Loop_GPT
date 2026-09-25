import { createRequire } from 'node:module'
const require = createRequire('C:/Users/chris/Desktop/Workspace/dev-projects/loop-gpt/mobile/node_modules/expo/package.json')
import fs from 'node:fs'
import path from 'node:path'

const modulesDir = path.join(path.dirname(require.resolve('expo/package.json')), '..')

// Fix 1: Patch all expo module build.gradle files
if (fs.existsSync(modulesDir)) {
  for (const name of fs.readdirSync(modulesDir)) {
    const bgPath = path.join(modulesDir, name, 'android', 'build.gradle')
    if (!fs.existsSync(bgPath)) continue
    let content = fs.readFileSync(bgPath, 'utf8')

    // a) Replace expo-module-gradle-plugin with direct plugin application
    if (content.includes("id 'expo-module-gradle-plugin'")) {
      content = content.replace(
        "plugins {\n  id 'com.android.library'\n  id 'expo-module-gradle-plugin'\n}",
        "apply plugin: 'com.android.library'\napply from: new File(project(':expo-modules-core').projectDir, 'android/ExpoModulesCorePlugin.gradle')\napplyKotlinExpoModulesCorePlugin()"
      )
      console.log('FIX1a PATCHED:', name)
    }

    // b) Fix the apply from path — ensure it includes android/ prefix
    if (content.includes('"ExpoModulesCorePlugin.gradle"') && !content.includes('"android/ExpoModulesCorePlugin.gradle"')) {
      content = content.replace('"ExpoModulesCorePlugin.gradle"', '"android/ExpoModulesCorePlugin.gradle"')
      console.log('FIX1c PATH FIXED:', name)
    }

    // c) Remove useDefaultAndroidSdkVersions and replace with direct SDK version
    if (content.includes('useDefaultAndroidSdkVersions')) {
      content = content.replace('\nuseDefaultAndroidSdkVersions()', '\n// useDefaultAndroidSdkVersions removed\nandroid.compileSdkVersion = 35')
      console.log('FIX1d REMOVED useDefaultAndroidSdkVersions:', name)
    }

    // d) Add compileSdkVersion inside the android {} block if missing (and not already added)
    if (!content.includes('compileSdkVersion') && content.includes('namespace')) {
      content = content.replace(
        /android \{/,
        'android {\n    compileSdkVersion = 35'
      )
      console.log('FIX1b SDK PATCHED:', name)
    }

    fs.writeFileSync(bgPath, content, 'utf8')
  }
}

// Fix 2: Patch expo/android/build.gradle — direct plugin path + SDK version BEFORE plugin applies
const expoBuildGradle = path.join(path.dirname(require.resolve('expo/package.json')), 'android', 'build.gradle')
if (fs.existsSync(expoBuildGradle)) {
  let content = fs.readFileSync(expoBuildGradle, 'utf8')
  // Replace project reference with direct file path
  content = content.replace(
    /new File\(project\(":expo-modules-core"\)\.projectDir\.absolutePath, "android\/ExpoModulesCorePlugin\.gradle"\)/,
    'new File(project.buildDir.parentFile.parentFile, "node_modules/expo-modules-core/android/ExpoModulesCorePlugin.gradle")'
  )
  // Remove useDefaultAndroidSdkVersions
  content = content.replace('\nuseDefaultAndroidSdkVersions()', '')
  // Set android.compileSdkVersion BEFORE the imports that apply plugins
  if (!content.includes('// [loop-sdk]')) {
    content = content.replace(
      "apply from: \"../scripts/autolinking.gradle\"",
      "android.compileSdkVersion = 35\nandroid.defaultConfig.targetSdkVersion = 34\nandroid.defaultConfig.minSdkVersion = 24\n// [loop-sdk]\napply from: \"../scripts/autolinking.gradle\""
    )
  }
  content = content.replace('\nandroid.compileSdkVersion = 35\nandroid.defaultConfig.targetSdkVersion = 34\nandroid.defaultConfig.minSdkVersion = 24\n// [loop-sdk]', ''); // remove duplicate
  fs.writeFileSync(expoBuildGradle, content, 'utf8')
  console.log('FIX2: expo patched')
}

// Fix 3: Patch ExpoModulesCorePlugin.gradle — fix 'release' property error in useExpoPublishing
const emcNestedPath = path.join(path.dirname(require.resolve('expo/package.json')), 'node_modules', 'expo-modules-core', 'android', 'ExpoModulesCorePlugin.gradle')
for (const pluginPath of [path.join(modulesDir, 'expo-modules-core', 'android', 'ExpoModulesCorePlugin.gradle'), emcNestedPath]) {
  if (fs.existsSync(pluginPath)) {
    let content = fs.readFileSync(pluginPath, 'utf8')
    // The 'release' error comes from 'from components.release' — wrap with null-safe check
    if (content.includes('from components.release')) {
      content = content.replace(
        'from components.release',
        'if (components.findByName("release") != null) { from components.release } else { from components.findByName("debug") }'
      )
      console.log('FIX3 PLUGIN PATCHED (release check):', pluginPath)
    }
    // Also disable the useExpoPublishing call
    content = content.replace(/\nuseExpoPublishing\(\)/g, '\n// useExpoPublishing() disabled')
    fs.writeFileSync(pluginPath, content, 'utf8')
  }
}
