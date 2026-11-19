#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// 颜色输出辅助函数
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
};

function log(msg, color = colors.reset) {
  console.log(`${color}${msg}${colors.reset}`);
}

function run(cmd, cwd = ROOT_DIR) {
  log(`> ${cmd}`, colors.cyan);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

// 解析命令行参数
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    help: false,
    type: 'patch', // patch | minor | major
    targetVersion: null,
    noBump: false,
    skipBuild: false,
    summary: '',
  };

  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--no-bump') {
      options.noBump = true;
    } else if (arg === '--skip-build') {
      options.skipBuild = true;
    } else if (arg === '--type' && args[i + 1]) {
      options.type = args[++i];
    } else if (arg.startsWith('--type=')) {
      options.type = arg.split('=')[1];
    } else if ((arg === '--version' || arg === '-v') && args[i + 1]) {
      options.targetVersion = args[++i];
    } else if (arg.startsWith('--version=')) {
      options.targetVersion = arg.split('=')[1];
    } else if ((arg === '--message' || arg === '-m' || arg === '--summary') && args[i + 1]) {
      options.summary = args[++i];
    } else if (arg.startsWith('--message=') || arg.startsWith('-m=') || arg.startsWith('--summary=')) {
      options.summary = arg.split('=')[1];
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  if (!options.summary && positional.length > 0) {
    options.summary = positional.join(' ');
  }

  return options;
}

// 打印帮助信息
function printHelp() {
  console.log(`
${colors.bold}点波 TapWave 自动打包与版本发布工具${colors.reset}

用法:
  npm run package [options] [-- "迭代概要"]
  node scripts/package.mjs [options] ["迭代概要"]

选项:
  -m, --message, --summary <文本>   指定本次迭代概要内容
  --type <patch|minor|major>        版本升级级别 (默认: patch，如 2.1.0 -> 2.1.1)
  -v, --version <x.y.z>            直接指定发布的版本号
  --no-bump                        不升级版本号，使用当前版本重新构建打包
  --skip-build                     跳过 Rust 编译直接基于现有 app 打包并覆盖
  -h, --help                       显示此帮助信息

示例:
  npm run package -- "优化多轨同步算法，提升启动速度"
  npm run package -- --type minor "新增 AI 语义高光切片功能"
  node scripts/package.mjs --no-bump "重新打包 DMG"
`);
}

// 计算下一个版本号
function bumpVersion(currentVersion, type) {
  const parts = currentVersion.split('.').map((n) => parseInt(n, 10));
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`当前版本号格式不规范: ${currentVersion}`);
  }
  let [major, minor, patch] = parts;
  if (type === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (type === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

// 同步版本号到 package.json, tauri.conf.json, Cargo.toml
function syncVersions(newVersion) {
  // 1. package.json
  const pkgPath = path.join(ROOT_DIR, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = newVersion;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  log(`✔ 已更新 package.json 版本号: ${newVersion}`, colors.green);

  // 2. src-tauri/tauri.conf.json
  const tauriConfPath = path.join(ROOT_DIR, 'src-tauri', 'tauri.conf.json');
  const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
  tauriConf.version = newVersion;
  fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n', 'utf8');
  log(`✔ 已更新 src-tauri/tauri.conf.json 版本号: ${newVersion}`, colors.green);

  // 3. src-tauri/Cargo.toml
  const cargoPath = path.join(ROOT_DIR, 'src-tauri', 'Cargo.toml');
  let cargoContent = fs.readFileSync(cargoPath, 'utf8');
  cargoContent = cargoContent.replace(
    /(\[package\][\s\S]*?version\s*=\s*)"[^"]+"/,
    `$1"${newVersion}"`
  );
  fs.writeFileSync(cargoPath, cargoContent, 'utf8');
  log(`✔ 已更新 src-tauri/Cargo.toml 版本号: ${newVersion}`, colors.green);
}

// 获取本地日期 YYYY-MM-DD
function getLocalDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// 检查 README.md 中指定日期是否已产生过版本记录（每天至多产生一个版本号）
function hasReleaseForDate(dateStr) {
  const readmePath = path.join(ROOT_DIR, 'README.md');
  if (!fs.existsSync(readmePath)) return false;
  const content = fs.readFileSync(readmePath, 'utf8');
  const dateRegex = new RegExp(`^### \\[[^\\]]+\\] - ${dateStr}\\b`, 'm');
  return dateRegex.test(content);
}

// 更新 README.md 中的版本号和迭代记录（同版本号合并并去重）
function updateReadme(newVersion, summaryText) {
  const readmePath = path.join(ROOT_DIR, 'README.md');
  let content = fs.readFileSync(readmePath, 'utf8');

  // 1. 更新顶部主标题中的版本号
  content = content.replace(
    /# PodCraft Studio Pro \(v[0-9.]+\)/,
    `# PodCraft Studio Pro (v${newVersion})`
  );

  // 2. 格式化概要条目并去重
  const today = getLocalDateString();
  const newLines = Array.from(
    new Set(
      summaryText
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => (l.startsWith('-') ? l : `- ${l}`))
    )
  );

  const escapedVersion = newVersion.replace(/\./g, '\\.');
  const existingVersionRegex = new RegExp(
    `(### \\[v${escapedVersion}\\] - )\\d{4}-\\d{2}-\\d{2}\\n([\\s\\S]*?)(?=\\n### \\[|$)`
  );

  const headerRegex = /## 版本迭代记录 \(Release Notes\)/;
  if (existingVersionRegex.test(content)) {
    // 合并到已存在的同版本号记录中，更新日期并去重条目
    content = content.replace(existingVersionRegex, (_match, prefix, existingBody) => {
      const existingLines = existingBody
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const mergedLines = [...newLines, ...existingLines].filter(
        (line, idx, arr) => arr.indexOf(line) === idx
      );
      return `${prefix}${today}\n${mergedLines.join('\n')}\n`;
    });
  } else if (headerRegex.test(content)) {
    // 插入到已有标题正下方
    const newReleaseEntry = `### [v${newVersion}] - ${today}\n${newLines.join('\n')}\n`;
    content = content.replace(
      /## 版本迭代记录 \(Release Notes\)\n+/,
      `## 版本迭代记录 (Release Notes)\n\n${newReleaseEntry}\n`
    );
  } else {
    // 在最后添加迭代记录区块
    const newReleaseEntry = `### [v${newVersion}] - ${today}\n${newLines.join('\n')}\n`;
    content = content.trimEnd() + `\n\n## 版本迭代记录 (Release Notes)\n\n${newReleaseEntry}\n`;
  }

  fs.writeFileSync(readmePath, content, 'utf8');
  log(`✔ 已更新 README.md 标题与版本迭代记录 [v${newVersion}]`, colors.green);
}

// 询问用户输入概要
async function promptForSummary() {
  if (!process.stdin.isTTY) {
    return '常规打包发布与性能优化';
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(
      `${colors.yellow}请输入本次迭代概要 (直接回车使用默认说明): ${colors.reset}`,
      (answer) => {
        rl.close();
        resolve(answer.trim() || '常规打包发布与性能优化');
      }
    );
  });
}

async function main() {
  const options = parseArgs();

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  log(`\n======================================================`, colors.bold);
  log(`   点波 TapWave — 自动化打包与版本发布引擎`, colors.bold);
  log(`======================================================\n`, colors.bold);

  // 1. 读取当前版本号（每天至多产生一个版本号）
  const pkgPath = path.join(ROOT_DIR, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const currentVersion = pkg.version || '2.1.0';
  const today = getLocalDateString();
  let targetVersion = currentVersion;

  if (options.noBump) {
    log(`[1/6] 保持当前版本不变: v${currentVersion}`, colors.blue);
  } else if (options.targetVersion) {
    targetVersion = options.targetVersion;
    log(`[1/6] 指定新版本: v${currentVersion} -> v${targetVersion}`, colors.blue);
  } else if (hasReleaseForDate(today)) {
    log(`[1/6] 今日 (${today}) 已产生过版本号，沿用当前版本: v${currentVersion}`, colors.blue);
  } else {
    targetVersion = bumpVersion(currentVersion, options.type);
    log(`[1/6] 自动升级版本 (${options.type}): v${currentVersion} -> v${targetVersion}`, colors.blue);
  }

  // 2. 确定迭代概要
  let summary = options.summary;
  if (!summary) {
    summary = await promptForSummary();
  }
  log(`[2/6] 本次迭代概要:\n  ${summary.replace(/\n/g, '\n  ')}`, colors.blue);

  // 3. 同步版本号和更新 README.md
  log(`[3/6] 同步版本号并更新 README.md ...`, colors.blue);
  syncVersions(targetVersion);
  updateReadme(targetVersion, summary);

  // 4. 构建前端与 Tauri 桌面端
  if (!options.skipBuild) {
    log(`[4/6] 执行构建 (Vite + Tauri) ...`, colors.blue);
    run('npm run build', ROOT_DIR);
    run('npx tauri build --bundles app', ROOT_DIR);
  } else {
    log(`[4/6] 跳过编译阶段 (使用现有产物)`, colors.yellow);
  }

  // 5. 补充资源、签名与清除隔离标志
  log(`[5/6] 完善 App Bundle 资源、深度签名与清除隔离 ...`, colors.blue);
  const appBundle = path.join(ROOT_DIR, 'src-tauri/target/release/bundle/macos/点波 TapWave.app');
  if (!fs.existsSync(appBundle)) {
    throw new Error(`找不到构建产物: ${appBundle}`);
  }

  // 复制 sidecar
  const sidecarDir = path.join(ROOT_DIR, 'sidecar');
  const bundleSidecar = path.join(appBundle, 'Contents/Resources/sidecar');
  fs.mkdirSync(bundleSidecar, { recursive: true });
  run(`cp -R "${sidecarDir}/." "${bundleSidecar}/"`);

  // 深度代码签名
  run(`codesign --force --deep --sign - "${appBundle}"`);
  run(`xattr -cr "${appBundle}"`);

  // 6. 生成 DMG 和 ZIP，覆盖到 application 文件夹及 /Applications
  log(`[6/6] 生成 DMG/ZIP 安装包并覆盖 application 文件夹 ...`, colors.blue);
  const appDir = path.join(ROOT_DIR, 'application');
  fs.mkdirSync(appDir, { recursive: true });

  // 覆盖复制到系统的 /Applications/点波 TapWave.app
  try {
    const sysAppPath = '/Applications/点波 TapWave.app';
    run(`rm -rf "${sysAppPath}"`);
    run(`cp -R "${appBundle}" "/Applications/"`);
    run(`codesign --force --deep --sign - "${sysAppPath}"`);
    run(`xattr -cr "${sysAppPath}"`);
    log(`✔ 已同步覆盖到系统 /Applications/点波 TapWave.app`, colors.green);

    // 注册 .podcraft 文件关联到 macOS LaunchServices
    const lsreg = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
    if (fs.existsSync(lsreg)) {
      run(`"${lsreg}" -f -R -trusted "${sysAppPath}"`);
      log(`✔ 已向 macOS LaunchServices 注册 .podcraft 文件类型关联`, colors.green);
    }
  } catch (err) {
    log(`⚠ 复制到系统 /Applications 遇到权限或非致命限制，跳过`, colors.yellow);
  }

  // 覆盖复制到项目里的 application/点波 TapWave.app
  const destApp = path.join(appDir, '点波 TapWave.app');
  run(`rm -rf "${destApp}"`);
  run(`cp -R "${appBundle}" "${appDir}/"`);
  run(`codesign --force --deep --sign - "${destApp}"`);
  run(`xattr -cr "${destApp}"`);
  log(`✔ 已覆盖 application/点波 TapWave.app`, colors.green);

  // 制作 DMG
  const dmgStaging = path.join(ROOT_DIR, 'dist_dmg_staging');
  run(`rm -rf "${dmgStaging}"`);
  fs.mkdirSync(dmgStaging, { recursive: true });

  // 复制 app 到 staging
  run(`cp -R "${appBundle}" "${dmgStaging}/"`);
  run(`ln -s /Applications "${dmgStaging}/Applications"`);

  // 首次打开修复脚本
  const fixScriptPath = path.join(dmgStaging, '首次打开提示已损坏-点我一键修复.command');
  const fixScriptContent = `#!/bin/bash
clear
echo "=========================================================="
echo "  点波 TapWave — macOS 首次打开安全授权修复脚本"
echo "=========================================================="
echo ""
echo "由于 macOS Gatekeeper 安全机制对未签名独立软件的保护限制，"
echo "首次打开未通过 App Store 认证的应用可能会提示【已损坏，无法打开】。"
echo ""
echo "正在自动清除隔离拦截标志并配置授权..."
xattr -cr "/Applications/点波 TapWave.app" 2>/dev/null || true
xattr -rd com.apple.quarantine "/Applications/点波 TapWave.app" 2>/dev/null || true
codesign --force --deep --sign - "/Applications/点波 TapWave.app" 2>/dev/null || true
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f -R -trusted "/Applications/点波 TapWave.app" 2>/dev/null || true
echo ""
echo "=========================================================="
echo "✅ 修复完成！"
echo "您现在可以直接从【访达 -> 应用程序】或启动台打开「点波 TapWave」了。"
echo "=========================================================="
echo ""
read -p "按回车键退出..."
`;
  fs.writeFileSync(fixScriptPath, fixScriptContent, { mode: 0o755 });

  // 安装说明
  const readmeTxtPath = path.join(dmgStaging, '安装与使用说明.txt');
  const readmeTxtContent = `【点波 TapWave 安装与使用指引 (v${targetVersion})】

1. 安装方式：
   将「点波 TapWave」图标拖拽至右侧的「Applications」文件夹即可完成安装。

2. 若打开时提示「已损坏，无法打开。你应该将它移到废纸篓」：
   这是 macOS 系统的安全机制拦截（Gatekeeper Quarantine）。
   您可以选择以下任意一种方式解除拦截：
   
   【方法一：一键自动修复（最简便）】
   直接双击本镜像内的「首次打开提示已损坏-点我一键修复.command」，
   终端将自动清除拦截属性，完成后即可正常打开！

   【方法二：系统设置授权】
   打开 Mac【系统设置】 -> 【隐私与安全性】，向下滑动到【安全性】栏目，
   点击提示中的【仍要打开】按钮。

3. 依赖项与模型下载：
   软件支持「云端大模型转写（火山引擎豆包多角色分离/DeepSeek）」与「本地 SenseVoice 离线转写」。
   首次使用时软件将弹出引导，可一键选用免下载的云端模式，或一键自动下载本地离线模型包。
`;
  fs.writeFileSync(readmeTxtPath, readmeTxtContent, 'utf8');

  // 清除 application 目录下的旧 DMG 和 ZIP
  const oldFiles = fs.readdirSync(appDir);
  for (const f of oldFiles) {
    if ((f.endsWith('.dmg') || f.endsWith('.zip')) && !f.includes(targetVersion)) {
      fs.unlinkSync(path.join(appDir, f));
      log(`  清理历史安装包文件: ${f}`, colors.reset);
    }
  }

  // 生成 DMG 文件
  const dmgName = `点波 TapWave_${targetVersion}_aarch64.dmg`;
  const dmgPath = path.join(appDir, dmgName);
  run(`rm -f "${dmgPath}"`);
  run(`hdiutil create -volname "点波 TapWave" -srcfolder "${dmgStaging}" -ov -format UDZO "${dmgPath}"`);
  run(`codesign --force --sign - "${dmgPath}"`);
  run(`xattr -cr "${dmgPath}"`);
  run(`rm -rf "${dmgStaging}"`);
  log(`✔ 已生成全新 DMG 安装包: application/${dmgName}`, colors.green);

  // 生成 ZIP 便携安装包
  const zipName = `点波 TapWave_${targetVersion}_macOS.zip`;
  const zipPath = path.join(appDir, zipName);
  run(`rm -f "${zipPath}"`);
  run(`cd "${appDir}" && ditto -c -k --keepParent "点波 TapWave.app" "${zipName}"`);
  log(`✔ 已生成 ZIP 便携包: application/${zipName}`, colors.green);

  log(`\n======================================================`, colors.bold);
  log(`🎉 发布与打包全部完成！(版本: v${targetVersion})`, colors.green + colors.bold);
  log(`======================================================`, colors.bold);
  log(`产物清单 (application/):`);
  run(`ls -lh "${appDir}"`);
}

main().catch((err) => {
  console.error(`\n❌ 打包发布失败:`, err);
  process.exit(1);
});
