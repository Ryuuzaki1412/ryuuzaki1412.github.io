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

  // 4. Guest 通过分享链接进入 (#roomCode) —— 验证 Bug 2：新用户点链接会弹出玩法说明
  console.log(`Guest 正在通过链接加入房间 ${roomCode}...`);
  await pageGuest.goto(`http://127.0.0.1:${PORT}/index.html#${roomCode}`, { waitUntil: 'load' });
  await sleep(600);

  // 验证 Guest 首次通过链接访问弹出了玩法说明！
  t('Guest 通过链接进入成功弹出玩法说明', await pageGuest.locator('#tutOv.show').count() === 1);
  const tutBtnText = await pageGuest.locator('#btnTutOk').textContent();
  t('玩法说明按钮提示加入对战', tutBtnText.includes('加入对战'));

  // Guest 点击“明白啦，加入对战！”
  await pageGuest.click('#btnTutOk');
  await sleep(300);

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

  // 6. 验证 Host 是先手
  await sleep(1500);
  const hostHint = await pageHost.locator('#hintbar').innerText();
  t('Host 先手并自动完成掷骰', hostHint.includes('掷出') || hostHint.includes('放置'), hostHint);

  // 7. Host 放置骰子在第 1 列（索引 0）
  console.log('Host 正在落子到第 1 列...');
  await pageHost.click('#boardYou .col:first-child');
  await sleep(1000);

  const guestBoardTopDiceCount = await pageGuest.locator('#boardRat .col:first-child .die').count();
  t('Guest 界面上方棋盘实时同步了 Host 的落子', guestBoardTopDiceCount === 1);

  // 8. 验证 Bug 1 修复：第一局结束触发结算，测试“再来一局”
  console.log('模拟第一局打完，进入结算界面测试再来一局...');
  await pageHost.evaluate(() => endGame());
  await pageGuest.evaluate(() => endGame());
  await sleep(1500);

  t('双端均已进入结算界面', 
    await pageHost.locator('#endOv.show').count() === 1 && 
    await pageGuest.locator('#endOv.show').count() === 1
  );

  // Host 点击“再来一局”
  console.log('Host 发起再战请求...');
  await pageHost.click('#btnAgain');
  await sleep(500);

  // 检查 Guest 端的提示和按钮变化
  const guestAgainBtnText = await pageGuest.locator('#btnAgain').textContent();
  t('Guest 端收到再战邀请，按钮变为接受挑战', guestAgainBtnText.includes('接受挑战'));

  // Guest 点击“接受挑战，再来一局！”
  console.log('Guest 点击接受挑战...');
  await pageGuest.click('#btnAgain');
  await sleep(1500);

  // 核心断言：验证双方两端（尤其是 Guest 端）都关掉了结算界面，且都弹出了猜拳窗口！
  const hostRpsShow = await pageHost.locator('#rpsOv.show').count() === 1;
  const guestRpsShow = await pageGuest.locator('#rpsOv.show').count() === 1;
  t('Host 端已成功重新进入猜拳定先手', hostRpsShow);
  t('Guest 端已成功弹出猜拳按钮/定先手界面', guestRpsShow);

  // 截图留存
  await pageHost.screenshot({ path: '/tmp/kb-host-rematch.png' });
  await pageGuest.screenshot({ path: '/tmp/kb-guest-rematch.png' });
  console.log('已保存再战测试截图到 /tmp/kb-*-rematch.png');

  console.log(`\n测试完成: ${pass} 项通过, ${fail} 项失败`);
  await browser.close();
  server.close();
  process.exit(fail > 0 ? 1 : 0);
})();
