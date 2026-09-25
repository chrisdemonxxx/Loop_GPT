const fs = require('fs')
const root = process.cwd() + '/android/build.gradle'
let c = fs.readFileSync(root, 'utf8')
c = c.replace(/'com\.android\.tools\.build:gradle'[^)]*\)/g, "'com.android.tools.build:gradle:8.6.0')")
fs.writeFileSync(root, c)
console.log('FIX4 DONE')
