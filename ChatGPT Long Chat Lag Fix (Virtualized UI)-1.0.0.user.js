// ==UserScript==
// @name         ChatGPT Long Chat Lag Fix (Virtualized UI)
// @namespace    https://tampermonkey.net/
// @version      1.0.0
// @description  Ускоряет длинные диалоги ChatGPT: разгружает DOM, улучшает скролл, ввод и клики.
// @author       OpenAI
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /******************************************************************
   * НАСТРОЙКИ
   ******************************************************************/
  const CONFIG = {
    keepLast: 6,              // Сколько последних сообщений держать живыми всегда
    revealBatch: 5,            // Сколько сообщений возвращать при прокрутке вверх
    topRevealZonePx: 300,      // Если пользователь близко к верху — вернуть ещё партию
    settleDelayMs: 1200,       // Ждать после мутаций, прежде чем архивировать
    controlButton: true,       // Показать кнопку в углу
    softVisualOptimizations: true,
    debug: false,
  };

  /******************************************************************
   * СЛУЖЕБНОЕ
   ******************************************************************/
  const log = (...args) => CONFIG.debug && console.log('[TM-ChatGPT-LagFix]', ...args);

  let state = {
    enabled: true,
    observer: null,
    settleTimer: null,
    scrollEl: null,
    messageContainer: null,
    archived: new Map(), // id -> { node, placeholder }
    knownIds: new WeakMap(),
    nextId: 1,
    scrollHandlerBound: null,
    isApplying: false,
  };

  function uid(node) {
    if (!state.knownIds.has(node)) {
      state.knownIds.set(node, `tmmsg-${state.nextId++}`);
    }
    return state.knownIds.get(node);
  }

  function debounce(fn, ms) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function isElementVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function isLikelyStreaming() {
    // Набор мягких эвристик. Неидеально, но лучше не трогать DOM лишний раз,
    // пока ответ активно стримится.
    const stopBtn = document.querySelector(
      'button[aria-label*="Stop"], button[aria-label*="Останов"], button[data-testid*="stop"]'
    );
    if (stopBtn && isElementVisible(stopBtn)) return true;

    const busy = document.querySelector('[aria-busy="true"]');
    if (busy && isElementVisible(busy)) return true;

    // Иногда textarea временно дёргается/обновляется во время генерации.
    const textarea = document.querySelector('textarea');
    if (textarea && textarea.matches(':disabled')) return true;

    return false;
  }

  /******************************************************************
   * ПОИСК КОНТЕЙНЕРОВ
   ******************************************************************/
  function getMessageNodes() {
    // Основной приоритет: современные атрибуты сообщений
    let nodes = Array.from(document.querySelectorAll('[data-message-author-role]'));

    // Фоллбэки на случай изменения вёрстки
    if (nodes.length < 4) {
      const articleNodes = Array.from(document.querySelectorAll('main article'));
      if (articleNodes.length >= 4) nodes = articleNodes;
    }

    // Убираем вложенные дубли
    nodes = nodes.filter((n) => {
      return !nodes.some((other) => other !== n && other.contains(n));
    });

    return nodes;
  }

  function findScrollableAncestor(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      const style = getComputedStyle(cur);
      const overflowY = style.overflowY;
      if (
        (overflowY === 'auto' || overflowY === 'scroll') &&
        cur.scrollHeight > cur.clientHeight + 100
      ) {
        return cur;
      }
      cur = cur.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function refreshContainers() {
    const messages = getMessageNodes();
    if (!messages.length) return false;

    state.messageContainer = messages[0].parentElement || document.querySelector('main');
    state.scrollEl = findScrollableAncestor(messages[0]);

    return !!state.scrollEl;
  }

  /******************************************************************
   * АРХИВАЦИЯ / ВОССТАНОВЛЕНИЕ
   ******************************************************************/
  function createPlaceholderFor(node) {
    const ph = document.createElement('div');
    ph.className = 'tm-chatgpt-placeholder';
    ph.dataset.tmPlaceholderFor = uid(node);

    const rect = node.getBoundingClientRect();
    const height = Math.max(node.offsetHeight, rect.height, 24);

    ph.style.height = `${Math.ceil(height)}px`;
    ph.style.minHeight = `${Math.ceil(height)}px`;
    ph.style.boxSizing = 'border-box';
    ph.style.pointerEvents = 'none';
    ph.style.opacity = '0';
    ph.style.margin = '0';
    ph.style.padding = '0';
    ph.style.border = '0';
    ph.style.contain = 'layout style paint';

    return ph;
  }

  function archiveNode(node) {
    if (!node || !node.isConnected) return false;
    const id = uid(node);
    if (state.archived.has(id)) return false;

    const ph = createPlaceholderFor(node);
    node.replaceWith(ph);
    state.archived.set(id, { node, placeholder: ph });
    return true;
  }

  function restoreNodeById(id) {
    const entry = state.archived.get(id);
    if (!entry) return false;
    const { node, placeholder } = entry;
    if (placeholder.isConnected) {
      placeholder.replaceWith(node);
    }
    state.archived.delete(id);
    return true;
  }

  function restorePreviousBatch() {
    const placeholders = Array.from(document.querySelectorAll('.tm-chatgpt-placeholder'));
    if (!placeholders.length) return 0;

    // Возвращаем верхнюю партию
    const batch = placeholders.slice(0, CONFIG.revealBatch);
    let restored = 0;

    for (const ph of batch) {
      if (restoreNodeById(ph.dataset.tmPlaceholderFor)) restored++;
    }

    return restored;
  }

  function getOrderedMessageEntries() {
    const live = getMessageNodes().map((node) => ({
      type: 'live',
      id: uid(node),
      node,
    }));

    const placeholders = Array.from(document.querySelectorAll('.tm-chatgpt-placeholder')).map((ph) => ({
      type: 'ph',
      id: ph.dataset.tmPlaceholderFor,
      node: ph,
    }));

    const all = [...live, ...placeholders];

    // Оставляем порядок DOM
    all.sort((a, b) => {
      if (a.node === b.node) return 0;
      const pos = a.node.compareDocumentPosition(b.node);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    return all;
  }

  function applyVirtualization() {
    if (!state.enabled) return;
    if (state.isApplying) return;
    if (!refreshContainers()) return;
    if (isLikelyStreaming()) {
      log('Skip apply while streaming');
      return;
    }

    state.isApplying = true;
    try {
      const liveMessages = getMessageNodes();
      if (liveMessages.length <= CONFIG.keepLast) return;

      const entries = getOrderedMessageEntries();
      const liveEntries = entries.filter((e) => e.type === 'live');

      const mustKeep = new Set(
        liveEntries.slice(-CONFIG.keepLast).map((e) => e.id)
      );

      // Архивируем только те живые сообщения, которые старше keepLast
      for (const entry of liveEntries) {
        if (!mustKeep.has(entry.id)) {
          archiveNode(entry.node);
        }
      }

      log('Virtualized. Live now:', getMessageNodes().length, 'Archived:', state.archived.size);
    } finally {
      state.isApplying = false;
      updateButton();
    }
  }

  function restoreAll() {
    const ids = Array.from(state.archived.keys());
    for (const id of ids) restoreNodeById(id);
    updateButton();
  }

  /******************************************************************
   * UI
   ******************************************************************/
  let btn = null;

  function ensureStyles() {
    if (document.getElementById('tm-chatgpt-lagfix-style')) return;

    const style = document.createElement('style');
    style.id = 'tm-chatgpt-lagfix-style';
    style.textContent = `
      html, body {
        scroll-behavior: auto !important;
      }

      .tm-chatgpt-placeholder {
        width: 100%;
      }

      .tm-chatgpt-lagfix-btn {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 999999;
        border: 1px solid rgba(127,127,127,.35);
        border-radius: 999px;
        padding: 10px 14px;
        font: 600 12px/1.2 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        cursor: pointer;
        backdrop-filter: blur(8px);
        background: rgba(20,20,20,.85);
        color: #fff;
        box-shadow: 0 6px 24px rgba(0,0,0,.18);
        user-select: none;
      }

      .tm-chatgpt-lagfix-btn:hover {
        transform: translateY(-1px);
      }

      .tm-chatgpt-lagfix-btn[data-off="1"] {
        opacity: .75;
      }

      /* Мягкие визуальные оптимизации */
      body.tm-chatgpt-soft-opt * {
        text-rendering: optimizeSpeed;
      }

      body.tm-chatgpt-soft-opt main [data-message-author-role],
      body.tm-chatgpt-soft-opt main article {
        contain: layout style paint;
        content-visibility: auto;
        contain-intrinsic-size: 1px 600px;
      }
    `;
    document.head.appendChild(style);
  }

  function updateButton() {
    if (!btn) return;
    const liveCount = getMessageNodes().length;
    const archivedCount = state.archived.size;
    btn.textContent = state.enabled
      ? `Chat UI: FAST · live ${liveCount} · hidden ${archivedCount}`
      : `Chat UI: OFF`;
    btn.dataset.off = state.enabled ? '0' : '1';
    btn.title = state.enabled
      ? 'ЛКМ: вкл/выкл оптимизацию. ПКМ: вернуть все скрытые сообщения.'
      : 'ЛКМ: включить оптимизацию. ПКМ: вернуть все скрытые сообщения.';
  }

  function ensureButton() {
    if (!CONFIG.controlButton || btn) return;

    btn = document.createElement('button');
    btn.className = 'tm-chatgpt-lagfix-btn';
    btn.type = 'button';

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      state.enabled = !state.enabled;

      if (!state.enabled) {
        restoreAll();
      } else {
        scheduleApply();
      }

      updateButton();
    });

    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      restoreAll();
    });

    document.body.appendChild(btn);
    updateButton();
  }

  /******************************************************************
   * СОБЫТИЯ
   ******************************************************************/
  const scheduleApply = debounce(() => {
    applyVirtualization();
  }, CONFIG.settleDelayMs);

  function onScroll() {
    if (!state.enabled || !state.scrollEl) return;

    const top = state.scrollEl.scrollTop;
    if (top <= CONFIG.topRevealZonePx) {
      const beforeHeight = state.scrollEl.scrollHeight;
      const restored = restorePreviousBatch();
      if (restored > 0) {
        // Компенсируем скачок скролла после возврата сообщений
        requestAnimationFrame(() => {
          const afterHeight = state.scrollEl.scrollHeight;
          const delta = afterHeight - beforeHeight;
          state.scrollEl.scrollTop = top + delta;
          updateButton();
        });
      }
    }
  }

  function bindScroll() {
    if (!state.scrollEl) return;

    if (state.scrollHandlerBound) {
      state.scrollEl.removeEventListener('scroll', state.scrollHandlerBound, { passive: true });
    }

    state.scrollHandlerBound = onScroll;
    state.scrollEl.addEventListener('scroll', state.scrollHandlerBound, { passive: true });
  }

  function observeDom() {
    if (state.observer) state.observer.disconnect();

    state.observer = new MutationObserver((mutations) => {
      let relevant = false;
      for (const m of mutations) {
        if (m.addedNodes?.length || m.removedNodes?.length) {
          relevant = true;
          break;
        }
      }
      if (!relevant) return;

      refreshContainers();
      bindScroll();
      scheduleApply();
    });

    state.observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  /******************************************************************
   * ИНИЦИАЛИЗАЦИЯ
   ******************************************************************/
  function init() {
    ensureStyles();
    if (CONFIG.softVisualOptimizations) {
      document.body.classList.add('tm-chatgpt-soft-opt');
    }

    refreshContainers();
    bindScroll();
    observeDom();
    ensureButton();

    // Первый запуск и повторные мягкие попытки
    scheduleApply();
    setTimeout(scheduleApply, 2500);
    setTimeout(scheduleApply, 5000);

    log('Initialized');
  }

  // SPA-навигация у ChatGPT может менять экран без полной перезагрузки
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      setTimeout(() => {
        refreshContainers();
        bindScroll();
        scheduleApply();
      }, 800);
    }
  }, 1000);

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();