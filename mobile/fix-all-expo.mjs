import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire('C:/Users/chris/Desktop/Workspace/dev-projects/loop-gpt/mobile/node_modules/expo/package.json')
const modulesDir = join(dirname(require.resolve('expo/package.json')), '..')

for (const name of readdirSync(modulesDir)) {
  const bgPath = join(modulesDir, name, 'android', 'build.gradle')
  if (!existsSync(bgPath)) continue
  let content = readFileSync(bgPath, 'utf8')
  const before = content
  // Replace project(":expo-modules-core") with direct file path
  content = content.replace(
    'new File(project(":expo-modules-core").projectDir.absolutePath, "android/ExpoModulesCorePlugin.gradle")',
    'new File(rootProject.projectDir.parentFile, "node_modules/expo-modules-core/android/ExpoModulesCorePlugin.gradle")'
  )
  content = content.replace(
    'new File(project(\':expo-modules-core\').projectDir.absolutePath, \'android/ExpoModulesCorePlugin.gradle\')',
    'new File(rootProject.projectDir.parentFile, \'node_modules/expo-modules-core/android/ExpoModulesCorePlugin.gradle\')'
  )
  if (content !== before) {
    writeFileSync(bgPath, content, 'utf8')
    console.log('FIXED:', name)
  }
}
