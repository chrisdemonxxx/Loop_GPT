import { readFileSync, writeFileSync } from 'node:fs'
const gradle = 'C:/Users/chris/Desktop/Workspace/dev-projects/loop-gpt/mobile/node_modules/expo/android/build.gradle'
let content = readFileSync(gradle, 'utf8')
const needle = 'apply from: "../scripts/autolinking.gradle"'
const idx = content.indexOf(needle)
if (idx >= 0) {
  const before = content.slice(0, idx)
  const rest = content.slice(idx + needle.length)
  content = before + 'android.compileSdkVersion = 35\n// [loop-sdk]\n' + needle + rest
  writeFileSync(gradle, content, 'utf8')
  console.log('PATCHED')
} else {
  console.log('NOT FOUND')
}
