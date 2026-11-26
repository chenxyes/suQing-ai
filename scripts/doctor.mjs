#!/usr/bin/env node
/**
 * npm run doctor — 自托管环境一键诊断工具
 *
 * 检查项：
 *  Node 版本 / npm 可用性 / better-sqlite3 可加载性 /
 *  .env 存在 / data/ 可写 / SQLite 可写 /
 *  CHAT_PROVIDER 配置 / 对应 API key 存在 /
 *  iLink 配置 / .weixin-credentials 存在 /
 *  API /health 可访问 / 端口占用情况 / 邮件模式
 *
 * 注意：本脚本不输出任何 API key / token 内容。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ─── Color helpers ─────────────────────────────────────────────────────────
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';

const ok   = msg => console.log(`${GREEN}✅${RESET} ${msg}`);
const warn = msg => console.log(`${YELLOW}⚠️ ${RESET} ${msg}`);
const fail = msg => console.log(`${RED}❌${RESET} ${msg}`);
const info = msg => console.log(`${DIM}   ${msg}${RESET}`);
const head = msg => console.log(`\n${BOLD}── ${msg} ──${RESET}`);

let issues = 0;
let warnings = 0;

// ─── Checks ────────────────────────────────────────────────────────────────

head('运行环境');

// Node version
const nvMatch = process.version.match(/^v(\d+)/);
const nodeMajor = nvMatch ? Number(nvMatch[1]) : 0;
if (nodeMajor >= 20) {
  ok(`Node.js ${process.version} (>= 20)`);
} else {
  fail(`Node.js ${process.version} — 需要 >= v20`);
  issues++;
}

// npm
try {
  const npmVer = execSync('npm --version', { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim();
  ok(`npm ${npmVer}`);
} catch {
  fail('npm 不可用 — 请检查 npm 安装');
  issues++;
}

// better-sqlite3
head('依赖');
try {
  const req = createRequire(path.join(ROOT, 'package.json'));
  req('better-sqlite3');
  ok('better-sqlite3 可加载');
} catch (e) {
  fail(`better-sqlite3 加载失败: ${e.message}`);
  info('运行: npm install');
  issues++;
}

// ─── .env ─────────────────────────────────────────────────────────────────
head('配置文件');
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  ok('.env 文件存在');
} else {
  warn('.env 文件不存在 — 请从 .env.example 复制并填写');
  warnings++;
}

// Load env (without printing values)
let env = {};
if (fs.existsSync(envPath)) {
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && !m[0].startsWith('#')) env[m[1]] = m[2].trim();
    }
  } catch {}
}
// Also read from process.env (Docker / CI)
for (const [k, v] of Object.entries(process.env)) {
  if (!env[k]) env[k] = v;
}

// .weixin-credentials
const wxCreds = path.join(ROOT, '.weixin-credentials.json');
if (fs.existsSync(wxCreds)) {
  ok('.weixin-credentials.json 存在（WeChat 已登录）');
} else {
  warn('.weixin-credentials.json 不存在 — 请运行 npm run ilink:login 绑定微信');
  warnings++;
}

// ─── data/ 目录 ─────────────────────────────────────────────────────────────
head('数据目录');
const dataDir = path.join(ROOT, 'data');
try {
  fs.mkdirSync(dataDir, { recursive: true });
  const testFile = path.join(dataDir, '.doctor_write_test');
  fs.writeFileSync(testFile, 'ok');
  fs.unlinkSync(testFile);
  ok('data/ 目录可写');
} catch (e) {
  fail(`data/ 目录不可写: ${e.message}`);
  issues++;
}

// SQLite write test
const dbPath = env.DB_PATH || path.join(dataDir, 'bot.db');
try {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS _doctor_test (x INTEGER)');
  db.exec('DROP TABLE IF EXISTS _doctor_test');
  db.close();
  ok(`SQLite 可写 (${path.relative(ROOT, dbPath)})`);
} catch (e) {
  fail(`SQLite 不可写: ${e.message}`);
  issues++;
}

// port 需要在 Setup 向导 URL 中使用，提前定义
const port = Number(env.API_PORT || 3000);

// ─── Setup 向导 ──────────────────────────────────────────────────────────────
head('Setup 向导');

// AUTH_MODE
const authMode = env.AUTH_MODE || 'local';
ok(`Auth 模式: ${authMode}`);

// setup.html 存在
const setupHtmlPath = path.join(ROOT, 'public', 'app', 'setup.html');
if (fs.existsSync(setupHtmlPath)) {
  ok('setup.html 存在 (/app/setup.html)');
} else {
  fail('setup.html 缺失');
  issues++;
}

// 读取 app_settings（如果 DB 存在）
const dbSettings = {};
let dbProviderKey  = '';
try {
  const { default: Database } = await import('better-sqlite3');
  const db2 = new Database(dbPath);
  const rows = db2.prepare('SELECT key, value, secret FROM app_settings').all();
  for (const r of rows) {
    if (r?.key && r.value !== null && r.value !== undefined && r.value !== '') {
      dbSettings[r.key] = { value: String(r.value), secret: Number(r.secret || 0) };
    }
  }
  const dbProviderName = dbSettings.CHAT_PROVIDER?.value || '';
  if (dbProviderName) {
    const KEY_MAP_DB = {
      deepseek: 'DEEPSEEK_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY',
      xai: 'XAI_API_KEY', zhipu: 'ZHIPU_API_KEY', doubao: 'DOUBAO_API_KEY',
      qwen: 'QWEN_API_KEY', kimi: 'KIMI_API_KEY', wenxin: 'WENXIN_API_KEY',
      minimax: 'MINIMAX_API_KEY', stepfun: 'STEPFUN_API_KEY',
      'openai-compatible': 'OPENAI_COMPATIBLE_API_KEY', ollama: 'OLLAMA_API_KEY',
    };
    const keyName = KEY_MAP_DB[dbProviderName.toLowerCase()];
    if (keyName && dbSettings[keyName]?.value) {
      dbProviderKey = keyName;
    }
  }
  db2.close();
} catch {}

function effectiveSetting(key) {
  const dbVal = dbSettings[key]?.value || '';
  const envVal = env[key] || '';
  if (dbVal) return { value: dbVal, source: 'app_settings', shadowed: Boolean(envVal && envVal !== dbVal), envVal };
  if (envVal) return { value: envVal, source: 'env', shadowed: false, envVal };
  return { value: '', source: 'default', shadowed: false, envVal: '' };
}

const setupWizardUrl = `http://localhost:${port}/app/setup.html`;
info(`Setup 向导 URL: ${setupWizardUrl}`);

// ─── Chat provider ─────────────────────────────────────────────────────────
head('AI 提供商');

const KEY_MAP = {
  openai:   'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  claude:   'ANTHROPIC_API_KEY',
  anthropic:'ANTHROPIC_API_KEY',
  zhipu:    'ZHIPU_API_KEY',
  qwen:     'QWEN_API_KEY',
  doubao:   'DOUBAO_API_KEY',
  kimi:     'KIMI_API_KEY',
  wenxin:   'WENXIN_API_KEY',
  xai:      'XAI_API_KEY',
  gemini:   'GEMINI_API_KEY',
  minimax:  'MINIMAX_API_KEY',
  stepfun:  'STEPFUN_API_KEY',
  'openai-compatible': 'OPENAI_COMPATIBLE_API_KEY',
  ollama:   'OLLAMA_API_KEY',
};

// 与 src/providers/chat.mjs 保持一致：app_settings 优先于 env
const chatProvEff = effectiveSetting('CHAT_PROVIDER');
const chatModelEff = effectiveSetting('CHAT_MODEL');
const provider = chatProvEff.value || '';
const providerSource = chatProvEff.source;

if (!provider) {
  warn(`CHAT_PROVIDER 未配置（将回退默认 deepseek）— 请在 .env 或 ${setupWizardUrl} 配置`);
  warnings++;
} else {
  ok(`CHAT_PROVIDER = ${provider}  (实际生效来源: ${providerSource})`);
  if (chatProvEff.shadowed) {
    warn(`app_settings.CHAT_PROVIDER="${chatProvEff.value}" 覆盖了 .env 中的 "${chatProvEff.envVal}"`);
    warnings++;
  }
  if (chatModelEff.value) {
    ok(`CHAT_MODEL = ${chatModelEff.value}  (实际生效来源: ${chatModelEff.source})`);
    if (chatModelEff.shadowed) {
      warn(`app_settings.CHAT_MODEL="${chatModelEff.value}" 覆盖了 .env 中的 "${chatModelEff.envVal}" — 排查模型时请以设置页为准`);
      warnings++;
    }
  }

  const keyName = KEY_MAP[provider.toLowerCase()];
  if (keyName) {
    const dbVal  = dbSettings[keyName]?.value || dbProviderKey === keyName ? '(已配置)' : '';
    const envVal = env[keyName] || '';
    if (dbSettings[keyName]?.value) {
      ok(`${keyName} 已配置 (来源: app_settings，内容已隐藏)`);
    } else if (envVal && envVal.length >= 8 && !envVal.startsWith('your_')) {
      ok(`${keyName} 已配置 (${envVal.length} 字符，来源: env，内容已隐藏)`);
    } else if (dbVal) {
      ok(`${keyName} 已配置 (来源: app_settings，内容已隐藏)`);
    } else {
      warn(`${keyName} 未配置 — 请在 ${setupWizardUrl} 填写 API Key`);
      warnings++;
    }
  } else {
    info(`未知 provider "${provider}"，跳过 key 检查`);
  }
}

// ─── 活人感配置总览（Phase 1）────────────────────────────────────────────────
head('活人感配置（Phase 1）');
const auxProvEff = effectiveSetting('CHAT_AUX_PROVIDER');
const auxModelEff = effectiveSetting('CHAT_AUX_MODEL');
if (auxProvEff.value || auxModelEff.value) {
  ok(`辅助模型 (aux): ${auxProvEff.value || provider || 'deepseek'} / ${auxModelEff.value || '(默认)'}`);
} else {
  info('辅助模型 (aux): 未单独指定，默认复用主模型（若主模型切推理模型，建议设 CHAT_AUX_MODEL=deepseek-chat）');
}
const reasoningCapEff = effectiveSetting('CHAT_REASONING_CAPTURE');
info(`后台思考流调试捕获 (CHAT_REASONING_CAPTURE): ${reasoningCapEff.value || 'false'}`);
info(`Inner OS 模式 (INNER_OS_MODE): ${env.INNER_OS_MODE || 'always'}`);
const visionProvEff = effectiveSetting('VISION_PROVIDER');
const visionModelEff = effectiveSetting('VISION_MODEL');
info(`视神经 (VISION): ${visionProvEff.value || 'zhipu'}${visionModelEff.value ? ` / ${visionModelEff.value}` : ''} (来源: ${visionProvEff.source})`);
const embedProvEff = effectiveSetting('EMBEDDING_PROVIDER');
info(`向量记忆 (EMBEDDING): ${embedProvEff.value || 'gemini'} (来源: ${embedProvEff.source})`);
const searchProvEff = effectiveSetting('SEARCH_PROVIDER');
info(`联网搜索 (SEARCH): ${searchProvEff.value || '(未配置)'}`);

// ─── iLink / WeChat ─────────────────────────────────────────────────────────
head('iLink / 微信');
const botToken = env.ILINK_BOT_TOKEN || '';
const botId    = env.ILINK_BOT_ID    || '';
if (!botToken || botToken.length < 8 || botToken.startsWith('your_')) {
  warn('ILINK_BOT_TOKEN 未配置 — 微信功能不可用');
  warnings++;
} else {
  ok(`ILINK_BOT_TOKEN 已配置 (已隐藏)`);
}
if (!botId || botId.startsWith('your_')) {
  warn('ILINK_BOT_ID 未配置');
  warnings++;
} else {
  ok(`ILINK_BOT_ID = ${botId}`);
}

// ─── Port & API health ───────────────────────────────────────────────────────
head('服务状态');
let serviceRunning = false;

try {
  // Quick TCP check
  const check = spawnSync('sh', ['-c', `curl -sf --max-time 2 http://localhost:${port}/api/health`], {
    encoding: 'utf8',
    timeout: 4000,
  });
  if (check.status === 0 && check.stdout) {
    try {
      const h = JSON.parse(check.stdout);
      if (h.ok) {
        ok(`/api/health 响应正常 (端口 ${port})`);
        if (h.data?.provider) info(`  provider: ${h.data.provider}`);
        if (h.data?.wechat_configured !== undefined) info(`  wechat_configured: ${h.data.wechat_configured}`);
        if (h.data?.email_mode) info(`  email_mode: ${h.data.email_mode}`);
        serviceRunning = true;
      } else {
        warn(`/api/health 返回非 ok`);
        warnings++;
      }
    } catch {
      warn(`/api/health 响应无法解析`);
      warnings++;
    }
  } else {
    info(`服务未运行于端口 ${port}（或 curl 不可用）`);
  }
} catch {
  info(`无法检测端口 ${port} 服务状态`);
}

// Port conflict
try {
  const lsof = spawnSync('sh', ['-c', `lsof -ti :${port} 2>/dev/null | head -1`], { encoding: 'utf8', timeout: 2000 });
  const pid  = lsof.stdout?.trim();
  if (pid && !serviceRunning) {
    warn(`端口 ${port} 已被 PID ${pid} 占用（且非溪语服务）`);
    warnings++;
  }
} catch {}

// ─── AUTH_SECRET ────────────────────────────────────────────────────────────
head('安全');
const authSecret = env.AUTH_SECRET || '';
if (!authSecret || authSecret.length < 8) {
  const authFile = path.join(ROOT, '.auth-secret');
  if (fs.existsSync(authFile)) {
    warn('AUTH_SECRET 未在 .env 显式设置 — 使用自动生成（.auth-secret），重启时 token 不失效');
    warnings++;
  } else {
    warn('AUTH_SECRET 未配置，且 .auth-secret 不存在 — 首次启动会自动创建，但重启失效');
    warnings++;
  }
} else {
  ok('AUTH_SECRET 已配置');
}

// ─── Email / Resend ──────────────────────────────────────────────────────────
head('邮件');
const emailMode = env.EMAIL_MODE || '';
const resendKey = env.RESEND_API_KEY || '';
const resendFrom = env.RESEND_FROM || '';
if (emailMode === 'dev_stdout' || env.EMAIL_DEV_MODE === '1') {
  ok('邮件模式: dev_stdout（仅打印，不发送）');
} else if (resendKey && resendKey.length > 8 && !resendKey.startsWith('re_xxx')) {
  if (resendFrom) {
    ok('邮件模式: Resend 真实发送');
    info(`  RESEND_FROM: ${resendFrom}`);
  } else {
    warn('RESEND_API_KEY 已配置，但 RESEND_FROM 未设置');
    warnings++;
  }
} else {
  ok('邮件模式: dev_stdout（未配置 Resend）');
}

// ─── Docker hint ─────────────────────────────────────────────────────────────
if (fs.existsSync('/.dockerenv') || process.env.container === 'docker') {
  head('Docker');
  ok('检测到 Docker 环境');
  info('  确保 data/ 目录已挂载为 volume 以持久化数据');
}

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(50));
if (issues === 0 && warnings === 0) {
  console.log(`${GREEN}${BOLD}✅ 全部检查通过，环境配置正常${RESET}`);
} else {
  if (issues > 0)   console.log(`${RED}${BOLD}❌ ${issues} 个严重问题需修复${RESET}`);
  if (warnings > 0) console.log(`${YELLOW}⚠️  ${warnings} 个警告（不影响启动，建议处理）${RESET}`);
}
console.log('─'.repeat(50) + '\n');

process.exit(issues > 0 ? 1 : 0);
