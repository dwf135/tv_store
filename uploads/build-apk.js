#!/usr/bin/env node
/**
 * TV 应用商店 APK 构建脚本
 * 用法: node build-apk.js [--debug|--release] [--server=http://IP:PORT]
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const isRelease = args.includes('--release');
const serverArg = args.find(a => a.startsWith('--server='));
const apiServer = serverArg ? serverArg.split('=')[1] : 'http://192.168.31.100:3000';

console.log('');
console.log('╔══════════════════════════════════════╗');
console.log('║   TV 应用商店 - APK 构建工具        ║');
console.log('╚══════════════════════════════════════╝');
console.log('');
console.log(`🔧 API 服务器: ${apiServer}`);
console.log(`📦 构建类型:   ${isRelease ? 'Release (签名)' : 'Debug (测试)'}`);
console.log('');

// 1. 更新 www/index.html 中的 API 地址
console.log('📝 步骤 1/4: 配置 API 服务器地址...');
const htmlPath = path.join(__dirname, 'www', 'index.html');
let html = fs.readFileSync(htmlPath, 'utf-8');
html = html.replace(
  /const API_SERVER = 'http:\/\/[^']+';/,
  `const API_SERVER = '${apiServer}';`
);
fs.writeFileSync(htmlPath, html);
console.log('   ✓ API 地址已更新');

// 2. 同步 Web 资源到 Android
console.log('📱 步骤 2/4: 同步 Web 资源...');
execSync('npx cap sync android', { cwd: __dirname, stdio: 'inherit' });
console.log('   ✓ 同步完成');

// 3. 设置 Gradle 可执行权限
console.log('🔨 步骤 3/4: 准备构建环境...');
const gradlewPath = path.join(__dirname, 'android', 'gradlew');
if (process.platform === 'win32') {
  // Windows - use gradlew.bat
} else {
  try { fs.chmodSync(gradlewPath, 0o755); } catch(e) {}
}

// 4. 构建 APK
console.log('🏗️  步骤 4/4: 构建 APK...');
const gradleCmd = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
const task = isRelease ? 'assembleRelease' : 'assembleDebug';

try {
  execSync(`${gradleCmd} ${task}`, {
    cwd: path.join(__dirname, 'android'),
    stdio: 'inherit',
    env: { ...process.env }
  });

  const buildType = isRelease ? 'release' : 'debug';
  const apkPath = path.join(__dirname, 'android', 'app', 'build', 'outputs', 'apk', buildType, `app-${buildType}.apk`);
  
  console.log('');
  console.log('✅ 构建成功！');
  console.log(`📦 APK 文件: ${apkPath}`);
  console.log('');
  console.log('📋 安装方式:');
  console.log('   1. 通过 ADB: adb install ' + apkPath);
  console.log('   2. 复制到 U 盘插入电视安装');
  console.log('   3. 通过文件管理器网络传输');
  console.log('');
} catch (e) {
  console.error('');
  console.error('❌ 构建失败！请检查:');
  console.error('   1. 是否安装了 Android SDK (API 34+)');
  console.error('   2. 是否配置了 ANDROID_HOME 环境变量');
  console.error('   3. 是否安装了 Java JDK 17+');
  console.error('');
  console.error('💡 简易方案 — 用 Android Studio 打开 android/ 目录直接构建');
  process.exit(1);
}
