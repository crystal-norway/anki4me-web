/* Anki 卡片轮播 - 应用逻辑（与 HTML/CSS 解耦） */
(function () {
  "use strict";
  var DATA = null;
  var pool = [];
  var current = null;
  var interval = 10;
  var paused = false;
  var timerId = null;
  var progressTimer = null;
  var tickStart = 0;
  var lastIdx = -1;

  // 禅模式：控制条自动隐藏/唤出
  var PANEL_VISIBLE = false;
  var hideTimer = null;
  var HIDE_DELAY_MS = 2500;  // 鼠标离开后 2.5 秒自动隐藏

  var els = {
    hoverZone: document.getElementById('hoverZone'),
    topbar: document.getElementById('topbar'),
    title: document.getElementById('title'),
    sub: document.getElementById('sub'),
    deckSel: document.getElementById('deckSel'),
    interval: document.getElementById('interval'),
    intervalNum: document.getElementById('intervalNum'),
    progressBar: document.getElementById('progressBar'),
    prevBtn: document.getElementById('prevBtn'),
    nextBtn: document.getElementById('nextBtn'),
    pauseBtn: document.getElementById('pauseBtn'),
    cardEl: document.getElementById('cardEl'),
    emptyEl: document.getElementById('emptyEl'),
    metaIdx: document.getElementById('metaIdx'),
    metaDeck: document.getElementById('metaDeck'),
    metaTags: document.getElementById('metaTags'),
    frontInner: document.getElementById('frontInner'),
    backInner: document.getElementById('backInner'),
    kbdHint: document.getElementById('kbdHint'),
    bookSel: document.getElementById('bookSel'),
    themeToggle: document.getElementById('themeToggle'),
    autoPlayToggle: document.getElementById('autoPlayToggle'),
    stage: document.querySelector('.stage'),
  };

  // —— 主题切换（浅色/深色） ——
  var THEME_DARK = false;
  try { THEME_DARK = localStorage.getItem('anki_theme') === 'dark'; } catch (e) {}
  if (THEME_DARK) {
    document.documentElement.setAttribute('data-theme', 'dark');
    els.themeToggle.classList.add('on');
    els.themeToggle.setAttribute('aria-pressed', 'true');
  }
  els.themeToggle.addEventListener('click', function () {
    THEME_DARK = !THEME_DARK;
    if (THEME_DARK) {
      document.documentElement.setAttribute('data-theme', 'dark');
      els.themeToggle.classList.add('on');
      els.themeToggle.setAttribute('aria-pressed', 'true');
    } else {
      document.documentElement.removeAttribute('data-theme');
      els.themeToggle.classList.remove('on');
      els.themeToggle.setAttribute('aria-pressed', 'false');
    }
    try { localStorage.setItem('anki_theme', THEME_DARK ? 'dark' : 'light'); } catch (e) {}
  });

  // —— 自动朗读开关 ——
  var AUTO_PLAY = false;
  try { AUTO_PLAY = localStorage.getItem('anki_autoplay') === '1'; } catch (e) {}
  if (AUTO_PLAY) {
    els.autoPlayToggle.classList.add('on');
    els.autoPlayToggle.setAttribute('aria-pressed', 'true');
  }
  els.autoPlayToggle.addEventListener('click', function () {
    AUTO_PLAY = !AUTO_PLAY;
    if (AUTO_PLAY) {
      els.autoPlayToggle.classList.add('on');
      els.autoPlayToggle.setAttribute('aria-pressed', 'true');
    } else {
      els.autoPlayToggle.classList.remove('on');
      els.autoPlayToggle.setAttribute('aria-pressed', 'false');
    }
    try { localStorage.setItem('anki_autoplay', AUTO_PLAY ? '1' : '0'); } catch (e) {}
  });

  // —— 加载数据：优先 manifest.json（多词书），回退 cards.json（单词书） ——
  // DATA_BASE 指向 jsDelivr CDN（GitHub 仓库），JSON 文件也走 CDN
  // 本地预览可设置为空字符串走相对路径
  var DATA_BASE = 'https://cdn.jsdelivr.net/gh/crystal-norway/anki4me-web@main/';

  var MANIFEST = null;

  fetch(DATA_BASE + 'manifest.json')
    .then(function (r) {
      if (!r.ok) throw new Error('no manifest');
      return r.json();
    })
    .then(function (manifest) {
      MANIFEST = manifest;
      initManifest();
    })
    .catch(function () {
      // 回退：单词书模式，直接加载 cards.json
      loadBook('cards.json', function () {
        els.bookSel.style.display = 'none';  // 单词书无词书下拉
        init();
      });
    });

  function loadBook(file, cb) {
    fetch(DATA_BASE + file)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        DATA = data;
        if (cb) cb();
      })
      .catch(function (err) {
        els.emptyEl.className = 'error';
        els.emptyEl.textContent = '加载 ' + file + ' 失败：' + err.message
          + '。请通过本地服务器（如 python -m http.server）打开本页，'
          + '不要直接双击 file://，否则 fetch 会被浏览器拦截。';
      });
  }

  function initManifest() {
    var books = MANIFEST.books || [];
    els.title.textContent = 'Anki 卡片轮播 · ' + books.length + ' 本词书';
    els.sub.textContent = '共 ' + books.reduce(function (s, b) { return s + b.count; }, 0)
      + ' 张卡片 · 生成于 ' + (MANIFEST.generated_at || '');

    // 填充词书下拉
    els.bookSel.innerHTML = '';
    books.forEach(function (b, i) {
      var o = document.createElement('option');
      o.value = i;
      o.textContent = b.name + ' (' + b.count + ')';
      els.bookSel.appendChild(o);
    });
    els.bookSel.disabled = false;

    // 记住上次选的词书
    var savedBook = null;
    try { savedBook = localStorage.getItem('anki_book_id'); } catch (e) {}
    var initIdx = 0;
    if (savedBook) {
      for (var i = 0; i < books.length; i++) {
        if (books[i].id === savedBook) { initIdx = i; break; }
      }
    }
    els.bookSel.value = String(initIdx);

    els.bookSel.addEventListener('change', function () {
      var b = books[parseInt(els.bookSel.value, 10)];
      try { localStorage.setItem('anki_book_id', b.id); } catch (e) {}
      switchBook(b);
    });

    switchBook(books[initIdx]);
  }

  function switchBook(book) {
    loadBook(book.file, function () {
      populateDeckSel();
      bindEvents();  // 首次加载后绑定事件
      // 更新副标题
      els.sub.textContent = book.name + ' · ' + (DATA.cards || []).length
        + ' 张 · ' + (DATA.decks || []).length + ' 个牌组';

      buildPool('');
      if (pool.length === 0) {
        els.emptyEl.style.display = '';
        els.emptyEl.textContent = '没有卡片';
        els.cardEl.style.display = 'none';
        return;
      }
      els.emptyEl.style.display = 'none';
      els.cardEl.style.display = 'flex';
      showRandom();

      showPanel();
      scheduleHide();
    });
  }

  // —— 禅模式：控制条显隐控制 ——
  function showPanel() {
    PANEL_VISIBLE = true;
    els.topbar.classList.add('visible');
    els.kbdHint.classList.add('visible');
    els.stage.classList.add('with-bar');
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  }

  function hidePanel() {
    PANEL_VISIBLE = false;
    els.topbar.classList.remove('visible');
    els.kbdHint.classList.remove('visible');
    els.stage.classList.remove('with-bar');
  }

  function scheduleHide() {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      // 只在焦点不在输入控件上时才隐藏
      var tag = document.activeElement ? document.activeElement.tagName : '';
      if (tag !== 'INPUT' && tag !== 'SELECT') hidePanel();
    }, HIDE_DELAY_MS);
  }

  // hover-zone 鼠斯移入 → 显示
  els.hoverZone.addEventListener('mouseenter', showPanel);
  // 控制条上鼠标移动 → 保持显示并推迟隐藏
  els.topbar.addEventListener('mouseenter', function () {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  });
  els.topbar.addEventListener('mouseleave', scheduleHide);
  els.topbar.addEventListener('change', function (e) {
    // select 改变后不要立即隐藏，让用户看到结果
    setTimeout(scheduleHide, 100);
  });

  // 点击页面任意位置 → 唤出/隐藏面板（在卡片区域单击翻转除外）
  document.addEventListener('click', function (e) {
    // 点击控制条内部不触发切换
    if (els.topbar.contains(e.target)) return;
    if (PANEL_VISIBLE) {
      // 已显示时点击其他区域 → 隐藏
      hidePanel();
    } else {
      showPanel();
      scheduleHide();
    }
  });

  // —— 初始化 ——
  // —— 事件绑定（只绑定一次） ——
  var EVENTS_BOUND = false;
  function bindEvents() {
    if (EVENTS_BOUND) return;
    EVENTS_BOUND = true;

    try {
      var saved = parseInt(localStorage.getItem('anki_interval'), 10);
      if (saved >= 2 && saved <= 60) interval = saved;
    } catch (e) {}
    els.interval.value = interval;
    els.intervalNum.value = interval;

    els.deckSel.addEventListener('change', function () {
      buildPool(els.deckSel.value);
      showRandom();
    });
    els.interval.addEventListener('input', function () {
      interval = parseInt(els.interval.value, 10) || 10;
      els.intervalNum.value = interval;
      try { localStorage.setItem('anki_interval', String(interval)); } catch (e) {}
      restartTimer();
    });
    els.intervalNum.addEventListener('change', function () {
      var v = parseInt(els.intervalNum.value, 10);
      if (v >= 2 && v <= 60) {
        interval = v;
        els.interval.value = v;
        try { localStorage.setItem('anki_interval', String(interval)); } catch (e) {}
        restartTimer();
      }
    });
    els.prevBtn.addEventListener('click', function () { showByOffset(-1); });
    els.nextBtn.addEventListener('click', function () { showByOffset(1); });
    els.pauseBtn.addEventListener('click', togglePause);

    document.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.code === 'Space') { e.preventDefault(); togglePause(); }
      else if (e.code === 'ArrowLeft') showByOffset(-1);
      else if (e.code === 'ArrowRight') showByOffset(1);
      else if (e.code === 'KeyR') showRandom();
      else if (e.code === 'KeyH') {
        // H 键：显隐面板
        if (PANEL_VISIBLE) hidePanel(); else { showPanel(); scheduleHide(); }
      }
    });
  }

  function populateDeckSel() {
    els.deckSel.innerHTML = '';
    var total = (DATA.cards || []).length;
    var allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = '全部 (' + total + ')';
    els.deckSel.appendChild(allOpt);
    (DATA.decks || []).forEach(function (d) {
      var o = document.createElement('option');
      o.value = d.name;
      o.textContent = d.name + ' (' + d.count + ')';
      els.deckSel.appendChild(o);
    });
    els.deckSel.disabled = false;
  }

  function init() {
    // 单词书回退入口
    els.title.textContent = DATA.source || 'Anki 卡片轮播';
    var deckCount = (DATA.decks || []).length;
    var total = (DATA.cards || []).length;
    els.sub.textContent = total + ' 张卡片 · ' + deckCount + ' 个牌组 · 生成于 ' + (DATA.generated_at || '');

    populateDeckSel();
    bindEvents();

    buildPool('');
    if (pool.length === 0) {
      els.emptyEl.textContent = '没有卡片';
      return;
    }
    els.emptyEl.style.display = 'none';
    els.cardEl.style.display = 'flex';
    showRandom();

    // 初次显示一下提示，3 秒后淡出
    showPanel();
    scheduleHide();
  }

  function buildPool(deckName) {
    if (!DATA) { pool = []; return; }
    if (!deckName) {
      pool = DATA.cards.slice();
    } else {
      pool = DATA.cards.filter(function (c) { return c.deck === deckName; });
    }
    lastIdx = -1;
  }

  function showRandom() {
    if (!pool.length) return;
    var i;
    if (pool.length > 1) {
      do { i = Math.floor(Math.random() * pool.length); } while (i === lastIdx);
    } else {
      i = 0;
    }
    lastIdx = i;
    render(pool[i]);
    restartTimer();
  }

  function showByOffset(offset) {
    if (!pool.length) return;
    if (lastIdx < 0) { showRandom(); return; }
    var i = (lastIdx + offset + pool.length) % pool.length;
    lastIdx = i;
    render(pool[i]);
    restartTimer();
  }

  function render(card) {
    current = card;
    els.metaIdx.textContent = '#' + card.idx;
    els.metaDeck.textContent = card.deck;
    els.metaTags.textContent = (card.tags || []).map(function (t) { return '#' + t; }).join('  ');
    var cssId = 'anki-card-css';
    var old = document.getElementById(cssId);
    if (old) old.parentNode.removeChild(old);
    if (card.css) {
      var style = document.createElement('style');
      style.id = cssId;
      style.textContent = card.css;
      document.head.appendChild(style);
    }
    els.frontInner.innerHTML = card.front || '';
    els.backInner.innerHTML = card.back || '';
    els.frontInner.parentNode.scrollTop = 0;
    els.backInner.parentNode.scrollTop = 0;
    // 自动朗读：播放正面第一个音频
    if (AUTO_PLAY) {
      setTimeout(function () {
        var audio = els.frontInner.querySelector('audio');
        if (audio) {
          audio.play().catch(function () {});
        }
      }, 300);
    }
  }

  function restartTimer() {
    stopTimer();
    if (paused) return;
    tickStart = Date.now();
    var durationMs = interval * 1000;
    els.progressBar.style.width = '0%';
    progressTimer = setInterval(function () {
      var elapsed = Date.now() - tickStart;
      var pct = Math.min(100, (elapsed / durationMs) * 100);
      els.progressBar.style.width = pct + '%';
    }, 100);
    timerId = setTimeout(function () {
      stopTimer();
      showRandom();
    }, durationMs);
  }

  function stopTimer() {
    if (timerId) { clearTimeout(timerId); timerId = null; }
    if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
  }

  function togglePause() {
    paused = !paused;
    els.pauseBtn.textContent = paused ? '▶ 继续' : '⏸ 暂停';
    els.pauseBtn.classList.toggle('active', paused);
    if (paused) {
      stopTimer();
    } else {
      restartTimer();
    }
  }
})();
