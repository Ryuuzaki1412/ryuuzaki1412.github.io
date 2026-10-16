const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const PORT = 8792;
const ROOT = path.resolve(__dirname, '..');

// 简单静态服务器
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  let u = req.url.split('?')[0].split('#')[0];
  if (u === '/') u = '/index.html';
  const fp = path.join(ROOT, u);
  if (!fs.existsSync(fp)) { res.writeHead(404); return res.end('Not found'); }
  const ext = path.extname(fp);
  res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
  fs.createReadStream(fp).pipe(res);
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const t = (name, ok, extra = '') => {
  console.log(`${ok ? '✓ PASS' : '✗ FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
  ok ? pass++ : fail++;
};

(async () => {
  server.listen(PORT);
  console.log(`本地测试服务器已在端口 ${PORT} 启动`);

  const browser = await chromium.launch({ executablePath: EDGE, headless: true });

  const hostCtx = await browser.newContext({ viewport: { width: 500, height: 900 } });
  const guestCtx = await browser.newContext({ viewport: { width: 500, height: 900 } });

  const pageHost = await hostCtx.newPage();
  const pageGuest = await guestCtx.newPage();

  pageHost.on('console', m => console.log('[Host Console]', m.type(), m.text()));
  pageGuest.on('console', m => console.log('[Guest Console]', m.type(), m.text()));

  // 1. Host 打开页面并关掉新手教程
  await pageHost.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
  await sleep(600);
  if (await pageHost.locator('#tutOv.show').count() > 0) {
    await pageHost.click('#btnTutOk');
    await sleep(600);
  }

  // 2. Host 打开联机面板
  t('开始菜单显示正常', await pageHost.locator('#startOv.show').count() === 1);
  await pageHost.click('#btnOnlineOpen');
  await sleep(300);
  t('联机对话框显示正常', await pageHost.locator('#onlineOv.show').count() === 1);

  // 3. Host 点击创建房间
  await pageHost.click('#btnCreateRoom');
  console.log('Host 正在向信令服务器注册房间...');

  // 等待房间号产生（最多等 10 秒）
  await pageHost.waitForSelector('#roomCodeDisplay', { state: 'visible', timeout: 10000 });
  const roomCode = await pageHost.locator('#roomCodeDisplay').textContent();
  t('房主成功生成房间代码', !!roomCode && roomCode.length >= 4, `Room: ${roomCode}`);

  // 4. Guest 通过分享链接进入 (#roomCode)
  console.log(`Guest 正在通过链接加入房间 ${roomCode}...`);
  await pageGuest.goto(`http://127.0.0.1:${PORT}/index.html#${roomCode}`);

  // 等待双方成功连接并进入猜拳定先手界面
  console.log('等待双方 P2P WebRTC 通道打通...');
  await Promise.all([
    pageHost.waitForSelector('#rpsOv.show', { timeout: 25000 }),
    pageGuest.waitForSelector('#rpsOv.show', { timeout: 25000 })
  ]);
  t('双端成功通过 WebRTC 直连并进入猜拳阶段', true);

  // 验证双方上方对手标签为“对手”
  const hostOpp = await pageHost.locator('#nameRat').textContent();
  const guestOpp = await pageGuest.locator('#nameRat').textContent();
  t('双方昵称标签已正确切换为联机对手', hostOpp.includes('对手') && guestOpp.includes('对手'));

  // 5. 猜拳：Host 选剪刀，Guest 选布 -> Host 必定先手
  console.log('进行猜拳测试 (Host 剪刀 vs Guest 布)...');
  await pageHost.click('.rpsbtn[data-c="scissors"]');
  await sleep(400);
  await pageGuest.click('.rpsbtn[data-c="paper"]');

  // 等待猜拳揭晓动画与判定
  await sleep(2200);
  t('猜拳弹窗已自动关闭，进入棋局', await pageHost.locator('#rpsOv.show').count() === 0);

  // 6. 验证 Host 是先手（Host 处于 idle/rolling/placing，Guest 处于等待）
  await sleep(1500); // 等待自动掷骰动画完成
  const hostHint = await pageHost.locator('#hintbar').innerText();
  t('Host 先手并自动完成掷骰', hostHint.includes('掷出') || hostHint.includes('放置'), hostHint);

  // 7. Host 放置骰子在第 1 列（索引 0）
  console.log('Host 正在落子到第 1 列...');
  await pageHost.click('#boardYou .col:first-child');
  await sleep(1000);

  // 8. 验证 Guest 界面上方对手棋盘（第 1 列）出现骰子
  const guestBoardTopDiceCount = await pageGuest.locator('#boardRat .col:first-child .die').count();
  t('Guest 界面上方棋盘实时同步了 Host 的落子', guestBoardTopDiceCount === 1);

  // 截图留存
  await pageHost.screenshot({ path: '/tmp/kb-host-online.png' });
  await pageGuest.screenshot({ path: '/tmp/kb-guest-online.png' });
  console.log('已保存 Host 和 Guest 运行截图到 /tmp/kb-*.png');

  console.log(`\n测试完成: ${pass} 项通过, ${fail} 项失败`);
  await browser.close();
  server.close();
  process.exit(fail > 0 ? 1 : 0);
})();
