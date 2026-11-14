/* BTM dashboard – Họp tranh luận trong Meeting room (anh Zon 2026-11-14): biên bản, nút Stop / Resume / Conclude / Close,
   zoom chữ. Spec: docs/superpowers/specs/2026-11-14-debate-meeting-design.md. Output agent không tin cậy → chỉ textContent. */

// Mục của cuộc họp cho khung chat (thuần, test được): đầu cuộc họp, từng lượt + ghi chú của anh theo giờ, kết luận.
function meetItems(m) {
  if (!m || !m.id) return [];
  var out = [{ kind: 'meet-head', id: 'M' + m.id, status: m.status, at: m.createdAt, text: m.topic, source: m.source || '', note: m.materialNote || '', quick: !!m.quick, docs: m.docs || [] }];
  var mid = [];
  (m.turns || []).forEach(function (t) {
    mid.push({ kind: 'meet-turn', id: 'M' + m.id + '-' + t.round + '-' + t.agent, status: t.skipped ? 'skip' : 'ok', at: t.at, round: t.round, agent: t.agent, seats: t.seats || [], points: t.points || [], skipped: t.skipped || '' });
  });
  (m.ownerNotes || []).forEach(function (n, i) {
    mid.push({ kind: 'meet-note', id: 'M' + m.id + '-note-' + i, status: 'ok', at: n.at, text: n.text });
  });
  mid.sort(function (a, b) { return Date.parse(a.at) - Date.parse(b.at); });
  out = out.concat(mid);
  if (m.conclusion) out.push({ kind: 'meet-end', id: 'M' + m.id + '-end', status: 'ok', at: m.conclusion.at, by: m.conclusion.by, c: m.conclusion });
  else if (m.conclusionSkipped) out.push({ kind: 'meet-end', id: 'M' + m.id + '-end', status: 'skip', at: m.endedAt || '', by: '', skipped: m.conclusionSkipped });
  return out;
}

// Nhãn dẫn chứng: true = Core kiểm thấy, false = không thấy, null = kiến thức chung.
function meetEvidenceMark(v) {
  return v === true ? '✓' : '⚠';
}

var MEET_STATUS = { running: 'meet.status.running', paused: 'meet.status.paused', done: 'meet.status.done', closed: 'meet.status.closed' };

function btmMeeting(d) {
  var agentLabel = d.agentLabel, formatHHmm = d.formatHHmm, postJson = d.postJson, showFeedback = d.showFeedback, feedbackEl = d.feedbackEl;
  var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  // Vẽ một mục của cuộc họp vào <li>.
  function renderMeetItem(li, it) {
    if (it.kind === 'meet-head') {
      li.className = 'msg-divider meet-head';
      li.textContent = tx('meet.head', { id: it.id, status: tx(MEET_STATUS[it.status] || 'meet.status.closed') }) + (it.quick ? ' · ' + tx('meet.quick') : '');
      var topic = el('div', 'meet-topic', it.text);
      li.appendChild(topic);
      if (it.source) li.appendChild(el('div', 'meet-source', tx('meet.material', { source: it.source, note: it.note })));
      if (it.docs && it.docs.length) li.appendChild(el('div', 'meet-source', tx('meet.docs', { list: it.docs.map(function (x) { return x.name + ' (' + x.note + ')'; }).join('; ') })));
      return;
    }
    if (it.kind === 'meet-note') {
      li.className = 'msg msg-owner';
      li.appendChild(el('div', 'msg-head', tx('hist.owner') + ' · ' + formatHHmm(it.at)));
      li.appendChild(el('div', 'msg-body', it.text));
      return;
    }
    if (it.kind === 'meet-turn') {
      li.className = 'msg msg-team meet-turn' + (it.skipped ? ' meet-skipped' : '');
      li.appendChild(el('div', 'msg-head', agentLabel(it.agent) + ' · ' + it.seats.join('+').toUpperCase() + ' · ' + tx(it.round === 1 ? 'meet.round1' : 'meet.round2') + ' · ' + formatHHmm(it.at)));
      if (it.skipped) { li.appendChild(el('div', 'msg-body', tx('meet.skipped', { reason: it.skipped }))); return; }
      it.points.forEach(function (p, i) {
        var row = el('div', 'meet-point');
        row.appendChild(el('div', 'msg-body', (i + 1) + '. ' + (p.target ? tx('meet.rebut', { to: p.target }) + ' ' : '') + p.text));
        var ev = p.evidence || {};
        var evEl = el('div', 'meet-evidence ' + (p.verified === true ? 'ev-ok' : 'ev-warn'),
          meetEvidenceMark(p.verified) + ' ' + tx(p.verified === true ? 'meet.verified' : (p.verified === false ? 'meet.unverified' : 'meet.general'))
          + ' · ' + (ev.type || '') + ' ' + (ev.ref || '') + (ev.quote ? ' — “' + ev.quote + '”' : ''));
        row.appendChild(evEl);
        li.appendChild(row);
      });
      return;
    }
    // meet-end
    li.className = 'msg msg-team meet-end';
    li.appendChild(el('div', 'msg-head', tx('meet.conclusion') + (it.by ? ' · ' + agentLabel(it.by) : '') + (it.at ? ' · ' + formatHHmm(it.at) : '')));
    if (it.skipped) { li.appendChild(el('div', 'msg-body', tx('meet.skipped', { reason: it.skipped }))); return; }
    var c = it.c || {};
    var block = function (key, list) {
      if (!list || !list.length) return;
      li.appendChild(el('div', 'meet-label', tx(key)));
      list.forEach(function (x) { li.appendChild(el('div', 'msg-body', '• ' + x)); });
    };
    block('meet.agreed', c.agreed);
    block('meet.disputed', c.disputed);
    if (c.recommendation) { li.appendChild(el('div', 'meet-label', tx('meet.recommend'))); li.appendChild(el('div', 'msg-body', c.recommendation)); }
    block('meet.questions', c.questions);
  }

  // Thanh điều khiển cuộc họp phía trên khung chat.
  var bar = document.getElementById('meet-bar');
  var lastKey = '';
  async function act(action, extra) {
    try {
      await postJson('/api/meeting', Object.assign({ action: action }, extra || {}));
    } catch (err) {
      showFeedback(feedbackEl, err.message, true);
    }
  }
  function paint(state) {
    if (!bar) return;
    var m = state && state.meeting;
    var key = m ? [m.id, m.status, (m.turns || []).length, !!m.conclusion].join('|') : '';
    if (key === lastKey) return;
    lastKey = key;
    while (bar.firstChild) bar.removeChild(bar.firstChild);
    bar.hidden = !m;
    loadDocs(); // mở cuộc họp xong thì khu chờ tài liệu được dọn
    if (!m) return;
    var total = m.speakers.length * (m.quick ? 1 : 2) + 1;
    bar.appendChild(el('span', 'meet-bar-status', tx('meet.bar', { id: m.id, status: tx(MEET_STATUS[m.status] || 'meet.status.closed'), done: (m.turns || []).length + (m.conclusion ? 1 : 0), total: total })));
    var btn = function (key, cls, fn) { var b = el('button', 'btn btn-sm ' + cls, tx(key)); b.type = 'button'; b.addEventListener('click', fn); bar.appendChild(b); return b; };
    if (m.status === 'running') {
      btn('meet.stop', 'btn-danger', function () { act('stop'); });
    } else if (m.status === 'paused') {
      var note = el('input', 'meet-note-input');
      note.type = 'text';
      note.maxLength = 1000;
      note.placeholder = tx('meet.notePh');
      note.setAttribute('aria-label', tx('meet.notePh'));
      bar.appendChild(note);
      btn('meet.resume', 'btn-primary', function () { act('resume', { note: note.value }); });
      btn('meet.concludeNow', 'btn-secondary', function () { act('conclude', { note: note.value }); });
    }
    if (m.status === 'running' || m.status === 'paused') btn('meet.close', 'btn-secondary', function () { act('close'); });
    // Xuất biên bản (anh Zon 2026-11-14): Markdown, hoặc HTML (mở bằng trình duyệt → in ra PDF; Word cũng mở được).
    [['md', 'meet.exportMd'], ['html', 'meet.exportHtml'], ['docx', 'meet.exportDocx']].forEach(function (f) {
      var a = el('a', 'btn btn-sm btn-secondary', tx(f[1]));
      a.href = '/api/meetings/' + m.id + '/export.' + f[0];
      a.setAttribute('download', 'meeting-M' + m.id + '.' + f[0]);
      bar.appendChild(a);
    });
    if (m.status === 'done' && m.conclusion && m.conclusion.recommendation) {
      btn('meet.makeGoal', 'btn-primary', function () {
        // Điền sẵn Command gửi PM; anh sửa rồi mới gửi.
        var ta = document.getElementById('cmd-text');
        var pm = document.querySelector('input[name="cmd-to"][value="pm"]');
        if (pm) { pm.checked = true; pm.dispatchEvent(new Event('change', { bubbles: true })); }
        if (ta) { ta.value = (tx('meet.goalPrefix', { id: m.id }) + ' ' + m.conclusion.recommendation).slice(0, 2000); ta.focus(); }
      });
    }
  }

  // Tài liệu cho cuộc họp sắp mở (bước 2): upload từng file, Core rút chữ; danh sách chờ có nút bỏ.
  var docList = document.getElementById('meet-docs-list');
  var docInput = document.getElementById('meet-doc-input');
  var DOC_MAX = 20 * 1024 * 1024;
  function renderDocs(docs) {
    if (!docList) return;
    while (docList.firstChild) docList.removeChild(docList.firstChild);
    docList.hidden = !docs || !docs.length;
    (docs || []).forEach(function (doc) {
      var chip = el('span', 'meet-doc-chip', doc.name + ' · ' + doc.note);
      var x = el('button', 'meet-doc-remove', '✕');
      x.type = 'button';
      x.setAttribute('aria-label', tx('meet.docRemove', { name: doc.name }));
      x.title = tx('meet.docRemove', { name: doc.name });
      x.addEventListener('click', async function () {
        try { var r = await postJson('/api/meeting/doc', { action: 'remove', id: doc.id }); renderDocs(r.docs); } catch (err) { showFeedback(feedbackEl, err.message, true); }
      });
      chip.appendChild(x);
      docList.appendChild(chip);
    });
  }
  async function loadDocs() {
    if (!docList) return;
    try { var r = await fetch('/api/meeting/docs'); renderDocs(r.ok ? (await r.json()).docs : []); } catch (e) { renderDocs([]); }
  }
  function readBase64(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { var s = String(fr.result || ''); resolve(s.slice(s.indexOf(',') + 1)); };
      fr.onerror = function () { reject(new Error(tx('meet.docReadError'))); };
      fr.readAsDataURL(file);
    });
  }
  if (docInput) {
    docInput.addEventListener('change', async function () {
      var files = Array.prototype.slice.call(docInput.files || []);
      docInput.value = '';
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        try {
          if (f.size > DOC_MAX) throw new Error(tx('meet.docTooBig'));
          showFeedback(feedbackEl, tx('meet.docUploading', { name: f.name }), false);
          var r = await postJson('/api/meeting/doc', { action: 'add', name: f.name, base64: await readBase64(f) });
          renderDocs(r.docs);
          showFeedback(feedbackEl, tx('meet.docAdded', { name: f.name, note: r.doc.note }), false);
        } catch (err) {
          showFeedback(feedbackEl, f.name + ': ' + err.message, true);
        }
      }
    });
  }
  loadDocs();

  // Dọn Meeting room (anh Zon 2026-11-14): ẩn tin cũ trước khi họp / thử tranh luận nháp; tin vẫn lưu, bấm "Hiện lại" để xem.
  var clearBtn = document.getElementById('room-clear');
  if (clearBtn) clearBtn.addEventListener('click', async function () {
    clearBtn.disabled = true;
    try { await postJson('/api/meeting-room', { action: 'clear' }); } catch (err) { showFeedback(feedbackEl, err.message, true); } finally { clearBtn.disabled = false; }
  });

  // Zoom chữ trong Meeting room (anh Zon 2026-11-14): A− / A+, nhớ theo trình duyệt.
  (function () {
    var list = document.getElementById('queue-list');
    var minus = document.getElementById('chat-zoom-out');
    var plus = document.getElementById('chat-zoom-in');
    if (!list || !minus || !plus) return;
    var STEPS = [1, 1.15, 1.3, 1.5, 1.75, 2];
    var i = 0;
    try { i = Math.max(0, Math.min(STEPS.length - 1, parseInt(window.localStorage.getItem('btm.chatZoom') || '0', 10) || 0)); } catch (e) {}
    function apply() {
      list.style.setProperty('--chat-zoom', String(STEPS[i]));
      minus.disabled = i === 0;
      plus.disabled = i === STEPS.length - 1;
      try { window.localStorage.setItem('btm.chatZoom', String(i)); } catch (e) {}
    }
    minus.addEventListener('click', function () { if (i > 0) { i--; apply(); } });
    plus.addEventListener('click', function () { if (i < STEPS.length - 1) { i++; apply(); } });
    apply();
  })();

  return { renderMeetItem: renderMeetItem, paint: paint };
}
// end meeting
