#!/usr/bin/env node
// Bumps Android versionCode/versionName before a mobile build.
//   node scripts/bump-android-version.mjs <versionCode> [versionName]
//
// Without versionCode: increments the code in app-version.json by 1.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'frontend', 'package.json'), 'utf8'))
const manifestPath = join(root, 'frontend', 'android', 'app-version.json')
const gradlePath = join(root, 'frontend', 'android', 'app', 'build.gradle')

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const versionCode = process.argv[2] ? Number(process.argv[2]) : (manifest.versionCode || 0) + 1
const versionName = process.argv[3] || pkg.version

manifest.versionName = versionName
manifest.versionCode = versionCode
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

let gradle = readFileSync(gradlePath, 'utf8')
gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`)
gradle = gradle.replace(/versionName\s+"[^"]*"/, `versionName "${versionName}"`)
writeFileSync(gradlePath, gradle)

console.log(`Android version → ${versionName} (${versionCode})`)
