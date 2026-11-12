/**
 * 一键构建 → 安装 → 权限自检 → 抓日志（E1）
 *
 * 用法：
 *   node scripts/dev-install.cjs                  全流程，装完抓 30 秒日志
 *   node scripts/dev-install.cjs --skip-build     dist 已是最新，跳过 vue-tsc + vite build
 *   node scripts/dev-install.cjs --no-log         只装不抓日志
 *   node scripts/dev-install.cjs --grant          顺带授予通知 / 所有文件访问 / 精确闹钟
 *   node scripts/dev-install.cjs --serial <id>    多设备时指定（adb devices 里的序列号）
 *   node scripts/dev-install.cjs --seconds 60     日志抓取时长
 *
 * 日志落在 .tmp/dev-install/<时间戳>/logcat.txt（.tmp/ 已 gitignore：日志可能含 cookie / token）。
 * 权限默认只读检查，加 --grant 才会改设备状态。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ANDROID = path.join(ROOT, 'android');
const APP_ID = 'com.qoder.cinema';
const ACTIVITY = `${APP_ID}/.MainActivity`;
const APK = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const IS_WIN = process.platform === 'win32';
/** MuMu 默认 adb 端口；没插真机时试一把，省掉手动 adb connect */
const EMULATOR_PORTS = [7555, 16384];

function parseArgs(argv) {
  const opts = { skipBuild: false, log: true, grant: false, serial: null, seconds: 30 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--skip-build') opts.skipBuild = true;
    else if (arg === '--no-log') opts.log = false;
    else if (arg === '--grant') opts.grant = true;
    else if (arg === '--serial') opts.serial = argv[++i];
    else if (arg === '--seconds') opts.seconds = Number(argv[++i]);
    else throw new Error(`未知参数：${arg}`);
  }
  if (!Number.isFinite(opts.seconds) || opts.seconds <= 0) throw new Error('--seconds 需要正数');
  return opts;
}

let stepIndex = 0;
function step(title) {
  stepIndex += 1;
  console.log(`\n[${stepIndex}] ${title}`);
}

/** 构建类命令走 shell（win32 下 npm/npx/gradlew 都是 .cmd/.bat），输出直接透传 */
function run(cmd, args, cwd = ROOT) {
  const started = Date.now();
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: IS_WIN });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 失败（退出码 ${result.status}）`);
  console.log(`    耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

/** adb 是真实可执行文件，不过 shell，避免路径里的空格被二次拆分 */
function adb(args, { allowFail = false } = {}) {
  const result = spawnSync('adb', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw new Error(`找不到 adb，请把 platform-tools 加进 PATH：${result.error.message}`);
  if (result.status !== 0 && !allowFail) {
    throw new Error(`adb ${args.join(' ')} 失败：${(result.stderr || result.stdout || '').trim()}`);
  }
  return (result.stdout || '').trim();
}

function listDevices() {
  return adb(['devices'])
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[1] === 'device')
    .map((parts) => parts[0]);
}

function ensureDevice(opts) {
  let devices = listDevices();
  if (devices.length === 0) {
    for (const port of EMULATOR_PORTS) {
      adb(['connect', `127.0.0.1:${port}`], { allowFail: true });
    }
    devices = listDevices();
  }
  if (devices.length === 0) {
    throw new Error('没有已连接的设备：先启动模拟器或插上真机（adb devices 应能看到 device）');
  }
  if (!opts.serial && devices.length > 1) {
    throw new Error(`检测到多台设备 ${devices.join(', ')}，请用 --serial 指定`);
  }
  const serial = opts.serial || devices[0];
  if (!devices.includes(serial)) throw new Error(`设备 ${serial} 不在已连接列表：${devices.join(', ')}`);
  return ['-s', serial];
}

/** appops 未显式设置时输出 "No operations." + "Default mode: xxx"，两行都要认 */
function readAppop(serialArgs, op) {
  const out = adb([...serialArgs, 'shell', 'appops', 'get', APP_ID, op], { allowFail: true });
  const explicit = new RegExp(`${op}:\\s*(\\w+)`).exec(out);
  if (explicit) return explicit[1];
  const fallback = /Default mode:\s*(\w+)/.exec(out);
  return fallback ? fallback[1] : 'unknown';
}

function sdkLevel(serialArgs) {
  return Number(adb([...serialArgs, 'shell', 'getprop', 'ro.build.version.sdk'], { allowFail: true })) || 0;
}

function readNotificationPermission(serialArgs, sdk) {
  // POST_NOTIFICATIONS 是 API 33 才有的运行时权限，Android 12 上 dumpsys 恒为 granted=false
  if (sdk > 0 && sdk < 33) return 'allow';
  const dump = adb([...serialArgs, 'shell', 'dumpsys', 'package', APP_ID], { allowFail: true });
  const line = dump.split('\n').find((l) => l.includes('android.permission.POST_NOTIFICATIONS'));
  if (!line) return '未声明';
  return /granted=true/.test(line) ? 'allow' : 'deny';
}

function checkPermissions(serialArgs, grant) {
  const sdk = sdkLevel(serialArgs);
  if (grant) {
    // 这三项是 B1 媒体通知 / B3 精确闹钟 / 网盘 cookie 公共目录读写的前置条件
    adb([...serialArgs, 'shell', 'appops', 'set', APP_ID, 'MANAGE_EXTERNAL_STORAGE', 'allow'], { allowFail: true });
    adb([...serialArgs, 'shell', 'appops', 'set', APP_ID, 'SCHEDULE_EXACT_ALARM', 'allow'], { allowFail: true });
    if (sdk >= 33) {
      adb([...serialArgs, 'shell', 'pm', 'grant', APP_ID, 'android.permission.POST_NOTIFICATIONS'], { allowFail: true });
    }
  }
  const rows = [
    ['所有文件访问（网盘 cookie）', readAppop(serialArgs, 'MANAGE_EXTERNAL_STORAGE')],
    ['精确闹钟（睡眠定时）', readAppop(serialArgs, 'SCHEDULE_EXACT_ALARM')],
    ['通知（媒体通知 / 定时提醒）', readNotificationPermission(serialArgs, sdk)],
  ];
  console.log(`    设备 Android API ${sdk}`);
  for (const [label, state] of rows) {
    // default 表示交给系统默认策略，不等于被拒；只有明确 deny/ignore 才需要用户去开
    const mark = state === 'allow' ? 'OK  ' : state === 'default' ? '系统默认' : '待授予';
    console.log(`    ${mark} ${label}：${state}`);
  }
  const blocked = rows.filter(([, state]) => state !== 'allow' && state !== 'default');
  if (blocked.length > 0 && !grant) {
    console.log('    提示：加 --grant 可一次授予，或在系统设置里手动开');
  }
}

function appPid(serialArgs) {
  return adb([...serialArgs, 'shell', 'pidof', APP_ID], { allowFail: true }).split(/\s+/)[0] || '';
}

/**
 * 全量 logcat 落盘，控制台只放行本应用进程与崩溃/错误行。
 * 不按 pid 过滤 adb 本身：启动瞬间崩溃时 pid 还没拿到，过滤会把崩溃栈丢掉。
 */
function captureLogs(serialArgs, seconds, outFile) {
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(outFile, { encoding: 'utf8' });
    const child = spawn('adb', [...serialArgs, 'logcat', '-v', 'time'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let pid = appPid(serialArgs);
    let pidPattern = pid ? new RegExp(`\\(\\s*${pid}\\)`) : null;
    let buffer = '';
    let errors = 0;
    let warnings = 0;
    let shown = 0;
    let done = false;
    const pidTimer = setInterval(() => {
      if (pid) return;
      pid = appPid(serialArgs);
      if (pid) pidPattern = new RegExp(`\\(\\s*${pid}\\)`);
    }, 1000);

    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(pidTimer);
      clearTimeout(deadline);
      process.removeListener('SIGINT', finish);
      child.kill();
      stream.end();
      console.log(`\n    本应用相关 ${shown} 行；全设备 E ${errors} / W ${warnings}`);
      console.log(`    全量日志：${outFile}`);
      resolve({ errors, warnings });
    };

    const deadline = setTimeout(finish, seconds * 1000);
    process.once('SIGINT', finish);

    child.on('error', (e) => {
      clearInterval(pidTimer);
      clearTimeout(deadline);
      stream.end();
      reject(e);
    });

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        stream.write(`${line}\n`);
        const level = /^\d\d-\d\d\s+\S+\s+([VDIWEF])\//.exec(line)?.[1];
        if (level === 'E' || level === 'F') errors += 1;
        else if (level === 'W') warnings += 1;
        const mine = pidPattern !== null && pidPattern.test(line);
        // AndroidRuntime 在 I/D 级只是 zygote 启动噪声，只有 E/F 才是崩溃栈
        const crash =
          /FATAL EXCEPTION|chromium.*ERROR/.test(line) ||
          ((level === 'E' || level === 'F') && /AndroidRuntime/.test(line));
        if (!mine && !crash) continue;
        if (level === 'E' || level === 'F' || level === 'W' || crash) {
          shown += 1;
          console.log(`    ${line}`);
        }
      }
    });
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const started = Date.now();
  console.log('PeanutMov 一键构建安装');

  step(opts.skipBuild ? '跳过前端构建（--skip-build）' : '前端构建（vue-tsc + vite build）');
  if (!opts.skipBuild) run(IS_WIN ? 'npm.cmd' : 'npm', ['run', 'build']);

  step('同步 Capacitor 资源');
  run(IS_WIN ? 'npx.cmd' : 'npx', ['cap', 'sync', 'android']);

  step('编译 Debug APK');
  run(IS_WIN ? 'gradlew.bat' : './gradlew', ['assembleDebug'], ANDROID);
  if (!fs.existsSync(APK)) throw new Error(`APK 不存在：${APK}`);
  console.log(`    ${APK}（${(fs.statSync(APK).size / 1024 / 1024).toFixed(1)} MB）`);

  step('连接设备');
  const serialArgs = ensureDevice(opts);
  console.log(`    ${serialArgs[1]}`);

  step('安装（adb install -r）');
  console.log(adb([...serialArgs, 'install', '-r', APK]));

  step(opts.grant ? '授予并复核权限' : '权限自检（只读）');
  checkPermissions(serialArgs, opts.grant);

  step('启动 App');
  adb([...serialArgs, 'logcat', '-c'], { allowFail: true });
  console.log(adb([...serialArgs, 'shell', 'am', 'start', '-n', ACTIVITY]));

  if (opts.log) {
    step(`抓日志 ${opts.seconds}s（Ctrl+C 可提前结束）`);
    const dir = path.join(ROOT, '.tmp', 'dev-install', new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    await captureLogs(serialArgs, opts.seconds, path.join(dir, 'logcat.txt'));
  }

  console.log(`\n完成，总耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log('接下来在 App 里手动点验收清单即可。');
}

main().catch((e) => {
  console.error(`\n失败：${e.message}`);
  process.exit(1);
});