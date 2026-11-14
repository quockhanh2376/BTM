/* BTM dashboard – khung Questions (câu hỏi chặn ticket: ô trả lời, ảnh kèm, nút "để PM trả lời"). Tách từ app.js 2026-11-14, không đổi hành vi.
   Hàm dùng chung của app.js truyền vào qua d; snapshot mới nhất đọc qua d.getSnapshot(); thân hàm giữ nguyên thụt lề cũ. */
    function btmQuestions(d) {
      var showFeedback = d.showFeedback, topFeedback = d.topFeedback, agentLabel = d.agentLabel, postJson = d.postJson,
        clearChildren = d.clearChildren, SEAT_LABELS = d.SEAT_LABELS, getSnapshot = d.getSnapshot;

      // ===== Plan 6 Task 4: câu hỏi chặn ticket =====
      // Bản nháp trả lời + ảnh kèm theo từng câu hỏi: giữ lại qua mỗi lần vẽ lại danh sách (poll).
      var qDrafts = {};
      var qImages = {};

      // Mượn icon tĩnh của ô Command (📎, mũi tên gửi) + chữ cho trình đọc màn hình.
      function iconFrom(sel, el, label) {
        var svg = document.querySelector(sel);
        if (svg) el.appendChild(svg.cloneNode(true));
        var sr = document.createElement('span');
        sr.className = 'sr-only';
        sr.textContent = label;
        el.appendChild(sr);
      }

      function readAnswerImage(qId, file, done) {
        if (!file) return;
        if (['image/png', 'image/jpeg', 'image/webp'].indexOf(file.type) < 0) {
          showFeedback(topFeedback, tx('cmd.imageType'), true);
          return;
        }
        if (file.size > 5 * 1024 * 1024) {
          showFeedback(topFeedback, tx('cmd.imageSize'), true);
          return;
        }
        var r = new FileReader();
        r.onload = function (e) {
          var dataUrl = String(e.target.result || '');
          var comma = dataUrl.indexOf(',');
          qImages[qId] = { dataUrl: dataUrl, base64: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl, name: file.name || 'image.png' };
          done();
        };
        r.readAsDataURL(file);
      }

      // Nút "Để Finn trả lời" (anh Zon 2026-11-14): một lượt PM chỉ đọc, xong hết thì tự Resume.
      (function () {
        var b = document.getElementById('q-delegate');
        if (!b) return;
        b.addEventListener('click', async function () {
          var latestSnapshot = getSnapshot();
          var pm = latestSnapshot && (latestSnapshot.seats || []).filter(function (s) { return s.seat === 'pm'; })[0];
          var name = agentLabel(pm ? pm.agent : 'pm');
          b.disabled = true;
          try {
            var res = await postJson('/api/questions/delegate', {});
            if (res && res.error) showFeedback(topFeedback, res.error, true);
            else showFeedback(topFeedback, tx('q.delegateSent', { name: name }), false);
          } catch (err) {
            showFeedback(topFeedback, err.message, true);
          } finally {
            b.disabled = false;
          }
        });
      })();

      // Anh Zon 2026-11-14: nhiều câu hỏi của cùng ticket → một ô trả lời. Gõ "1. … 2. …" đủ số câu thì tách riêng
      // từng câu; không thì cùng một câu trả lời cho mọi câu hỏi.
      function splitAnswers(text, n) {
        var t = String(text || '').trim();
        if (n <= 1) return [t];
        var parts = {};
        var re = /(?:^|\n)\s*(\d{1,2})\s*[.):]\s*/g;
        var marks = [];
        var m;
        while ((m = re.exec(t))) marks.push({ n: parseInt(m[1], 10), start: m.index, body: re.lastIndex });
        marks.forEach(function (k, i) {
          var end = i + 1 < marks.length ? marks[i + 1].start : t.length;
          if (k.n >= 1 && k.n <= n && !parts[k.n]) parts[k.n] = t.slice(k.body, end).trim();
        });
        var out = [];
        for (var i = 1; i <= n; i++) {
          if (!parts[i]) return Array.apply(null, Array(n)).map(function () { return t; });
          out.push(parts[i]);
        }
        return out;
      }
      function groupQuestions(questions) {
        var groups = [];
        var byTicket = {};
        questions.forEach(function (q) {
          var k = q.ticket + '|' + q.seat;
          if (!byTicket[k]) { byTicket[k] = []; groups.push(byTicket[k]); }
          byTicket[k].push(q);
        });
        return groups;
      }

      function renderQuestions(questions) {
        var latestSnapshot = getSnapshot();
        var section = document.getElementById('questions-section');
        var dlg = document.getElementById('q-delegate-label');
        if (dlg) {
          var pmSeat = latestSnapshot && (latestSnapshot.seats || []).filter(function (s) { return s.seat === 'pm'; })[0];
          dlg.textContent = tx('q.delegate', { name: agentLabel(pmSeat ? pmSeat.agent : 'pm') || 'PM' });
        }
        var list = document.getElementById('questions-list');
        if (!section || !list) return;
        var active = document.activeElement;
        if (active && list.contains(active) && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) return;
        clearChildren(list);
        if (!Array.isArray(questions) || questions.length === 0) {
          section.style.display = 'none';
          return;
        }
        section.style.display = 'block';
        groupQuestions(questions).forEach(function (qs) {
          var q = { id: qs.map(function (x) { return x.id; }).join('-'), ticket: qs[0].ticket, seat: qs[0].seat, agent: qs[0].agent };
          var item = document.createElement('div');
          item.className = 'question-item';
          var head = document.createElement('div');
          head.className = 'account-detail';
          head.textContent = tx('q.from', { ticket: q.ticket, seat: SEAT_LABELS[q.seat] || q.seat, agent: q.agent || '—' });
          item.appendChild(head);
          qs.forEach(function (x, i) {
            var text = document.createElement('div');
            text.className = 'q-text';
            text.textContent = (qs.length > 1 ? (i + 1) + '. ' : '') + x.text;
            item.appendChild(text);
          });
          if (qs.length > 1) {
            var hint = document.createElement('div');
            hint.className = 'account-detail q-hint';
            hint.textContent = tx('q.multiHint', { n: qs.length });
            item.appendChild(hint);
          }
          // Ô trả lời kiểu khung Command: chữ + ảnh nằm chung trong một khung.
          var compose = document.createElement('div');
          compose.className = 'cmd-composer q-compose';
          var area = document.createElement('textarea');
          area.className = 'form-textarea cmd-composer-text';
          area.rows = 2;
          area.maxLength = 2000;
          area.placeholder = tx('q.placeholder');
          area.setAttribute('aria-label', tx('q.answerFor', { id: q.id }));
          area.value = qDrafts[q.id] || '';
          area.addEventListener('input', function () { qDrafts[q.id] = area.value; });
          compose.appendChild(area);

          // Ảnh kèm câu trả lời (không bắt buộc): dán (Ctrl+V) vào ô hoặc bấm 📎; xem trước + nút bỏ ảnh.
          var bar = document.createElement('div');
          bar.className = 'cmd-composer-bar q-attach-bar';
          var fileId = 'q-image-' + q.id;
          var fileInput = document.createElement('input');
          fileInput.type = 'file';
          fileInput.id = fileId;
          fileInput.accept = 'image/png,image/jpeg,image/webp';
          fileInput.className = 'sr-only';
          var attach = document.createElement('label');
          attach.htmlFor = fileId;
          attach.className = 'cmd-icon-btn';
          attach.title = tx('q.attach');
          iconFrom('#attach-image-label svg', attach, tx('q.attach'));
          var preview = document.createElement('span');
          preview.className = 'q-attach-preview';
          function showPreview() {
            clearChildren(preview);
            var im = qImages[q.id];
            if (!im) return;
            var img = document.createElement('img');
            img.src = im.dataUrl;
            img.alt = tx('q.imageAlt', { id: q.id });
            var rm = document.createElement('button');
            rm.type = 'button';
            rm.className = 'btn btn-secondary btn-sm';
            rm.textContent = '✕';
            rm.setAttribute('aria-label', tx('q.removeImage'));
            rm.addEventListener('click', function () { delete qImages[q.id]; fileInput.value = ''; showPreview(); });
            preview.appendChild(img);
            preview.appendChild(rm);
          }
          fileInput.addEventListener('change', function () {
            if (fileInput.files && fileInput.files[0]) readAnswerImage(q.id, fileInput.files[0], showPreview);
          });
          area.addEventListener('paste', function (e) {
            var items = e.clipboardData && e.clipboardData.items;
            if (!items) return;
            for (var i = 0; i < items.length; i++) {
              if (items[i].type && items[i].type.indexOf('image/') === 0) {
                var f = items[i].getAsFile();
                if (f) { e.preventDefault(); readAnswerImage(q.id, f, showPreview); break; }
              }
            }
          });
          // Nút gửi = mũi tên như ô Command, nằm góc phải trong khung.
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'cmd-icon-btn cmd-send-icon';
          btn.title = tx('q.answer');
          iconFrom('#cmd-send-btn svg', btn, tx('q.answer'));
          bar.appendChild(fileInput);
          bar.appendChild(attach);
          bar.appendChild(preview);
          bar.appendChild(btn);
          compose.appendChild(bar);
          // Nút ✕ góc phải trên: xoá chữ + ảnh đang soạn để anh trả lời lại (anh Zon 2026-11-14).
          var clearBtn = document.createElement('button');
          clearBtn.type = 'button';
          clearBtn.className = 'q-clear';
          clearBtn.textContent = '✕';
          clearBtn.title = tx('q.clear');
          clearBtn.setAttribute('aria-label', tx('q.clear'));
          clearBtn.addEventListener('click', function () {
            area.value = '';
            delete qDrafts[q.id];
            delete qImages[q.id];
            fileInput.value = '';
            showPreview();
            area.focus();
          });
          compose.appendChild(clearBtn);
          item.appendChild(compose);
          showPreview();
          area.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !btn.disabled) { e.preventDefault(); btn.click(); }
          });

          btn.addEventListener('click', async function () {
            // Chỉ có ảnh, chưa gõ chữ: vẫn gửi được, kèm câu mặc định (server cần chữ).
            var answerText = area.value.trim() || (qImages[q.id] ? tx('q.seeImage') : '');
            if (!answerText) { area.focus(); return; }
            var answers = splitAnswers(answerText, qs.length);
            btn.disabled = true;
            try {
              var res = null;
              for (var i = 0; i < qs.length && !(res && res.error); i++) {
                var payload = { text: answers[i] || answerText };
                if (qImages[q.id]) payload.image = { base64: qImages[q.id].base64 };
                res = await postJson('/api/questions/' + qs[i].id + '/answer', payload);
              }
              if (res && res.error) showFeedback(topFeedback, res.error, true);
              else {
                delete qDrafts[q.id];
                delete qImages[q.id];
                showFeedback(topFeedback, tx('q.answered'), false);
              }
            } catch (err) {
              showFeedback(topFeedback, err.message, true);
            } finally {
              btn.disabled = false;
            }
          });
          list.appendChild(item);
        });
      }

      return { renderQuestions: renderQuestions };
    }
