import { readFileSync, writeFileSync } from 'node:fs'
const gradle = 'C:/Users/chris/Desktop/Workspace/dev-projects/loop-gpt/mobile/node_modules/expo/android/build.gradle'
let content = readFileSync(gradle, 'utf8')
// Add compileSdkVersion INSIDE the android {} block (replicate after 'android {')
content = content.replace('  namespace "expo.core"', '  namespace "expo.core"\n    compileSdkVersion = 35')
writeFileSync(gradle, content, 'utf8')
console.log('INSIDE_ANDROID_PATCHED')
