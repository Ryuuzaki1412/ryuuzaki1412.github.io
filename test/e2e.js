const { chromium } = require('playwright-core');

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const URL = 'http://127.0.0.1:8791/index.html';
const SHOTS = '/tmp/kb-e2e';

let pass = 0, fail = 0;
const t = (name, ok, extra='') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
  ok ? pass++ : fail++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 猜拳直到分出胜负（平局自动重开）
async function rpsUntilDone(page, label) {
  for (let i = 0; i < 14; i++) {
    if (await page.locator('#rpsOv.show').count() === 0) return true;
    await page.click('.rpsbtn[data-c="rock"]');
    await sleep(2000); // 摇拳 700 + 平局重置 950 / 结果 1100
  }
  return await page.locator('#rpsOv.show').count() === 0;
}

// 验证 fit()：重置后量原始尺寸 → 期望缩放；连跑两次必须幂等（防叠加缩小）
async function zoomCheck(page) {
  return await page.evaluate(() => {
    const st = document.querySelector('#stage');
    st.style.zoom = 1;
    const w = st.offsetWidth, h = st.offsetHeight;
    const exp = Math.min(1, (innerWidth - 20) / w, (innerHeight - 20) / h);
    fit();
    const z1 = parseFloat(st.style.zoom);
    fit(); fit(); // 连跑两次，若测量含 zoom 会叠乘变小
    const z3 = parseFloat(st.style.zoom);
    return { exp, z1, z3, w, h };
  });
}

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 560, height: 920 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(URL, { waitUntil: 'load' });
  await sleep(600);
  const zc1 = await zoomCheck(page);
  t('大窗口：缩放为 1（不缩小）', zc1.z1 === 1, `zoom=${zc1.z1}`);
  t('fit 幂等（反复调用不叠缩）', Math.abs(zc1.z3 - zc1.z1) < 0.001, `${zc1.z1} → ${zc1.z3}`);

  // ---- 1. 初始状态：教程自动弹出 ----
  t('教程覆盖层显示', await page.locator('#tutOv.show').count() === 1);
  t('教程四步都渲染了', await page.locator('.step').count() === 4);
  await page.screenshot({ path: `${SHOTS}/1-tutorial.png` });
  await page.click('#btnTutOk');
  await sleep(300);

  // ---- 2. 开始界面 ----
  t('开始覆盖层显示', await page.locator('#startOv.show').count() === 1);
  t('默认筹码 5 被选中', await page.locator('.chip.sel').textContent() === '5');
  await page.screenshot({ path: `${SHOTS}/2-start.png` });
  await page.click('#btnStart');
  await sleep(250);

  // ---- 3. 猜拳定先手 ----
  t('猜拳覆盖层显示', await page.locator('#rpsOv.show').count() === 1);
  t('猜拳三个出招按钮', await page.locator('.rpsbtn').count() === 3);
  await page.screenshot({ path: `${SHOTS}/3-rps.png` });
  t('猜拳分出胜负并进入对局', await rpsUntilDone(page));
  t('对局中无残留覆盖层', await page.locator('.overlay.show').count() === 0);
  t('渲染文本无 emoji 字符', await page.evaluate(
      () => !/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u.test(document.body.textContent)));

  // ---- 4. 自动掷骰 ----
  await page.waitForFunction(() => phase === 'placing', null, { timeout: 30000 });
  t('自动掷骰：无需点击，回合自动进入放置', true);
  t('自动掷骰：中央已出现骰子', await page.evaluate(() => !!document.querySelector('#youDie .die')));
  t('掷骰按钮已移除', await page.locator('#btnRoll').count() === 0);

  // ---- 5. 自动对弈直到终局 ----
  let moves = 0, midgameShot = false, startCoins = 30;
  const t0 = Date.now();
  while (Date.now() - t0 < 150000) {
    const ph = await page.evaluate(() => phase);
    if (ph === 'over') break;
    if (ph === 'placing') {
      if (!midgameShot && (await page.evaluate(() => boards.you.flat().length)) >= 2) {
        await page.screenshot({ path: `${SHOTS}/4-midgame.png` });
        midgameShot = true;
      }
      const colIdx = await page.evaluate(() => boards.you.findIndex(col => col.length < 3));
      await page.evaluate(i => {
        document.querySelectorAll('#boardYou .col')[i].dispatchEvent(
          new MouseEvent('click', { bubbles: true }));
      }, colIdx);
      moves++;
      await page.waitForFunction(() => ['idle', 'over'].includes(phase), null, { timeout: 20000 });
    } else {
      await sleep(300);
    }
  }
  t('对弈正常推进到终局', await page.evaluate(() => phase) === 'over', `玩家走了 ${moves} 步`);

  // ---- 6. 终局断言 ----
  await sleep(1400);
  t('结算覆盖层显示', await page.locator('#endOv.show').count() === 1);
  const st = await page.evaluate(() => ({
    Y: total(boards.you), R: total(boards.rat),
    youDice: boards.you.flat().length, ratDice: boards.rat.flat().length,
    youFull: isFull(boards.you), ratFull: isFull(boards.rat),
    coins: coins, bet: bet,
    dispY: +document.querySelector('#youTotal').textContent,
    dispR: +document.querySelector('#ratTotal').textContent,
    title: document.querySelector('#endTitle').textContent,
    coinNum: +document.querySelector('#coinNum').textContent,
  }));
  t('至少一方棋盘已满（结束条件）', st.youFull || st.ratFull, `you=${st.youDice}/9 rat=${st.ratDice}/9`);
  t('你的显示总分与规则计算一致', st.dispY === st.Y, `显示 ${st.dispY} = 计算 ${st.Y}`);
  t('拉陶显示总分与规则计算一致', st.dispR === st.R, `显示 ${st.dispR} = 计算 ${st.R}`);
  const expectTitle = st.Y > st.R ? '你赢了！' : st.Y < st.R ? '你输了……' : '平局！';
  t('结算标题与比分相符', st.title === expectTitle, `${st.title}（你 ${st.Y} : ${st.R} 拉陶）`);
  const expectCoins = startCoins - st.bet + (st.Y > st.R ? st.bet * 2 : st.Y === st.R ? st.bet : 0);
  t('金币结算数学正确', st.coins === expectCoins && st.coinNum === expectCoins,
    `终局 ${st.coins} = 30 - ${st.bet}注 + 回报`);
  await page.screenshot({ path: `${SHOTS}/5-gameover.png` });

  // ---- 7. 再来一局（含重新猜拳） ----
  if (st.coins >= st.bet) {
    await page.click('#btnAgain');
    await sleep(300);
    t('再来一局：进入猜拳', await page.locator('#rpsOv.show').count() === 1);
    t('再来一局：猜拳完成', await rpsUntilDone(page));
    await page.waitForFunction(() => phase === 'placing', null, { timeout: 30000 });
    t('再来一局：棋盘已重置（≤1 颗骰，先手方可能已放）', await page.evaluate(
        () => boards.you.flat().length + boards.rat.flat().length <= 1),
      await page.evaluate(() => `you=${boards.you.flat().length} rat=${boards.rat.flat().length}`));
    t('再来一局：筹码已再扣', await page.evaluate(() => coins) === expectCoins - st.bet);
    t('再来一局：总分归零', await page.evaluate(
        () => document.querySelector('#youTotal').textContent === '0'));
  }

  // ---- 8. 全程无 JS 错误 ----
  t('全程无页面/控制台错误', errors.length === 0, errors.slice(0, 3).join(' | '));
  t('结算后渲染文本无 emoji 字符', await page.evaluate(
      () => !/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u.test(document.body.textContent)));
  const icStat = await page.evaluate(() => ({
    total: document.querySelectorAll('.ic').length,
    empty: document.querySelectorAll('[data-ic]:empty').length,
  }));
  t('图标全部注入为 SVG', icStat.total >= 12 && icStat.empty === 0,
    `svg=${icStat.total} 未注入=${icStat.empty}`);

  // ---- 9. 小窗口：页面可滚动/不裁切（回归之前的 overflow:hidden bug） ----
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 640 } });
  const page2 = await ctx2.newPage();
  await page2.goto(URL, { waitUntil: 'load' });
  await sleep(900);
  t('小窗口：教程覆盖层完整显示', await page2.locator('#tutOv.show').count() === 1);
  const sc = await page2.evaluate(() => ({
    sh: document.documentElement.scrollHeight, ih: innerHeight,
    sw: document.documentElement.scrollWidth, iw: innerWidth,
    overflowY: getComputedStyle(document.body).overflowY,
  }));
  t('小窗口：无垂直溢出', sc.sh <= sc.ih + 2, `scrollHeight ${sc.sh} vs innerHeight ${sc.ih}`);
  t('小窗口：无水平溢出', sc.sw <= sc.iw + 2, `scrollWidth ${sc.sw} vs innerWidth ${sc.iw}`);
  t('小窗口：body 未禁止滚动', sc.overflowY !== 'hidden');
  const zc2 = await zoomCheck(page2);
  t('小窗口：缩放系数符合公式', Math.abs(zc2.z1 - zc2.exp) < 0.02,
    `zoom=${zc2.z1.toFixed(3)} 期望=${zc2.exp.toFixed(3)}（${zc2.w}×${zc2.h}）`);
  t('小窗口：fit 幂等', Math.abs(zc2.z3 - zc2.z1) < 0.001, `${zc2.z1} → ${zc2.z3}`);
  await ctx2.close();

  await browser.close();
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('E2E 崩溃:', e); process.exit(2); });
