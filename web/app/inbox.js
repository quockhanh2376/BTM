/* BTM dashboard – Team inbox (danh sách note, chọn / xoá, tự thu gọn) + ảnh kèm note soạn ở ô Command. Tách từ app.js 2026-11-14,
   không đổi hành vi. Hàm dùng chung của app.js truyền vào qua d; ảnh đang kèm đọc qua getAttachedImage(); thân hàm giữ nguyên thụt lề cũ. */
    function btmInbox(d) {
      var setDisplay = d.setDisplay, showFeedback = d.showFeedback, cmdFeedback = d.cmdFeedback, topFeedback = d.topFeedback,
        askOwner = d.askOwner, postJson = d.postJson, clearChildren = d.clearChildren, formatTime = d.formatTime,
        formatStatus = d.formatStatus, agentLabel = d.agentLabel;

      var notesList = document.getElementById('notes-list');
      var noteImageInput = document.getElementById('note-image-input');
      var imagePreviewWrap = document.getElementById('image-preview-wrap');
      var imagePreview = document.getElementById('image-preview');
      var imagePreviewName = document.getElementById('image-preview-name');
      var removeImageBtn = document.getElementById('remove-image-btn');

      var imageToken = 0;
      var reader = null;
      var attachedImage = null;

      function clearAttachedImage() {
        imageToken++;
        if (reader) {
          try {
            reader.abort();
          } catch (err) {}
          reader = null;
        }
        attachedImage = null;
        if (noteImageInput) noteImageInput.value = '';
        if (imagePreview) imagePreview.removeAttribute('src');
        if (imagePreviewName) imagePreviewName.textContent = '';
        setDisplay(imagePreviewWrap, false);
      }

      function setAttachedImage(file, dataUrl, base64) {
        attachedImage = {
          name: file.name || 'image.png',
          base64: base64,
          dataUrl: dataUrl
        };
        if (imagePreview) imagePreview.src = dataUrl;
        if (imagePreviewName) imagePreviewName.textContent = file.name || 'image.png';
        setDisplay(imagePreviewWrap, true, 'inline-flex');
      }

      function processImageFile(file) {
        imageToken++;
        var currentToken = imageToken;
        if (!file) return;
        var validTypes = ['image/png', 'image/jpeg', 'image/webp'];
        if (!validTypes.includes(file.type)) {
          showFeedback(cmdFeedback, tx('cmd.imageType'), true);
          return;
        }
        if (file.size > 5 * 1024 * 1024) {
          showFeedback(cmdFeedback, tx('cmd.imageSize'), true);
          return;
        }
        if (reader) {
          try {
            reader.abort();
          } catch (err) {}
          reader = null;
        }
        reader = new FileReader();
        reader.onload = function (e) {
          if (currentToken === imageToken) {
            var dataUrl = e.target.result;
            var commaIdx = dataUrl.indexOf(',');
            var base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
            setAttachedImage(file, dataUrl, base64);
          }
        };
        reader.readAsDataURL(file);
      }

      if (noteImageInput) {
        noteImageInput.addEventListener('change', function () {
          if (noteImageInput.files && noteImageInput.files[0]) {
            processImageFile(noteImageInput.files[0]);
          }
        });
      }

      if (removeImageBtn) {
        removeImageBtn.addEventListener('click', function () {
          clearAttachedImage();
        });
      }

      // Hộp thư team: chọn để xoá (giữ qua mỗi lần vẽ lại), thu gọn mặc định.
      var selectedNotes = {};
      var inboxSection = document.getElementById('inbox-section');
      var inboxToggle = document.getElementById('inbox-toggle');
      var inboxTimer = null;
      var INBOX_COLLAPSE_MS = 3 * 60 * 1000;

      var inboxOpenedAt = 0;
      function setInboxOpen(open) {
        if (!inboxSection) return;
        if (open && inboxSection.classList.contains('collapsed')) inboxOpenedAt = Date.now();
        inboxSection.classList.toggle('collapsed', !open);
        if (inboxToggle) inboxToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
      function cancelInboxCollapse() {
        if (inboxTimer) { clearTimeout(inboxTimer); inboxTimer = null; }
      }
      if (inboxSection) {
        inboxSection.addEventListener('mouseenter', function () { cancelInboxCollapse(); setInboxOpen(true); });
        inboxSection.addEventListener('focusin', function () { cancelInboxCollapse(); setInboxOpen(true); });
        inboxSection.addEventListener('mouseleave', function () {
          cancelInboxCollapse();
          inboxTimer = setTimeout(function () { inboxTimer = null; setInboxOpen(false); }, INBOX_COLLAPSE_MS);
        });
      }
      if (inboxToggle) {
        inboxToggle.addEventListener('click', function (e) {
          e.stopPropagation();
          cancelInboxCollapse();
          // Chạm/Tab vừa mở bằng mouseenter/focusin ngay trước click → giữ mở, không đóng lại.
          if (Date.now() - inboxOpenedAt < 600) { setInboxOpen(true); return; }
          setInboxOpen(inboxSection.classList.contains('collapsed'));
        });
      }

      async function deleteNotes(body, question) {
        if (!(await askOwner({ who: tx('ask.team'), text: question, ok: tx('ask.delete'), cancel: tx('ask.keepIt') }))) return;
        try {
          var res = await postJson('/api/notes/delete', body);
          selectedNotes = {};
          var msg = tx('inbox.deleted', { n: (res.deleted || []).length });
          if (res.skipped && res.skipped.length) {
            msg += ' · ' + tx('inbox.skipped', { list: res.skipped.map(function (i) { return 'N-' + i; }).join(', ') });
          }
          showFeedback(topFeedback, msg, false);
        } catch (err) {
          showFeedback(topFeedback, err.message, true);
        }
      }
      var inboxDelSel = document.getElementById('inbox-del-sel');
      if (inboxDelSel) {
        inboxDelSel.addEventListener('click', function () {
          var ids = Object.keys(selectedNotes).map(Number);
          if (ids.length === 0) { showFeedback(topFeedback, tx('inbox.noneSelected'), true); return; }
          deleteNotes({ ids: ids }, tx('inbox.confirmSel', { list: ids.map(function (i) { return 'N-' + i; }).join(', ') }));
        });
      }
      var inboxDelAll = document.getElementById('inbox-del-all');
      if (inboxDelAll) {
        inboxDelAll.addEventListener('click', function () { deleteNotes({ all: true }, tx('inbox.confirmAll')); });
      }

      function renderNotes(notes) {
        if (!notesList) return;
        clearChildren(notesList);
        var list = Array.isArray(notes) ? notes : [];
        var inboxCount = document.getElementById('inbox-count');
        if (inboxCount) {
          var openCount = list.filter(function (n) { return n.status === 'open'; }).length;
          inboxCount.textContent = list.length ? tx('inbox.count', { n: list.length, open: openCount }) : '';
        }
        var inboxActions = document.querySelector('.inbox-actions');
        if (inboxActions) inboxActions.style.display = list.length ? '' : 'none';
        var present = {};
        list.forEach(function (n) { present[n.id] = true; });
        Object.keys(selectedNotes).forEach(function (id) { if (!present[id]) delete selectedNotes[id]; });
        if (list.length === 0) {
          var empty = document.createElement('div');
          empty.className = 'empty-placeholder';
          empty.textContent = tx('inbox.empty');
          notesList.appendChild(empty);
          return;
        }

        list.forEach(function (n) {
          var item = document.createElement('div');
          item.className = 'note-item';

          var header = document.createElement('div');
          header.className = 'note-header';

          var meta = document.createElement('div');
          meta.className = 'note-meta';

          var check = document.createElement('input');
          check.type = 'checkbox';
          check.className = 'note-check';
          check.checked = Boolean(selectedNotes[n.id]);
          check.setAttribute('aria-label', tx('inbox.select', { id: n.id }));
          check.addEventListener('change', function () {
            if (check.checked) selectedNotes[n.id] = true;
            else delete selectedNotes[n.id];
          });
          meta.appendChild(check);

          var idEl = document.createElement('span');
          idEl.className = 'note-id';
          idEl.textContent = 'N-' + n.id;
          meta.appendChild(idEl);

          if (n.at) {
            var timeEl = document.createElement('span');
            timeEl.className = 'note-time';
            timeEl.textContent = formatTime(n.at);
            meta.appendChild(timeEl);
          }
          header.appendChild(meta);

          var statusEl = document.createElement('span');
          statusEl.className = 'note-status';
          var isDone = n.status === 'done';
          statusEl.classList.add(isDone ? 'note-status-done' : 'note-status-open');
          statusEl.textContent = isDone ? tx('status.done') : (n.status === 'open' ? tx('status.open') : formatStatus(n.status));
          header.appendChild(statusEl);

          item.appendChild(header);

          var textEl = document.createElement('div');
          textEl.className = 'note-text';
          textEl.textContent = n.text || '';
          item.appendChild(textEl);

          if (n.image) {
            var imgEl = document.createElement('img');
            imgEl.className = 'note-image-thumb';
            imgEl.src = '/api/notes/' + n.id + '/image';
            imgEl.alt = tx('inbox.attachment', { id: n.id });
            item.appendChild(imgEl);
          }

          if (n.report && n.report.trim()) {
            var reportEl = document.createElement('pre');
            reportEl.className = 'note-report';
            // Dòng đầu báo cáo do agent ghi "… · <id>-Dev": hiện tên anh đặt thay cho id.
            reportEl.textContent = n.report.replace(/· ([a-z0-9_-]+)-(PM|Dev|QC|Audit)\b/g, function (_m, id, seat) { return '· ' + agentLabel(id) + '-' + seat; });
            item.appendChild(reportEl);
          }

          notesList.appendChild(item);
        });
      }

      return {
        renderNotes: renderNotes, clearAttachedImage: clearAttachedImage, processImageFile: processImageFile,
        getAttachedImage: function () { return attachedImage; },
        setInboxOpen: setInboxOpen, cancelInboxCollapse: cancelInboxCollapse, inboxSection: inboxSection
      };
    }
