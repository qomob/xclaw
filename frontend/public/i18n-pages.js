/**
 * 静态页面中英文切换引擎（xclawskill.html / manual.html 共用）
 *
 * 用法：
 *   1. 在 <body> 中给可翻译文本元素加 data-i18n="key"（纯文本）
 *      或 data-i18n-html="key"（内含 <code> 等 HTML）
 *   2. 页面底部脚本先注册字典，再 boot():
 *        PageI18N.zh({...}); PageI18N.en({...}); PageI18N.boot();
 *   3. 切换按钮：<button data-i18n-toggle data-lang="zh">中</button>
 */
(function () {
  var STORAGE_KEY = 'xclaw_page_lang';
  var dict = { zh: {}, en: {} };
  var current = 'zh';

  function pick(key) {
    return dict[current][key] !== undefined ? dict[current][key] : (dict.zh[key] !== undefined ? dict.zh[key] : key);
  }

  function apply() {
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = pick(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      el.innerHTML = pick(el.getAttribute('data-i18n-html'));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      el.setAttribute('placeholder', pick(el.getAttribute('data-i18n-placeholder')));
    });
    var title = pick('pageTitle');
    if (title) document.title = title;
    document.documentElement.lang = current;
    document.querySelectorAll('[data-i18n-toggle]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-lang') === current);
    });
  }

  window.PageI18N = {
    zh: function (d) { Object.assign(dict.zh, d); },
    en: function (d) { Object.assign(dict.en, d); },
    set: function (lang) {
      current = lang === 'en' ? 'en' : 'zh';
      try { localStorage.setItem(STORAGE_KEY, current); } catch (e) {}
      apply();
    },
    boot: function () {
      var saved = null;
      try { saved = localStorage.getItem(STORAGE_KEY); } catch (e) {}
      if (saved !== 'zh' && saved !== 'en') {
        saved = (navigator.language || '').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
      }
      current = saved === 'en' ? 'en' : 'zh';
      apply();
    },
    get lang() { return current; }
  };
})();
