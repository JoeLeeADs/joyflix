#!/usr/bin/env node

/* eslint-disable no-console,@typescript-eslint/no-var-requires */
const http = require('http');
const path = require('path');

// 调用 generate-manifest.js 生成 manifest.json
function generateManifest() {
  console.log('Generating manifest.json for Docker deployment...');

  try {
    const generateManifestScript = path.join(
      __dirname,
      'scripts',
      'generate-manifest.js'
    );
    require(generateManifestScript);
  } catch (error) {
    console.error('❌ Error calling generate-manifest.js:', error);
    throw error;
  }
}

generateManifest();

// 直接在当前进程中启动 standalone Server（`server.js`）
require('./server.js');

// 每 1 秒轮询一次，直到请求成功
const TARGET_URL = `http://${process.env.HOSTNAME || 'localhost'}:${
  process.env.PORT || 3000
}/login`;

// cron 调度间隔：1 小时
const CRON_INTERVAL_MS = 60 * 60 * 1000;
// cron 请求超时：服务端任务实测 2~4 分钟，客户端超时必须显著大于它，
// 否则每次都会打出误导性的 "Cron job timeout"（服务端其实还在正常执行）
const CRON_TIMEOUT_MS = 10 * 60 * 1000;

// 进程内互斥：上一次 cron 还没结束就不再发起新的请求
let cronRunning = false;
let cronTimer = null;

const intervalId = setInterval(() => {
  console.log(`Fetching ${TARGET_URL} ...`);

  const req = http.get(TARGET_URL, (res) => {
    // 当返回 2xx 状态码时认为成功，然后停止轮询
    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
      console.log('Server is up, stop polling.');
      clearInterval(intervalId);

      // 服务器启动后立即执行一次 cron 任务，之后每小时一次
      executeCronJob();
    }
  });

  req.setTimeout(2000, () => {
    req.destroy();
  });
}, 1000);

// 排定下一次 cron（上一次结束后再排，避免任务超时导致调度堆积）
function scheduleNextCron() {
  if (cronTimer) {
    clearTimeout(cronTimer);
  }
  cronTimer = setTimeout(() => {
    cronTimer = null;
    executeCronJob();
  }, CRON_INTERVAL_MS);
}

// 执行 cron 任务的函数
function executeCronJob() {
  if (cronRunning) {
    console.warn(
      'Cron job skipped: previous run is still in progress (in-process lock)'
    );
    scheduleNextCron();
    return;
  }
  cronRunning = true;

  const cronUrl = `http://${process.env.HOSTNAME || 'localhost'}:${
    process.env.PORT || 3000
  }/api/cron`;

  console.log(`Executing cron job: ${cronUrl}`);

  // 请求可能同时触发 end / error / timeout，只处理第一次
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    cronRunning = false;
    scheduleNextCron();
  };

  const options = {};
  if (process.env.CRON_TOKEN) {
    // 与 /api/cron 的 CRON_TOKEN 校验配套
    options.headers = { 'x-cron-token': process.env.CRON_TOKEN };
  }

  const req = http.get(cronUrl, options, (res) => {
    let data = '';

    res.on('data', (chunk) => {
      data += chunk;
    });

    res.on('end', () => {
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
        console.log('Cron job executed successfully:', data);
      } else {
        console.error('Cron job failed:', res.statusCode, data);
      }
      finish();
    });
  });

  req.on('error', (err) => {
    console.error('Error executing cron job:', err);
    finish();
  });

  req.setTimeout(CRON_TIMEOUT_MS, () => {
    console.error('Cron job timeout');
    req.destroy();
    finish();
  });
}
