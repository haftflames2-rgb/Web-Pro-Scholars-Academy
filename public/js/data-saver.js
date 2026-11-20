/* SMARTTEP ACADEMY V68: user-controlled low-data preferences. */
(() => {
  'use strict';
  const KEY = 'smarttep_data_saver_v68';
  const enabled = () => localStorage.getItem(KEY) === 'on';
  function apply() {
    const on = enabled();
    document.documentElement.classList.toggle('smarttep-data-saver', on);
    document.querySelectorAll('video').forEach(v => {
      if (on) { if (!v.dataset.v68Preload) v.dataset.v68Preload = v.getAttribute('preload') || 'metadata'; v.preload = 'none'; }
      else if (v.dataset.v68Preload) { v.preload = v.dataset.v68Preload; delete v.dataset.v68Preload; }
    });
    const b = document.getElementById('v68DataSaverToggle');
    if (b) { b.textContent = on ? 'Turn data saver off' : 'Turn data saver on'; b.setAttribute('aria-pressed', String(on)); }
    const s = document.getElementById('v68DataSaverStatus');
    if (s) s.textContent = on ? 'Data saver is on: videos will not preload automatically. Images and advertisements remain available.' : 'Data saver is off.';
  }
  function install() {
    if (!document.body || document.getElementById('v68DataSaverPanel')) return;
    const panel = document.createElement('section');
    panel.className = 'panel'; panel.id = 'v68DataSaverPanel';
    panel.innerHTML = '<h2>📶 Low-Data & Offline Tools</h2><p>Reduce unnecessary data use by preventing videos from preloading. You can also open the offline information page.</p><button type="button" class="btn" id="v68DataSaverToggle"></button> <a class="btn secondary" href="/offline.html">Offline information</a><p id="v68DataSaverStatus" class="help-text" aria-live="polite"></p><p class="help-text">Important: student accounts, lessons, exams, payments, live classes and other private or changing information still require an internet connection. This feature does not download course lessons for offline study.</p>';
    const main = document.querySelector('main');
    if (main) main.insertBefore(panel, main.children[2] || null);
    document.getElementById('v68DataSaverToggle').addEventListener('click', () => { localStorage.setItem(KEY, enabled() ? 'off' : 'on'); apply(); });
    apply();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install); else install();
  window.addEventListener('online', apply);
})();
