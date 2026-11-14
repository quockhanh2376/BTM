/* BTM dashboard – Skills trong trang Settings (anh Zon 2026-11-14): thêm skill (dán / GitHub), xem kết quả kiểm bảo mật
   (Core quét → Boss → Finn kiểm chéo), gán ghế + project, bật tắt. Server: src/skills/*, /api/skills.
   Nội dung skill và kết quả kiểm là dữ liệu không tin cậy → chỉ textContent. */
var SKILL_STATUS = { checking: 'skills.status.checking', approved: 'skills.status.approved', rejected: 'skills.status.rejected' };
var SKILL_SEATS = ['pm', 'dev', 'qc', 'audit'];

// Dòng tóm tắt cổng bảo mật của một skill (thuần, test được).
function skillChecks(s) {
  var out = [];
  var scan = s.scan || [];
  var worst = scan.some(function (f) { return f.severity === 'high'; }) ? 'high' : (scan.some(function (f) { return f.severity === 'medium'; }) ? 'medium' : (scan.length ? 'low' : 'none'));
  out.push({ who: 'core', ok: worst !== 'high', worst: worst, count: scan.length });
  (s.reviews || []).forEach(function (r) { out.push({ who: r.agent, ok: r.verdict === 'safe', summary: r.summary || '', count: (r.risks || []).length }); });
  return out;
}

function btmSkills(d) {
  var postJson = d.postJson, askOwner = d.askOwner, agentLabel = d.agentLabel, SEAT_LABELS = d.SEAT_LABELS;
  var $ = function (id) { return document.getElementById(id); };
  var list = $('skills-list');
  if (!list) return { load: function () {} };
  var fb = $('skills-feedback');
  var say = function (text, bad) { if (fb) { fb.textContent = text; fb.classList.toggle('is-error', !!bad); } };
  var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  var pollTimer = null;

  async function act(body) {
    try {
      var r = await postJson('/api/skills', body);
      await load();
      return r;
    } catch (err) {
      say(err.message, true);
      return null;
    }
  }

  function renderSkill(s, data) {
    var card = el('div', 'skill-card skill-' + s.status);
    var head = el('div', 'skill-head');
    head.appendChild(el('span', 'skill-name', s.name));
    head.appendChild(el('span', 'skill-badge', tx(SKILL_STATUS[s.status] || 'skills.status.checking')));
    if (data.suggested.indexOf(s.id) >= 0) head.appendChild(el('span', 'skill-fit', tx('skills.fits', { key: data.project.key || '—' })));
    card.appendChild(head);
    if (s.description) card.appendChild(el('div', 'skill-desc', s.description));
    card.appendChild(el('div', 'skill-meta', tx('skills.meta', { source: s.source, chars: s.chars, license: s.license || '—', date: String(s.version || '').slice(0, 10) })));

    // Cổng bảo mật: Core quét + từng người kiểm.
    var checks = el('div', 'skill-checks');
    skillChecks(s).forEach(function (c) {
      var text = c.who === 'core'
        ? tx('skills.core', { count: c.count, worst: c.worst })
        : agentLabel(c.who) + ': ' + tx(c.ok ? 'skills.safe' : 'skills.unsafe') + (c.summary ? ' – ' + c.summary : '');
      checks.appendChild(el('div', 'skill-check ' + (c.ok ? 'ok' : 'bad'), (c.ok ? '✓ ' : '✗ ') + text));
    });
    if (s.note) checks.appendChild(el('div', 'skill-note', s.note));
    var risks = (s.scan || []).concat.apply(s.scan || [], (s.reviews || []).map(function (r) { return r.risks || []; }));
    risks.slice(0, 6).forEach(function (f) {
      checks.appendChild(el('div', 'skill-risk sev-' + f.severity, '[' + f.severity + '] ' + f.text + (f.quote ? ' — “' + f.quote + '”' : '')));
    });
    card.appendChild(checks);

    // Ghế + project + bật tắt (chỉ skill đã duyệt mới bật được).
    var ctl = el('div', 'skill-controls');
    SKILL_SEATS.forEach(function (seat) {
      var lab = el('label', 'skill-seat');
      var cb = el('input');
      cb.type = 'checkbox';
      cb.checked = (s.seats || []).indexOf(seat) >= 0;
      cb.addEventListener('change', function () {
        var seats = SKILL_SEATS.filter(function (x) { return x === seat ? cb.checked : (s.seats || []).indexOf(x) >= 0; });
        act({ action: 'update', id: s.id, seats: seats });
      });
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(' ' + (SEAT_LABELS[seat] || seat)));
      ctl.appendChild(lab);
    });
    var key = data.project.key;
    if (key) {
      var only = el('label', 'skill-seat');
      var ocb = el('input');
      ocb.type = 'checkbox';
      ocb.checked = s.projects !== 'all';
      ocb.addEventListener('change', function () {
        // Tick: chỉ project đang mở (giữ các project khác đã chọn trước đó). Bỏ tick: mọi project.
        var keep = s.projects === 'all' ? [] : s.projects;
        act({ action: 'update', id: s.id, projects: ocb.checked ? keep.concat(keep.indexOf(key) >= 0 ? [] : [key]) : 'all' });
      });
      only.appendChild(ocb);
      only.appendChild(document.createTextNode(' ' + (s.projects === 'all' ? tx('skills.onlyProject', { key: key }) : tx('skills.onlyProjects', { keys: s.projects.join(', ') }))));
      ctl.appendChild(only);
    }
    var on = el('label', 'skill-seat skill-on');
    var oncb = el('input');
    oncb.type = 'checkbox';
    oncb.checked = !!s.on;
    oncb.disabled = s.status !== 'approved';
    oncb.addEventListener('change', function () { act({ action: 'update', id: s.id, on: oncb.checked }); });
    on.appendChild(oncb);
    on.appendChild(document.createTextNode(' ' + tx('skills.on')));
    ctl.appendChild(on);
    card.appendChild(ctl);

    var actions = el('div', 'skill-actions');
    var view = el('a', 'btn btn-sm btn-secondary', tx('skills.view'));
    view.href = '/api/skills/' + s.id + '/text';
    view.target = '_blank';
    view.rel = 'noopener';
    actions.appendChild(view);
    var re = el('button', 'btn btn-sm btn-secondary', tx('skills.recheck'));
    re.type = 'button';
    re.addEventListener('click', function () { act({ action: 'recheck', id: s.id }); });
    actions.appendChild(re);
    var del = el('button', 'btn btn-sm btn-secondary', tx('skills.delete'));
    del.type = 'button';
    del.addEventListener('click', async function () {
      if (await askOwner({ who: tx('skills.title'), text: tx('skills.deleteAsk', { name: s.name }), ok: tx('skills.delete'), cancel: tx('ask.keepIt') })) act({ action: 'delete', id: s.id });
    });
    actions.appendChild(del);
    card.appendChild(actions);
    return card;
  }

  async function load() {
    try {
      var r = await fetch('/api/skills');
      if (!r.ok) throw new Error(tx('skills.loadError'));
      var data = await r.json();
      while (list.firstChild) list.removeChild(list.firstChild);
      var who = $('skills-reviewers');
      if (who) who.textContent = data.reviewers.length >= 2 ? tx('skills.reviewers', { a: data.reviewers[0], b: data.reviewers[1] }) : tx('skills.reviewersMissing');
      if (!data.skills.length) list.appendChild(el('div', 'empty-placeholder', tx('skills.empty')));
      data.skills.forEach(function (s) { list.appendChild(renderSkill(s, data)); });
      // Đang có skill chờ kiểm → tự nạp lại mỗi 10 giây.
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
      if (data.skills.some(function (s) { return s.status === 'checking'; })) pollTimer = setTimeout(load, 10000);
    } catch (err) {
      say(err.message, true);
    }
  }

  var pasteBtn = $('skills-paste-btn');
  if (pasteBtn) pasteBtn.addEventListener('click', async function () {
    var ta = $('skills-paste');
    if (!ta.value.trim()) { say(tx('skills.pasteEmpty'), true); return; }
    var r = await act({ action: 'paste', text: ta.value });
    if (r) { ta.value = ''; say(tx('skills.added', { name: r.skill.name }), false); }
  });

  var findBtn = $('skills-url-btn');
  var cands = $('skills-candidates');
  if (findBtn && cands) findBtn.addEventListener('click', async function () {
    var url = $('skills-url').value.trim();
    if (!url) return;
    findBtn.disabled = true;
    while (cands.firstChild) cands.removeChild(cands.firstChild);
    try {
      var r = await postJson('/api/skills', { action: 'github-list', url: url });
      r.candidates.forEach(function (c) {
        var lab = el('label', 'skill-cand');
        var cb = el('input');
        cb.type = 'checkbox';
        cb.value = c.path;
        cb.disabled = c.chars > 8000;
        lab.appendChild(cb);
        lab.appendChild(document.createTextNode(' ' + c.name + ' · ' + c.chars + (c.chars > 8000 ? ' ' + tx('skills.tooLong') : '') + (c.license ? ' · ' + c.license : '') + (c.description ? ' — ' + c.description : '')));
        cands.appendChild(lab);
      });
      var imp = el('button', 'btn btn-sm btn-primary', tx('skills.import'));
      imp.type = 'button';
      imp.addEventListener('click', async function () {
        var paths = Array.prototype.slice.call(cands.querySelectorAll('input:checked')).map(function (x) { return x.value; });
        if (!paths.length) return;
        var res = await act({ action: 'github-import', url: url, paths: paths });
        if (res) {
          say(tx('skills.imported', { n: res.added.length }) + (res.failed.length ? ' · ' + res.failed.map(function (f) { return f.path + ': ' + f.error; }).join('; ') : ''), res.failed.length > 0);
          while (cands.firstChild) cands.removeChild(cands.firstChild);
        }
      });
      cands.appendChild(imp);
    } catch (err) {
      say(err.message, true);
    } finally {
      findBtn.disabled = false;
    }
  });

  load();
  return { load: load };
}
// end skills
