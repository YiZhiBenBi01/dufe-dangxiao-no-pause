const TARGET = /^https?:\/\/szdx\.dufe\.edu\.cn\//i;
const el = (id) => document.getElementById(id);

async function activeTab() {
  return (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
}

async function readState(tab) {
  // 优先：主世界直接读注入脚本暴露的状态
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        let off = false;
        let autoDialog = true;
        try {
          off = localStorage.getItem('__szdx_guard_off') === '1';
          autoDialog = localStorage.getItem('__szdx_auto_dialog') !== '0';
        } catch (e) {}
        const g = window.__szdxGuard;
        return {
          installed: !!(g && g.installed),
          blocked: g ? g.blocked : 0,
          resumed: g ? g.resumed : 0,
          skipped: g ? g.skipped : 0,
          confirmed: g ? g.confirmed : 0,
          acknowledged: g ? g.acknowledged : 0,
          started: g ? g.started : 0,
          autoDialog,
          version: g ? g.version : '',
          off
        };
      }
    });
    if (r && r.result) return r.result;
  } catch (e) {}

  // 兜底：隔离世界读角标上的 data-szdx（DOM 在两个世界之间共享）
  try {
    const [r2] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const b = document.getElementById('__szdx_guard_badge');
        if (!b) return null;
        try { return JSON.parse(b.getAttribute('data-szdx') || '{}'); } catch (e) { return null; }
      }
    });
    const d = r2 && r2.result;
    if (d) return Object.assign({ installed: true, off: false, version: '' }, d);
  } catch (e) {}

  return null;
}

// 重新加载扩展后，已打开的页面不会自动补注入；这个按钮可在不刷新、不丢进度的前提下立即生效。
async function injectNow(tab) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        window.__szdxForceMain = true;
        try { delete window.__szdxGuard; } catch (e) { window.__szdxGuard = undefined; }
        const b = document.getElementById('__szdx_guard_badge');
        if (b && b.parentNode) b.parentNode.removeChild(b);
      }
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      files: ['inject.js']
    });
    return true;
  } catch (e) {
    // 降级：浏览器不支持 world:'MAIN' 时，用 script 标签在页面主世界加载（已声明 web_accessible_resources）
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const s = document.createElement('script');
          s.src = chrome.runtime.getURL('inject.js') + '?szdx-main=1';
          (document.head || document.documentElement).appendChild(s);
        }
      });
      return true;
    } catch (e2) {
      return false;
    }
  }
}

async function render() {
  const tab = await activeTab();
  if (!tab) return;

  const onTarget = TARGET.test(tab.url || '');
  let path = '-';
  try { path = new URL(tab.url).pathname; } catch (e) {}
  el('page').textContent = onTarget
    ? (/\/videodetails\//i.test(path) ? '视频播放页' : '站内其它页')
    : '非目标站点';

  if (!onTarget) {
    el('state').textContent = '未生效';
    el('state').className = 'val warn';
    el('stats').textContent = '请打开 szdx.dufe.edu.cn 的视频播放页。';
    el('injectNow').disabled = true;
    el('injectNow').textContent = '当前站点不适用';
    el('toggle').disabled = true;
    el('toggleDialog').disabled = true;
    return;
  }

  const st = await readState(tab);
  el('injectNow').disabled = false;
  el('injectNow').textContent = '立即注入到当前页（不刷新）';
  el('toggle').disabled = false;
  el('toggleDialog').disabled = false;

  if (!st) {
    el('state').textContent = '无法读取页面';
    el('state').className = 'val warn';
    el('stats').textContent = '点上方「立即注入」即可生效，或刷新页面。';
  } else if (st.off) {
    el('state').textContent = '已临时停用';
    el('state').className = 'val warn';
    el('stats').textContent = '已停用，重新启用后需刷新页面。';
  } else if (st.installed) {
    el('state').textContent = st.version === '1.3.0' ? '已生效 v1.3' : '已生效（旧版 v' + st.version + '）';
    el('state').className = 'val ok';
    el('stats').textContent =
      '拦截 ' + st.blocked + ' · 续播 ' + st.resumed +
      ' · 跳过 ' + st.skipped + ' · 完成 ' + st.confirmed +
      ' · 知晓 ' + st.acknowledged + ' · 起播 ' + st.started;
  } else {
    el('state').textContent = '未注入';
    el('state').className = 'val warn';
    el('stats').textContent = '点上方「立即注入」即可生效。';
  }

  el('toggle').textContent = st && st.off ? '重新启用此功能' : '临时停用此功能';
  el('toggle').className = st && st.off ? 'primary' : '';
  el('toggleDialog').textContent = st && st.autoDialog === false
    ? '自动处理播完弹窗：关（点击开启）'
    : '自动处理播完弹窗：开（点击关闭）';
}

el('injectNow').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab) return;
  el('injectNow').disabled = true;
  el('injectNow').textContent = '正在注入…';
  const ok = await injectNow(tab);
  await new Promise((r) => setTimeout(r, 350));
  await render();
  el('tip').textContent = ok
    ? '已注入。右下角出现绿色角标即生效；当前页的弹窗会立即被自动处理。'
    : '注入失败：请到 edge://extensions 重新加载本扩展，再试一次或刷新页面。';
});

el('toggle').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab) return;
  const st = await readState(tab);
  const nextOff = !(st && st.off);
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: (off) => {
        try {
          if (off) localStorage.setItem('__szdx_guard_off', '1');
          else localStorage.removeItem('__szdx_guard_off');
        } catch (e) {}
      },
      args: [nextOff]
    });
    await render();
    el('tip').textContent = nextOff
      ? '已停用，刷新页面后生效。'
      : '已启用，点「立即注入」或刷新页面后生效。';
  } catch (e) {
    el('tip').textContent = '切换失败，请刷新页面后重试。';
  }
});

el('toggleDialog').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab) return;
  const st = await readState(tab);
  const next = st ? st.autoDialog === false : true;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: (on) => {
        try { localStorage.setItem('__szdx_auto_dialog', on ? '1' : '0'); } catch (e) {}
      },
      args: [next]
    });
    await render();
    el('tip').textContent = next
      ? '弹窗自动处理已开启，刷新页面或重新注入后生效。'
      : '弹窗自动处理已关闭，刷新页面或重新注入后生效。';
  } catch (e) {
    el('tip').textContent = '切换失败，请刷新页面后重试。';
  }
});

el('reload').addEventListener('click', async () => {
  const tab = await activeTab();
  if (tab) await chrome.tabs.reload(tab.id);
  window.close();
});

render();
