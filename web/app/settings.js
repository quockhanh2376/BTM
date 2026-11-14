/* BTM dashboard – trang Settings (anh Zon 2026-11-14): chuẩn mặc định cho mọi project + mặc định của dashboard.
   Server: src/standards.ts, GET/POST /api/standards. */
function btmSettings(d) {
  var postJson = d.postJson;
  var $ = function (id) { return document.getElementById(id); };
  var box = $('settings-section');
  if (!box) return { load: function () {} };
  var fb = $('settings-feedback');
  var say = function (text, bad) { if (fb) { fb.textContent = text; fb.classList.toggle('is-error', !!bad); } };

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

  var save = $('settings-save');
  if (save) {
    save.addEventListener('click', async function () {
      save.disabled = true;
      try {
        var r = await postJson('/api/standards', {
          standards: {
            timezone: { on: $('std-tz').checked, value: $('std-tz-value').value },
            utf8: $('std-utf8').checked,
            theme: $('std-theme').checked,
            bilingual: $('std-bilingual').checked,
            custom: $('std-custom').value.split('\n')
          },
          ui: { lang: $('ui-lang').value, theme: $('ui-theme').value }
        });
        fill(Object.assign({ timezones: {} }, r));
        say(tx('settings.saved'), false);
      } catch (err) {
        say(err.message, true);
      } finally {
        save.disabled = false;
      }
    });
  }
  load();
  return { load: load };
}
// end settings
