/* BTM dashboard – trang Settings (anh Zon 2026-11-14): chuẩn mặc định cho mọi project + mặc định của dashboard.
   Server: src/standards.ts, GET/POST /api/standards. */
function btmSettings(d) {
  var postJson = d.postJson;
  var $ = function (id) { return document.getElementById(id); };
  var box = $('settings-section');
  if (!box) return { load: function () {} };
  var fb = $('settings-feedback');
  var fbTop = $('settings-feedback-top');
  // Thông báo hiện ở cả hai chỗ: cạnh nút Save trên tiêu đề và cạnh nút Save cuối phần Settings.
  var say = function (text, bad) { [fb, fbTop].forEach(function (e) { if (e) { e.textContent = text; e.classList.toggle('is-error', !!bad); } }); };

  function fill(data) {
    var st = data.standards || {};
    var tz = $('std-tz-value');
    if (tz && !tz.options.length) {
      Object.keys(data.timezones || {}).forEach(function (name) {
        var o = document.createElement('option');
        o.value = name;
        o.textContent = data.timezones[name] + ' · ' + name;
        tz.appendChild(o);
      });
    }
    if (tz && st.timezone) tz.value = st.timezone.value;
    $('std-tz').checked = !!(st.timezone && st.timezone.on);
    $('std-utf8').checked = !!st.utf8;
    $('std-theme').checked = !!st.theme;
    $('std-bilingual').checked = !!st.bilingual;
    $('std-custom').value = (st.custom || []).join('\n');
    var ui = data.ui || {};
    var chat = data.chat || {};
    $('chat-speakers').value = String(chat.speakers || 3);
    $('chat-lively-min').value = (chat.livelySec || [30, 60])[0];
    $('chat-lively-max').value = (chat.livelySec || [30, 60])[1];
    $('chat-normal-min').value = (chat.normalMin || [5, 8])[0];
    $('chat-normal-max').value = (chat.normalMin || [5, 8])[1];
    $('ui-lang').value = ui.lang || 'en';
    $('ui-theme').value = ui.theme || 'system';
  }

  // Trình duyệt chưa từng chọn → theo mặc định của server (giao diện; ngôn ngữ khi đã có bản dịch).
  function applyDefaults(ui) {
    if (!ui) return;
    try {
      if (!localStorage.getItem('btm-theme') && (ui.theme === 'light' || ui.theme === 'dark')) document.documentElement.setAttribute('data-theme', ui.theme);
      if (!localStorage.getItem('btm.lang') && ui.lang !== LANG && STRINGS[ui.lang]) { localStorage.setItem('btm.lang', ui.lang); location.reload(); }
    } catch (e) {}
  }

  async function load() {
    try {
      var r = await fetch('/api/standards');
      if (!r.ok) throw new Error(tx('settings.loadError'));
      var data = await r.json();
      fill(data);
      applyDefaults(data.ui);
    } catch (err) {
      say(err.message, true);
    }
  }

  // Hai nút Save (anh Zon 2026-11-14: thêm nút cạnh chữ Settings) làm cùng một việc.
  var saveButtons = [$('settings-save'), $('settings-save-top')].filter(Boolean);
  saveButtons.forEach(function (save) {
    save.addEventListener('click', async function () {
      saveButtons.forEach(function (b) { b.disabled = true; });
      try {
        var r = await postJson('/api/standards', {
          standards: {
            timezone: { on: $('std-tz').checked, value: $('std-tz-value').value },
            utf8: $('std-utf8').checked,
            theme: $('std-theme').checked,
            bilingual: $('std-bilingual').checked,
            custom: $('std-custom').value.split('\n')
          },
          ui: { lang: $('ui-lang').value, theme: $('ui-theme').value },
          chat: {
            speakers: parseInt($('chat-speakers').value, 10) || 3,
            livelySec: [Number($('chat-lively-min').value) || 30, Number($('chat-lively-max').value) || 60],
            normalMin: [Number($('chat-normal-min').value) || 5, Number($('chat-normal-max').value) || 8]
          }
        });
        fill(Object.assign({ timezones: {} }, r));
        var pending = document.querySelectorAll('#skills-candidates input:checked').length;
        say(tx('settings.saved') + (pending ? ' · ' + tx('skills.notAdded', { n: pending }) : ''), pending > 0);
      } catch (err) {
        say(err.message, true);
      } finally {
        saveButtons.forEach(function (b) { b.disabled = false; });
      }
    });
  });

  // Thu gọn phần Settings (anh Zon 2026-11-14): mặc định gọn; mở bằng mục Settings trên sidebar hoặc mũi tên;
  // đang mở mà 5 phút không đụng tới thì tự đóng, chỉ còn hàng tiêu đề.
  var SETTINGS_COLLAPSE_MS = 5 * 60 * 1000;
  var toggle = $('settings-toggle');
  var open = false;
  var timer = null;
  function arm() {
    if (timer) clearTimeout(timer);
    timer = open ? setTimeout(function () { setOpen(false); }, SETTINGS_COLLAPSE_MS) : null;
  }
  function setOpen(v) {
    open = v;
    box.classList.toggle('settings-collapsed', !open);
    if (toggle) {
      toggle.textContent = open ? '▾' : '▸';
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', tx(open ? 'settings.hide' : 'settings.show'));
      toggle.title = tx(open ? 'settings.hide' : 'settings.show');
    }
    arm();
  }
  if (toggle) toggle.addEventListener('click', function () { setOpen(!open); });
  var nav = document.querySelector('a[data-nav="settings"]');
  if (nav) nav.addEventListener('click', function () { setOpen(true); });
  ['mousemove', 'click', 'keydown', 'focusin', 'input'].forEach(function (ev) { box.addEventListener(ev, function () { if (open) arm(); }); });
  setOpen(false);
  load();
  return { load: load };
}
// end settings
