import { readFileSync, writeFileSync } from 'node:fs'
const gradle = 'C:/Users/chris/Desktop/Workspace/dev-projects/loop-gpt/mobile/node_modules/expo/android/build.gradle'
let content = readFileSync(gradle, 'utf8')
content = content.replace(
  "project.ext.compileSdkVersion = 35\nproject.ext.targetSdkVersion = 34\nproject.ext.minSdkVersion = 24",
  "rootProject.ext.compileSdkVersion = 35\nrootProject.ext.targetSdkVersion = 34\nrootProject.ext.minSdkVersion = 24"
)
writeFileSync(gradle, content, 'utf8')
console.log('ROOTPROJECT_EXTS_SET')
