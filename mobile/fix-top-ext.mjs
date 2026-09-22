import { readFileSync, writeFileSync } from 'node:fs'
const gradle = 'C:/Users/chris/Desktop/Workspace/dev-projects/loop-gpt/mobile/node_modules/expo/android/build.gradle'
let content = readFileSync(gradle, 'utf8')
// Add top-level compileSdkVersion before plugin apply
content = content.replace(
  "def expoModulesCorePlugin",
  "project.ext.compileSdkVersion = 35\nproject.ext.targetSdkVersion = 34\nproject.ext.minSdkVersion = 24\ndef expoModulesCorePlugin"
)
writeFileSync(gradle, content, 'utf8')
console.log('TOP_LEVEL_EXTS_SET')
