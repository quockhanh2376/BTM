/* BTM dashboard – khung Diff của ticket + ghi chú theo dòng + nút Close / Return to Dev. Tách từ app.js 2026-11-14, không đổi hành vi.
   Hàm dùng chung của app.js truyền vào qua d; thân hàm giữ nguyên thụt lề cũ. Output agent không tin cậy → chỉ textContent. */
    function btmDiff(d) {
      var clearChildren = d.clearChildren, postJson = d.postJson, showFeedback = d.showFeedback, topFeedback = d.topFeedback,
        askAsSeat = d.askAsSeat;

      // ===== Plan 6 Task 3: diff ticket + ghi chú dòng =====
      var diffTicket = null;
      async function openDiff(ticketId) {
        diffTicket = ticketId;
        var panel = document.getElementById('diff-panel');
        var body = document.getElementById('diff-body');
        var title = document.getElementById('diff-title');
        if (!panel || !body) return;
        panel.style.display = 'block';
        if (title) title.textContent = tx('diff.title', { ticket: ticketId });
        clearChildren(body);
        var loading = document.createElement('div');
        loading.className = 'empty-placeholder';
        loading.textContent = tx('diff.loading');
        body.appendChild(loading);
        panel.scrollIntoView({ block: 'start' });
        try {
          var res = await fetch('/api/tickets/' + encodeURIComponent(ticketId) + '/diff', { headers: { 'x-btm': '1' } });
          if (!res.ok) throw new Error(tx('diff.error'));
          var diff = await res.json();
          clearChildren(body);
          renderDiff(body, diff);
        } catch (err) {
          clearChildren(body);
          var e = document.createElement('div');
          e.className = 'empty-placeholder';
          e.textContent = err.message || tx('diff.error');
          body.appendChild(e);
        }
        loadDiffNotes();
      }

      function renderDiff(body, diff) {
        if (!diff || !Array.isArray(diff.files) || diff.files.length === 0) {
          var none = document.createElement('div');
          none.className = 'empty-placeholder';
          none.textContent = tx('diff.empty');
          body.appendChild(none);
          return;
        }
        if (diff.truncated) {
          var tr0 = document.createElement('div');
          tr0.className = 'seat-warnings';
          tr0.textContent = tx('diff.truncated');
          body.appendChild(tr0);
        }
        diff.files.forEach(function (f) {
          var box = document.createElement('div');
          box.className = 'diff-file';
          var name = document.createElement('div');
          name.className = 'diff-file-name';
          name.textContent = f.path + (f.binary ? ' · ' + tx('diff.binary') : '');
          box.appendChild(name);
          (f.hunks || []).forEach(function (h) {
            var hh = document.createElement('div');
            hh.className = 'diff-line diff-ctx account-detail';
            hh.textContent = h.header;
            box.appendChild(hh);
            (h.lines || []).forEach(function (l) {
              var row = document.createElement('div');
              row.className = 'diff-line ' + (l.kind === '+' ? 'diff-add' : (l.kind === '-' ? 'diff-del' : 'diff-ctx'));
              var num = document.createElement('button');
              num.type = 'button';
              num.textContent = l.newLine != null ? String(l.newLine) : '';
              if (l.newLine == null) {
                num.disabled = true;
              } else {
                num.setAttribute('aria-label', tx('diff.lineNote', { line: l.newLine }));
                num.addEventListener('click', function () { addDiffNote(f.path, l.newLine); });
              }
              row.appendChild(num);
              var txt = document.createElement('span');
              txt.className = 'diff-text';
              txt.textContent = l.text;
              row.appendChild(txt);
              box.appendChild(row);
            });
          });
          body.appendChild(box);
        });
      }

      async function addDiffNote(path, line) {
        if (!diffTicket) return;
        var text = window.prompt(tx('diff.notePrompt', { path: path, line: line }));
        if (!text || !text.trim()) return;
        try {
          var res = await postJson('/api/tickets/' + encodeURIComponent(diffTicket) + '/notes', { path: path, line: line, text: text.trim() });
          if (res && res.error) showFeedback(topFeedback, res.error, true);
          else showFeedback(topFeedback, tx('diff.noteSaved'), false);
        } catch (err) {
          showFeedback(topFeedback, err.message, true);
        }
        loadDiffNotes();
      }

      async function loadDiffNotes() {
        var box = document.getElementById('diff-notes');
        if (!box || !diffTicket) return;
        clearChildren(box);
        try {
          var res = await fetch('/api/tickets/' + encodeURIComponent(diffTicket) + '/notes', { headers: { 'x-btm': '1' } });
          var notes = res.ok ? await res.json() : [];
          var open = notes.filter(function (n) { return !n.used; });
          var h = document.createElement('div');
          h.className = 'account-detail';
          h.textContent = tx('diff.notes', { n: open.length });
          box.appendChild(h);
          open.forEach(function (n) {
            var li = document.createElement('div');
            li.className = 'account-detail';
            li.textContent = n.path + ':' + n.line + ' – ' + n.text;
            box.appendChild(li);
          });
        } catch (e) {}
      }

      var diffCloseBtn = document.getElementById('diff-close-btn');
      if (diffCloseBtn) {
        diffCloseBtn.addEventListener('click', function () {
          var panel = document.getElementById('diff-panel');
          if (panel) panel.style.display = 'none';
          diffTicket = null;
        });
      }
      var diffReturnBtn = document.getElementById('diff-return-btn');
      if (diffReturnBtn) {
        diffReturnBtn.addEventListener('click', async function () {
          if (!diffTicket) return;
          if (!(await askAsSeat('dev', { text: tx('ask.return', { ticket: diffTicket }), note: tx('ask.returnNote'), ok: tx('ask.returnOk'), cancel: tx('ask.notYet') }))) return;
          try {
            var res = await postJson('/api/tickets/' + encodeURIComponent(diffTicket) + '/return', {});
            if (res && res.error) showFeedback(topFeedback, res.error, true);
            else showFeedback(topFeedback, tx('diff.returned', { ticket: diffTicket }), false);
          } catch (err) {
            showFeedback(topFeedback, err.message, true);
          }
        });
      }

      return { openDiff: openDiff };
    }
