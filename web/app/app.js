/* BTM dashboard – logic trang (tách từ web/index.html 2026-11-14, không đổi hành vi). Xem docs/engineering-rules.md. */
    (function () {
      // 1. Theme Management
      function initTheme() {
        var saved = null;
        try {
          saved = localStorage.getItem('btm-theme');
        } catch (e) {}

        var currentTheme = 'light';
        if (saved === 'dark' || saved === 'light') {
          currentTheme = saved;
        } else {
          try {
            if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
              currentTheme = 'dark';
            }
          } catch (e) {}
        }
        document.documentElement.setAttribute('data-theme', currentTheme);

        var toggleBtn = document.getElementById('theme-toggle');
        if (toggleBtn) {
          toggleBtn.addEventListener('click', function () {
            var active = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
            var next = active === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', next);
            try {
              localStorage.setItem('btm-theme', next);
            } catch (e) {}
          });
        }
      }
      initTheme();

      // Plan 9 Task 1: sidebar (neo cuộn, thu gọn, ☰ trên màn hẹp), nút header, chuyển ngôn ngữ.
      (function initShell() {
        var app = document.getElementById('app');
        var collapseBtn = document.getElementById('sidebar-collapse');
        var menuBtn = document.getElementById('menu-btn');
        var backdrop = document.getElementById('sidebar-backdrop');
        var collapsed = false;
        try { collapsed = localStorage.getItem('btm.sidebar') === 'collapsed'; } catch (e) {}
        function setCollapsed(v) {
          collapsed = v;
          if (app) app.classList.toggle('sidebar-collapsed', v);
          if (collapseBtn) collapseBtn.setAttribute('aria-expanded', v ? 'false' : 'true');
          try { localStorage.setItem('btm.sidebar', v ? 'collapsed' : 'open'); } catch (e) {}
        }
        setCollapsed(collapsed);
        if (collapseBtn) collapseBtn.addEventListener('click', function () { setCollapsed(!collapsed); });
        function setOpen(v) {
          if (app) app.classList.toggle('sidebar-open', v);
          if (menuBtn) menuBtn.setAttribute('aria-expanded', v ? 'true' : 'false');
        }
        if (menuBtn) menuBtn.addEventListener('click', function () { setOpen(!(app && app.classList.contains('sidebar-open'))); });
        if (backdrop) backdrop.addEventListener('click', function () { setOpen(false); });
        document.querySelectorAll('.sidebar .nav-item').forEach(function (item) {
          item.addEventListener('click', function (ev) {
            var soon = item.getAttribute('data-soon');
            if (soon) {
              // Phần dư (Plan 9): chưa có chức năng.
              showFeedback(topFeedback, tx('nav.soonMsg', { name: tx(soon) }), false);
              return;
            }
            var href = item.getAttribute('href') || '';
            var target = href.charAt(0) === '#' ? document.getElementById(href.slice(1)) : null;
            if (target) {
              ev.preventDefault();
              target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
            document.querySelectorAll('.sidebar .nav-item').forEach(function (n) { n.classList.toggle('active', n === item); });
            setOpen(false);
          });
        });
        var headRefresh = document.getElementById('head-refresh');
        if (headRefresh) headRefresh.addEventListener('click', function () {
          var b = document.getElementById('refresh-energy-btn');
          if (b) b.click();
        });
        var headHelp = document.getElementById('head-help');
        if (headHelp) headHelp.addEventListener('click', function () {
          // Phần dư (Plan 9): trang hướng dẫn làm sau; tạm chỉ chỗ tài liệu.
          showFeedback(topFeedback, tx('head.helpMsg'), false);
        });
        var headBell = document.getElementById('head-bell');
        if (headBell) headBell.addEventListener('click', function () {
          var q = document.getElementById('questions-section');
          var target = q && q.style.display !== 'none' ? q : document.getElementById('goals-board');
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        document.querySelectorAll('.lang-switch button').forEach(function (b) {
          b.setAttribute('aria-pressed', b.getAttribute('data-lang') === LANG ? 'true' : 'false');
          b.addEventListener('click', function () {
            if (b.getAttribute('data-lang') === 'vi') {
              // Phần dư (Plan 9): bản tiếng Việt làm sau, giữ tiếng Anh.
              showFeedback(topFeedback, tx('head.viSoon'), false);
            }
          });
        });
      })();

      // 2. Status Translations
      var STATUS_MAP = {
        running: tx('status.running'),
        awaiting_approval: tx('status.awaiting_approval'),
        done: tx('status.done'),
        needs_owner: tx('status.needs_owner'),
        out_of_turns: tx('status.out_of_turns'),
        stopped: tx('status.stopped'),
        refused: tx('status.refused'),
        error: tx('status.error'),
        pending: tx('status.pending'),
        in_dev: tx('status.in_dev'),
        awaiting_qc: tx('status.awaiting_qc'),
        passed: tx('status.passed'),
        returned: tx('status.returned'),
        failed: tx('status.failed'),
        blocked: tx('status.blocked'),
        queued: tx('status.queued'),
        cancelled: tx('status.cancelled')
      };
      var STATUS_LABELS = STATUS_MAP;

      function formatStatus(status) {
        if (!status) return '—';
        return Object.prototype.hasOwnProperty.call(STATUS_MAP, status) ? STATUS_MAP[status] : String(status);
      }
      var translateStatus = formatStatus;

      // 2b. Seat Labels & Agent Display Names (pm->PM, dev->Dev, qc->QC, audit->Audit)
      var SEAT_MAP = {
        pm: 'PM',
        dev: 'Dev',
        qc: 'QC',
        audit: 'Audit'
      };
      var SEAT_LABELS = SEAT_MAP;
      var SEAT_LABEL_MAP = SEAT_MAP;

      function formatSeatLabel(seat) {
        if (!seat) return '';
        var key = String(seat).toLowerCase();
        return Object.prototype.hasOwnProperty.call(SEAT_MAP, key) ? SEAT_MAP[key] : String(seat);
      }
      var formatSeat = formatSeatLabel;

      // Tên anh Zon đặt cho Worker (snapshot settings.names); chỉ để hiển thị, API vẫn dùng id.
      var agentNames = {};
      var agentAvatars = {};

      // Ảnh chọn từ máy → cắt vuông, thu về 96px JPEG ở trình duyệt → base64 (server kiểm magic bytes).
      function shrinkAvatar(file) {
        return new Promise(function (resolve, reject) {
          var url = URL.createObjectURL(file);
          var img = new Image();
          img.onload = function () {
            var side = Math.min(img.naturalWidth, img.naturalHeight);
            var c = document.createElement('canvas');
            c.width = 96; c.height = 96;
            c.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 96, 96);
            URL.revokeObjectURL(url);
            resolve(c.toDataURL('image/jpeg', 0.85).split(',')[1] || '');
          };
          img.onerror = function () { URL.revokeObjectURL(url); reject(new Error(tx('seat.avatarBad'))); };
          img.src = url;
        });
      }

      // Đổi tên hiển thị của agent (chỉ UI; backend vẫn dùng id).
      async function renameAgent(agent) {
        if (!agent) return;
        var v = prompt(tx('acc.renamePrompt', { agent: agent }), agentNames[agent] || '');
        if (v === null) return;
        try {
          await postJson('/api/agent', { agent: agent, name: v.trim() });
        } catch (err) {
          showFeedback(topFeedback, err.message, true);
        }
      }

      // Vòng tròn avatar trước tên trên thẻ ghế: bấm để chọn ảnh, chuột phải để bỏ ảnh.
      // Agent hỏi lại anh trước khi dừng (anh Zon 2026-11-14): giọng thân thiện, nút mặc định là "tiếp tục".
      function askOwner(o) {
        var dlg = document.getElementById('ask-dialog');
        if (!dlg || typeof dlg.showModal !== 'function') return Promise.resolve(window.confirm(o.text));
        var av = document.getElementById('ask-avatar');
        clearChildren(av);
        if (o.avatarFrom) {
          var src = o.avatarFrom.querySelector('img');
          if (src) { var im = document.createElement('img'); im.alt = ''; im.src = src.src; av.appendChild(im); }
          else av.textContent = (o.who || '?').charAt(0);
        } else {
          av.textContent = (o.who || '?').charAt(0);
        }
        document.getElementById('ask-who').textContent = o.who;
        document.getElementById('ask-text').textContent = o.text;
        document.getElementById('ask-note').textContent = o.note || '';
        var ok = document.getElementById('ask-ok');
        var cancel = document.getElementById('ask-cancel');
        var alt = document.getElementById('ask-alt');
        ok.textContent = o.ok;
        cancel.textContent = o.cancel;
        alt.textContent = o.alt || '';
        alt.hidden = !o.alt;
        alt.style.display = o.alt ? '' : 'none'; // .btn đặt display nên hidden không đủ
        // Nút đỏ chỉ cho việc nguy hiểm (dừng, xoá); hỏi bình thường dùng nút xanh.
        ok.className = 'btn ' + (o.tone === 'primary' || o.alt ? 'btn-primary' : 'btn-danger');
        return new Promise(function (resolve) {
          function done(v) {
            ok.removeEventListener('click', onOk);
            alt.removeEventListener('click', onAlt);
            cancel.removeEventListener('click', onCancel);
            dlg.removeEventListener('cancel', onCancel);
            if (dlg.open) dlg.close();
            resolve(v);
          }
          function onOk() { done(true); }
          function onAlt() { done('alt'); }
          function onCancel(e) { if (e) e.preventDefault(); done(false); }
          ok.addEventListener('click', onOk);
          alt.addEventListener('click', onAlt);
          cancel.addEventListener('click', onCancel);
          dlg.addEventListener('cancel', onCancel);
          dlg.showModal();
          cancel.focus();
        });
      }

      // Hỏi lại bằng giọng agent ngồi ghế đó (avatar + tên), thay confirm() của trình duyệt.
      function askAsSeat(seat, o) {
        var card = document.getElementById('seat-card-' + seat);
        var av = card ? card.querySelector('.seat-avatar') : null;
        var agent = av && av.dataset.agent ? av.dataset.agent : '';
        o.who = (agentLabel(agent) || String(seat).toUpperCase()) + ' · ' + (SEAT_LABELS[seat] || String(seat).toUpperCase());
        o.avatarFrom = av;
        return askOwner(o);
      }

      function renderSeatAvatar(cardEl, agent) {
        var wrap = cardEl.querySelector('.seat-title-wrap');
        if (!wrap) return;
        var btn = wrap.querySelector('.seat-avatar');
        if (!btn) {
          btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'seat-avatar';
          var input = document.createElement('input');
          input.type = 'file';
          input.accept = 'image/png,image/jpeg,image/webp';
          input.hidden = true;
          btn.addEventListener('click', function () { input.click(); });
          input.addEventListener('change', async function () {
            var f = input.files && input.files[0];
            input.value = '';
            if (!f || !btn.dataset.agent) return;
            try {
              await postJson('/api/agent', { agent: btn.dataset.agent, avatar: await shrinkAvatar(f) });
            } catch (err) {
              showFeedback(topFeedback, err.message, true);
            }
          });
          btn.addEventListener('contextmenu', async function (ev) {
            if (!btn.dataset.agent || !agentAvatars[btn.dataset.agent]) return;
            ev.preventDefault();
            if (!(await askOwner({ who: agentLabel(btn.dataset.agent), avatarFrom: btn, text: tx('ask.avatarRemove'), ok: tx('ask.remove'), cancel: tx('ask.keepIt') }))) return;
            try { await postJson('/api/agent', { agent: btn.dataset.agent, avatar: '' }); } catch (err) { showFeedback(topFeedback, err.message, true); }
          });
          wrap.insertBefore(btn, wrap.firstChild);
          wrap.appendChild(input);
        }
        var ren = wrap.querySelector('.acc-rename-btn');
        if (!ren) {
          ren = document.createElement('button');
          ren.type = 'button';
          ren.className = 'acc-rename-btn';
          ren.textContent = '✎';
          ren.addEventListener('click', function () { renameAgent(ren.dataset.agent); });
          var titleEl = wrap.querySelector('.seat-title');
          if (titleEl) titleEl.insertAdjacentElement('afterend', ren); else wrap.appendChild(ren);
        }
        ren.dataset.agent = agent || '';
        ren.hidden = !agent;
        ren.setAttribute('aria-label', tx('acc.renameFor', { agent: agent || '' }));
        ren.title = tx('acc.renameFor', { agent: agent || '' });
        var ver = agent ? agentAvatars[agent] : '';
        var key = (agent || '') + '|' + (ver || '');
        btn.setAttribute('aria-label', tx('seat.avatarFor', { agent: agentLabel(agent) }));
        btn.title = tx('seat.avatarFor', { agent: agentLabel(agent) });
        if (btn.dataset.key === key) return;
        btn.dataset.key = key;
        btn.dataset.agent = agent || '';
        clearChildren(btn);
        if (ver) {
          var im = document.createElement('img');
          im.alt = '';
          im.src = '/api/avatar/' + encodeURIComponent(agent) + '?v=' + encodeURIComponent(ver);
          btn.appendChild(im);
        } else {
          btn.textContent = agentLabel(agent).charAt(0) || '?';
        }
      }
      function agentLabel(id) {
        id = id ? String(id) : '';
        if (Object.prototype.hasOwnProperty.call(agentNames, id) && agentNames[id]) return String(agentNames[id]);
        return id ? (id.charAt(0).toUpperCase() + id.slice(1)) : '';
      }

      function formatAgentDisplayName(agentId, seatKey) {
        if (!agentId && !seatKey) return '—';
        var seatLabel = formatSeatLabel(seatKey);
        var capId = agentLabel(agentId);
        return (capId && seatLabel) ? (capId + '-' + seatLabel) : (capId || seatLabel || '—');
      }
      var formatAgent = formatAgentDisplayName;

      function formatLogWho(who, seats) {
        if (!who) return 'info';
        var lower = String(who).toLowerCase();

        var defaultSeats = {
          elon: 'pm',
          jacky: 'dev',
          jenny: 'qc',
          kai: 'audit'
        };
        var defaultAgents = {
          pm: 'elon',
          dev: 'jacky',
          qc: 'jenny',
          audit: 'kai'
        };

        var sList = Array.isArray(seats) ? seats : [];

        // Check if who matches a seat key directly (pm, dev, qc)
        if (Object.prototype.hasOwnProperty.call(SEAT_MAP, lower)) {
          var seatObj = sList.find(function (s) { return (s.seat || '').toLowerCase() === lower; });
          var agentId = seatObj ? seatObj.agent : defaultAgents[lower];
          if (agentId) {
            return formatAgentDisplayName(agentId, lower);
          }
          return formatSeatLabel(lower);
        }

        // Check if who matches an agent in seats
        var matchSeat = sList.find(function (s) { return (s.agent || '').toLowerCase() === lower; });
        if (matchSeat) {
          return formatAgentDisplayName(matchSeat.agent, matchSeat.seat);
        }

        // Fallback to defaultSeats if known
        if (Object.prototype.hasOwnProperty.call(defaultSeats, lower)) {
          return formatAgentDisplayName(lower, defaultSeats[lower]);
        }

        return who;
      }

      // 3. DOM Helper Functions (Safe DOM manipulation)
      function clearChildren(node) {
        while (node && node.firstChild) {
          node.removeChild(node.firstChild);
        }
      }

      function setDisplay(el, show, displayType) {
        if (!el) return;
        el.style.display = show ? (displayType || 'block') : 'none';
      }

      function showFeedback(el, msg, isError) {
        if (!el) return;
        el.textContent = msg || '';
        el.style.color = isError ? 'var(--error-text, var(--danger))' : 'var(--accent)';
        setDisplay(el, !!msg, 'block');
      }

      // Giờ hiển thị luôn theo giờ Việt Nam (UTC+7), bất kể máy mở trang ở múi giờ nào (anh Zon 2026-11-14).
      function formatHHmm(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        if (!isNaN(d.getTime())) {
          return d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
        }
        return '';
      }

      function getLoginDisplay(login) {
        if (!login) {
          return { text: tx('login.unknown'), dotClass: 'dot-unknown' };
        }
        var state = login.state || 'unknown';
        if (state === 'ok') {
          return { text: 'Ok', dotClass: 'dot-ok' };
        }
        if (state === 'expiring') {
          var label = login.detail ? login.detail.replace(/^Expires\s*/i, tx('login.expiring', { date: '' })) : tx('login.expiringSoon');
          return { text: label, dotClass: 'dot-expiring' };
        }
        if (state === 'relogin') {
          return { text: tx('login.relogin'), dotClass: 'dot-relogin' };
        }
        if (state === 'api_key') {
          return { text: tx('login.apiKey'), dotClass: 'dot-api-key' };
        }
        return { text: tx('login.unknown'), dotClass: 'dot-unknown' };
      }

      function energyColor(pct) {
        var val = Number(pct);
        if (isNaN(val)) return 'red';
        if (val >= 50) return 'green';
        if (val >= 20) return 'yellow';
        return 'red';
      }

      function sshHostFor(hostname, hint) {
        var host = (hostname || '').trim();
        if (!host || host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') {
          return hint || 'admzon@100.96.250.103';
        }
        return host.indexOf('@') !== -1 ? host : ('admzon@' + host);
      }

      function formatEnergy(w) {
        if (!w) return '';
        var rawPct = typeof w === 'number' ? w : (w.remainingPercent != null ? w.remainingPercent : (w.pct != null ? w.pct : 0));
        var pct = Math.max(0, Math.min(100, Math.round(Number(rawPct) || 0)));
        var hhmm = (typeof w === 'object' && w.resetsAt) ? formatHHmm(w.resetsAt) : '';
        return tx('energy.left', { pct: pct }) + (hhmm ? tx('energy.resets', { time: hhmm }) : '');
      }

      async function copyLoginCommand(text, inputEl, feedbackTarget) {
        function setFeedback(msg) {
          if (typeof feedbackTarget === 'function') {
            feedbackTarget(msg);
          } else if (feedbackTarget && 'textContent' in feedbackTarget) {
            feedbackTarget.textContent = msg;
            setTimeout(function () {
              feedbackTarget.textContent = tx('acc.copy');
            }, 2000);
          }
        }

        function fallbackCopy() {
          if (inputEl && typeof inputEl.select === 'function') {
            try {
              inputEl.focus();
              inputEl.select();
              if (typeof inputEl.setSelectionRange === 'function') {
                inputEl.setSelectionRange(0, inputEl.value.length);
              }
            } catch (e) {}
          }
          var ok = false;
          try {
            if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
              ok = document.execCommand('copy');
            }
          } catch (e) {
            ok = false;
          }
          if (ok) {
            setFeedback(tx('acc.copied'));
            return true;
          } else {
            setFeedback(tx('acc.copyManual'));
            return false;
          }
        }

        var hasClipboard = typeof window !== 'undefined' &&
          window.isSecureContext &&
          typeof navigator !== 'undefined' &&
          navigator.clipboard &&
          typeof navigator.clipboard.writeText === 'function';

        if (hasClipboard) {
          try {
            await navigator.clipboard.writeText(text);
            setFeedback(tx('acc.copied'));
            return true;
          } catch (err) {
            return fallbackCopy();
          }
        } else {
          return fallbackCopy();
        }
      }

      function getSshTarget(hint) {
        var host = '';
        try {
          if (window.location && window.location.hostname) {
            host = window.location.hostname;
          }
        } catch (e) {}
        return sshHostFor(host, hint);
      }

      var SEAT_LABELS = { pm: 'PM', dev: 'Dev', qc: 'QC', audit: 'Audit' };
      var EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

      function getLoginCommand(tool, sshTarget, user) {
        var t = (tool || '').toLowerCase();
        var u = /^[a-z_][a-z0-9_-]{0,31}$/.test(user || '') ? user : 'agent';
        if (t === 'claude-code' || t === 'claude') {
          return 'ssh -t ' + sshTarget + ' "sudo -iu ' + u + ' claude auth login"';
        }
        if (t === 'codex-cli' || t === 'codex') {
          return 'ssh -t ' + sshTarget + ' "sudo -iu ' + u + ' codex login --device-auth"';
        }
        return 'ssh -t ' + sshTarget + ' "sudo -iu ' + u + ' agy"';
      }

      // Chip "Sắp hết · hồi HH:mm" khi Energy thấp (chữ, không chỉ màu).
      function energyWarnChip(eng) {
        if (!eng || !eng.warn) return null;
        var chip = document.createElement('span');
        chip.className = 'energy-warn';
        var hhmm = eng.soonestReset ? formatHHmm(eng.soonestReset) : '';
        chip.textContent = tx('energy.low') + (hhmm ? tx('energy.resets', { time: hhmm }) : '');
        return chip;
      }

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

      function renderSeatWarnings(warnings) {
        var el = document.getElementById('seat-warnings');
        if (!el) return;
        if (Array.isArray(warnings) && warnings.length > 0) {
          el.textContent = tx('seat.warnings', { list: warnings.join(' · ') });
          el.style.display = 'block';
        } else {
          el.textContent = '';
          el.style.display = 'none';
        }
      }

      function buildModelControls(acc) {
        var wrap = document.createElement('div');
        wrap.className = 'account-model';

        var modelInput = document.createElement('select');
        modelInput.setAttribute('aria-label', tx('acc.modelFor', { agent: acc.agent }));
        var options = [''].concat(Array.isArray(acc.modelOptions) ? acc.modelOptions : []);
        if (acc.model && options.indexOf(acc.model) < 0) options.push(acc.model);
        options.forEach(function (m) {
          var opt = document.createElement('option');
          opt.value = m;
          opt.textContent = m || tx('acc.cliDefault');
          modelInput.appendChild(opt);
        });
        modelInput.value = acc.model || '';
        wrap.appendChild(modelInput);

        var effortSel = document.createElement('select');
        effortSel.setAttribute('aria-label', tx('acc.effortFor', { agent: acc.agent }));
        var allowed = EFFORTS;
        allowed.forEach(function (e) {
          var opt = document.createElement('option');
          opt.value = e;
          opt.textContent = e;
          effortSel.appendChild(opt);
        });
        effortSel.value = allowed.indexOf(acc.effort) >= 0 ? acc.effort : 'medium';
        wrap.appendChild(effortSel);

        var saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'btn btn-secondary btn-sm';
        saveBtn.textContent = tx('acc.save');
        saveBtn.setAttribute('aria-label', tx('acc.saveFor', { agent: acc.agent }));
        saveBtn.addEventListener('click', async function () {
          try {
            var res = await postJson('/api/agent', { agent: acc.agent, model: modelInput.value.trim(), effort: effortSel.value });
            if (res && res.error) {
              showFeedback(topFeedback, res.error, true);
            } else {
              showFeedback(topFeedback, tx('acc.saved', { agent: acc.agent }), false);
            }
          } catch (err) {
            showFeedback(topFeedback, err.message, true);
          }
        });
        wrap.appendChild(saveBtn);
        return wrap;
      }

      // 4. API Communication
      async function postJson(url, data) {
        var res = await fetch(url, {
          method: 'POST',
          headers: {
            'x-btm': '1',
            'content-type': 'application/json'
          },
          body: JSON.stringify(data)
        });
        var body = null;
        try {
          body = await res.json();
        } catch (e) {
          body = {};
        }
        if (!res.ok) {
          var errText = (body && body.error) ? body.error : tx('fb.serverError', { status: res.status });
          throw new Error(errText);
        }
        return body;
      }

      // 4. State Rendering
      var connBanner = document.getElementById('conn-banner');
      var topFeedback = document.getElementById('top-feedback');
      var cmdFeedback = document.getElementById('cmd-feedback');

      var projectBadge = document.getElementById('project-badge');
      var sessionBadge = document.getElementById('session-badge');
      var turnsBadge = document.getElementById('turns-badge');
      var holderDot = document.getElementById('holder-dot');
      var holderText = document.getElementById('holder-text');
      var approveBtn = document.getElementById('approve-btn');
      var stopBtn = document.getElementById('stop-btn');
      var autoApproveToggle = document.getElementById('auto-approve-toggle');

      var latestSnapshot = null;

      function updateApproveButton(snapshot) {
        if (!approveBtn) return;
        var status = snapshot && snapshot.session ? snapshot.session.status : null;
        if (snapshot && snapshot.session && snapshot.session.status === 'awaiting_approval') {
          approveBtn.disabled = false;
          approveBtn.textContent = tx('btn.approve');
          approveBtn.removeAttribute('title');
        } else if (status === 'needs_owner' || status === 'stopped' || status === 'out_of_turns') {
          approveBtn.disabled = false;
          approveBtn.textContent = tx('btn.resume');
          approveBtn.removeAttribute('title');
        } else {
          approveBtn.disabled = true;
          approveBtn.textContent = tx('btn.approve');
          approveBtn.setAttribute('title', tx('fb.nothingToApprove'));
        }
      }

      var logList = document.getElementById('log-list');
      var queueList = document.getElementById('queue-list');
      var goalsContainer = document.getElementById('goals-container');

      var TASK_TAB_KEYS = ['pending', 'in_dev', 'awaiting_qc', 'passed', 'returned'];
      var userSelectedTab = null;
      var lastTasksFingerprint = null;
      var currentActiveTab = 'pending';
      var goalTabSelections = {};
      var goalTicketsFingerprints = {};

      var PIPELINE_STAGES = [
        { key: 'intake', label: tx('stage.intake') },
        { key: 'plan', label: tx('stage.plan') },
        { key: 'build', label: tx('stage.build') },
        { key: 'verify', label: tx('stage.verify') },
        { key: 'audit', label: tx('stage.audit') },
        { key: 'release', label: tx('stage.release') }
      ];

      function getTasksFingerprint(tasks) {
        if (!Array.isArray(tasks)) return '';
        var map = {};
        for (var i = 0; i < tasks.length; i++) {
          var t = tasks[i];
          if (t && t.id) {
            map[t.id] = t.state || '';
          }
        }
        var keys = Object.keys(map).sort();
        var parts = [];
        for (var j = 0; j < keys.length; j++) {
          var k = keys[j];
          parts.push(k + ':' + map[k]);
        }
        return parts.join('|');
      }

      function resolveActiveTab(tasks, goalKey) {
        var userSelected = goalKey ? goalTabSelections[goalKey] : userSelectedTab;
        var lastFp = goalKey ? goalTicketsFingerprints[goalKey] : lastTasksFingerprint;
        var currentFingerprint = getTasksFingerprint(tasks);
        if (lastFp !== null && lastFp !== undefined && currentFingerprint !== lastFp) {
          userSelected = null;
          if (goalKey) goalTabSelections[goalKey] = null;
          else userSelectedTab = null;
        }
        if (goalKey) goalTicketsFingerprints[goalKey] = currentFingerprint;
        else lastTasksFingerprint = currentFingerprint;

        if (userSelected) {
          return userSelected;
        }

        var list = Array.isArray(tasks) ? tasks : [];
        for (var i = 0; i < list.length; i++) {
          if (list[i] && list[i].state === 'in_dev') return 'in_dev';
        }
        for (var j = 0; j < list.length; j++) {
          if (list[j] && list[j].state === 'awaiting_qc') return 'awaiting_qc';
        }

        var tabOrder = ['pending', 'in_dev', 'awaiting_qc', 'passed', 'returned'];
        for (var k = 0; k < tabOrder.length; k++) {
          var tabKey = tabOrder[k];
          for (var m = 0; m < list.length; m++) {
            var s = list[m].state;
            if (tabKey === 'returned') {
              if (s === 'returned' || (s !== 'pending' && s !== 'in_dev' && s !== 'awaiting_qc' && s !== 'passed')) return 'returned';
            } else if (s === tabKey) {
              return tabKey;
            }
          }
        }
        return 'pending';
      }

      function updateTabUI(activeKey) {
        TASK_TAB_KEYS.forEach(function (key) {
          var tabBtn = document.getElementById('tab-' + key);
          if (tabBtn) {
            var isActive = (key === activeKey);
            tabBtn.setAttribute('aria-selected', isActive ? 'true' : 'false');
            tabBtn.tabIndex = isActive ? 0 : -1;
          }
        });
        var taskTabsNav = document.getElementById('task-tablist');
        if (taskTabsNav) {
          taskTabsNav.setAttribute('data-active-state', activeKey);
          var colorVar = 'var(--tab-' + (activeKey === 'in_dev' ? 'in-dev' : (activeKey === 'awaiting_qc' ? 'awaiting-qc' : activeKey)) + ')';
          taskTabsNav.style.borderBottomColor = colorVar;
        }
      }

      function handleTabKeydown(e, activeTab, selectFn) {
        var active = activeTab || currentActiveTab;
        var currentIdx = TASK_TAB_KEYS.indexOf(active);
        if (currentIdx === -1) currentIdx = 0;

        if (e.key === 'ArrowRight' || e.key === 'Right') {
          e.preventDefault();
          var nextIdx = (currentIdx + 1) % TASK_TAB_KEYS.length;
          (selectFn || selectTab)(TASK_TAB_KEYS[nextIdx], true);
        } else if (e.key === 'ArrowLeft' || e.key === 'Left') {
          e.preventDefault();
          var prevIdx = (currentIdx - 1 + TASK_TAB_KEYS.length) % TASK_TAB_KEYS.length;
          (selectFn || selectTab)(TASK_TAB_KEYS[prevIdx], true);
        }
      }

      function renderTicketTable(tasks, activeKey, tbodyEl) {
        var tbody = tbodyEl;
        if (!tbody) {
          var el = document.getElementById('task-table-body');
          if (el) tbody = el;
        }
        if (!tbody) return;
        clearChildren(tbody);
        var list = Array.isArray(tasks) ? tasks : [];
        var filtered = list.filter(function (t) {
          if (activeKey === 'returned') {
            return t.state === 'returned' || (t.state !== 'pending' && t.state !== 'in_dev' && t.state !== 'awaiting_qc' && t.state !== 'passed');
          }
          return t.state === activeKey;
        });

        if (filtered.length === 0) {
          var tr = document.createElement('tr');
          var td = document.createElement('td');
          td.colSpan = 4;
          td.className = 'empty-placeholder';
          td.textContent = tx('goal.noTickets');
          tr.appendChild(td);
          tbody.appendChild(tr);
          return;
        }

        filtered.forEach(function (t) {
          var tr = document.createElement('tr');
          tr.className = 'ticket-row';

          var tdId = document.createElement('td');
          tdId.className = 'col-id';
          tdId.textContent = t.id || '—';
          tr.appendChild(tdId);

          var tdGoal = document.createElement('td');
          tdGoal.className = 'col-goal';
          tdGoal.textContent = t.goal || t.title || tx('goal.noDesc');
          tr.appendChild(tdGoal);

          var tdFixes = document.createElement('td');
          tdFixes.className = 'col-fixes';
          tdFixes.textContent = String(t.fix_rounds != null ? t.fix_rounds : (t.fixRounds != null ? t.fixRounds : 0));
          tr.appendChild(tdFixes);

          var tdUpdated = document.createElement('td');
          tdUpdated.className = 'col-updated';
          tdUpdated.textContent = (t.updatedAt || t.updated) ? formatTime(t.updatedAt || t.updated) : '—';
          tr.appendChild(tdUpdated);

          tbody.appendChild(tr);
        });
      }
      var renderTaskTable = renderTicketTable;

      async function toggleTicketHistory(ticketId, containerEl) {
        if (containerEl.dataset.loaded === 'true') {
          setDisplay(containerEl, containerEl.style.display === 'none');
          return;
        }
        containerEl.dataset.loaded = 'true';
        setDisplay(containerEl, true);
        clearChildren(containerEl);
        var loadingEl = document.createElement('div');
        loadingEl.className = 'empty-placeholder';
        loadingEl.textContent = tx('history.loading');
        containerEl.appendChild(loadingEl);
        try {
          var res = await fetch('/api/tickets/' + encodeURIComponent(ticketId) + '/history');
          if (!res.ok) throw new Error(tx('history.cannotLoad'));
          var list = await res.json();
          clearChildren(containerEl);
          if (!Array.isArray(list) || list.length === 0) {
            var emptyEl = document.createElement('div');
            emptyEl.className = 'empty-placeholder';
            emptyEl.textContent = tx('history.empty');
            containerEl.appendChild(emptyEl);
            return;
          }
          list.forEach(function (h) {
            var entry = document.createElement('div');
            entry.className = 'history-entry';

            var timeEl = document.createElement('span');
            timeEl.className = 'history-time';
            timeEl.textContent = formatTime(h.at);
            entry.appendChild(timeEl);

            var whoEl = document.createElement('span');
            whoEl.className = 'history-who';
            whoEl.textContent = '[' + (h.by || 'system') + ']';
            entry.appendChild(whoEl);

            var transEl = document.createElement('span');
            transEl.className = 'history-trans';
            transEl.textContent = (h.from_state || 'none') + ' → ' + (h.to_state || 'none');
            entry.appendChild(transEl);

            if (h.reason) {
              var reasonEl = document.createElement('span');
              reasonEl.className = 'history-reason';
              reasonEl.textContent = '(' + h.reason + ')';
              entry.appendChild(reasonEl);
            }

            containerEl.appendChild(entry);
          });
        } catch (err) {
          clearChildren(containerEl);
          var errEl = document.createElement('div');
          errEl.className = 'empty-placeholder';
          errEl.style.color = 'var(--error-text, var(--danger))';
          errEl.textContent = err.message || tx('history.error');
          containerEl.appendChild(errEl);
        }
      }

      // 3725000 ms → "1h 02m"; dưới 1 giờ → "37m"; dưới 1 phút → "<1m".
      function formatDuration(ms) {
        var m = Math.round((ms || 0) / 60000);
        if (m < 1) return '<1m';
        var h = Math.floor(m / 60);
        var mm = m % 60;
        return h ? h + 'h ' + (mm < 10 ? '0' : '') + mm + 'm' : mm + 'm';
      }

      // Khung chat History (anh Zon 2026-11-14): một khung cuộn, cũ trên – mới dưới; anh hỏi canh trái, người trả
      // lời canh phải. Mục (thuần, test được): { kind: 'ask' | 'reply' | 'goal', … } theo thứ tự thời gian.
      function buildHistory(state) {
        var out = [];
        var answers = {};
        ((state && state.answers) || []).forEach(function (a) { answers[a.id] = a; });
        var queue = ((state && state.queue) || []).slice().sort(function (x, y) { return x.id - y.id; });
        queue.forEach(function (q) {
          var ask = String(q.to).indexOf('ask-') === 0;
          var raw = String(q.text || '');
          out.push({
            kind: 'ask',
            id: q.id,
            seat: ask ? String(q.to).slice(4) : q.to,
            text: raw.replace(/^\[plan\]\s*/i, ''),
            plan: /^\[plan\]/i.test(raw),
            status: q.status,
            at: q.created_at
          });
          // Người được hỏi "dạ" ngay, rồi mới tới câu trả lời chi tiết (anh Zon 2026-11-14).
          if (q.status !== 'cancelled') out.push({ kind: 'reply', ack: true, id: q.id, seat: ask ? String(q.to).slice(4) : q.to, asked: ask ? String(q.to).slice(4) : q.to, agent: null, text: ackLine(q.id, raw), at: q.created_at });
          var a = answers[q.id];
          if (a) out.push({ kind: 'reply', id: q.id, seat: a.seat, asked: a.asked, agent: a.agent, text: a.answer, at: a.at });
        });
        var s = state && state.session;
        var goalsAll = (state && state.goals) || [];
        ((s && s.goals) || []).forEach(function (g) {
          var text = String(g);
          if (text === 'Direct command' || text === 'Ask') return;
          if (/^\d+$/.test(text)) {
            var found = goalsAll.filter(function (x) { return String(x.n) === text; })[0];
            text = 'G' + text + (found && found.title ? ' · ' + found.title : '');
          }
          out.push({ kind: 'goal', text: text, status: s.status });
        });
        return out;
      }
      var HIST_ICON = { done: '✓', cancelled: '✕', running: '⏳', queued: '⏳' };
      function renderHistory(el, state) {
        var items = buildHistory(state);
        var key = JSON.stringify(items.map(function (i) { return [i.kind, i.id, i.status, i.at]; }));
        if (el.getAttribute('data-key') === key) return;
        var nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        el.setAttribute('data-key', key);
        clearChildren(el);
        el.classList.add('chat-log');
        if (!items.length) {
          var e = document.createElement('li');
          e.className = 'empty-placeholder';
          e.textContent = tx('queue.empty');
          el.appendChild(e);
          return;
        }
        var seatAgent = {};
        ((state && state.seats) || []).forEach(function (x) { seatAgent[x.seat] = x.agent; });
        var who = function (seat, agent) { return agentLabel(agent || seatAgent[seat]) || String(seat).toUpperCase(); };
        items.forEach(function (it) {
          var li = document.createElement('li');
          if (it.kind === 'goal') {
            li.className = 'msg-divider';
            li.textContent = tx('hist.goal') + ' · ' + (it.text.length > 70 ? it.text.slice(0, 69) + '…' : it.text) + ' · ' + formatStatus(it.status);
            li.title = it.text;
            el.appendChild(li);
            return;
          }
          li.className = 'msg ' + (it.kind === 'ask' ? 'msg-owner' : 'msg-team') + (it.ack ? ' msg-ack' : '');
          var head = document.createElement('div');
          head.className = 'msg-head';
          if (it.kind === 'ask') {
            head.textContent = tx('hist.owner') + ' → ' + who(it.seat) + ' · ' + formatHHmm(it.at)
              + (it.plan ? ' · ' + tx('hist.plan') : '') + ' ' + (HIST_ICON[it.status] || '');
            head.title = formatStatus(it.status);
          } else {
            head.textContent = who(it.seat, it.agent) + ' · ' + (SEAT_LABELS[it.seat] || it.seat) + ' · ' + formatHHmm(it.at)
              + (it.seat !== it.asked ? ' · ' + tx('ans.onBehalf', { seat: SEAT_LABELS[it.asked] || it.asked }) : '');
          }
          var body = document.createElement('div');
          body.className = 'msg-body';
          body.textContent = it.text;
          li.appendChild(head);
          li.appendChild(body);
          el.appendChild(li);
        });
        if (nearBottom || !el.getAttribute('data-scrolled')) { el.scrollTop = el.scrollHeight; el.setAttribute('data-scrolled', '1'); }
      }

      // (đã gộp vào lịch sử chung) câu trả lời gần đây của team.
      function renderAnswers(list, seats) {
        var box = document.getElementById('answers-box');
        var el = document.getElementById('answers-list');
        if (!box || !el) return;
        list = Array.isArray(list) ? list.slice(0, 5) : [];
        box.hidden = list.length === 0;
        var key = list.map(function (a) { return a.id; }).join(',');
        if (el.getAttribute('data-key') === key) return;
        el.setAttribute('data-key', key);
        clearChildren(el);
        list.forEach(function (a) {
          var item = document.createElement('div');
          item.className = 'answer-item';
          var head = document.createElement('div');
          head.className = 'answer-head';
          head.textContent = agentLabel(a.agent) + ' · ' + (SEAT_LABELS[a.seat] || a.seat) + ' · ' + formatHHmm(a.at)
            + (a.seat !== a.asked ? ' · ' + tx('ans.onBehalf', { seat: SEAT_LABELS[a.asked] || a.asked }) : '');
          var q = document.createElement('div');
          q.className = 'answer-q';
          q.textContent = '“' + a.question + '”';
          var body = document.createElement('div');
          body.className = 'answer-body';
          body.textContent = a.answer;
          item.appendChild(head);
          item.appendChild(q);
          item.appendChild(body);
          el.appendChild(item);
        });
      }

      function renderGoals(goals, seats) {
        var container = document.getElementById('goals-container');
        if (!container) return;
        clearChildren(container);

        var list = Array.isArray(goals) ? goals.slice() : [];
        if (list.length === 0) {
          var empty = document.createElement('div');
          empty.className = 'empty-placeholder';
          empty.textContent = tx('goals.empty');
          container.appendChild(empty);
          return;
        }

        // Mới nhất ở trên (n giảm dần)
        list.sort(function (a, b) { return b.n - a.n; });

        var hasAuditSeat = false;
        if (Array.isArray(seats)) {
          hasAuditSeat = seats.some(function (s) { return s.seat === 'audit' && s.agent; });
        }

        list.forEach(function (g) {
          var card = document.createElement('div');
          card.className = 'goal-group-card';
          card.setAttribute('data-goal-n', String(g.n));

          // 1. Goal header: G<n> · <tiêu đề> · <passed>/<total> đạt
          var header = document.createElement('div');
          header.className = 'goal-group-header';

          var titleWrap = document.createElement('div');
          titleWrap.className = 'goal-group-title';

          var titleSpan = document.createElement('span');
          titleSpan.textContent = 'G' + g.n + ' · ' + (g.title || '') + ' · ' + tx('goal.passed', { n: g.passed || 0, m: g.total || 0 });
          titleWrap.appendChild(titleSpan);
          header.appendChild(titleWrap);
          // Thùng rác goal (anh Zon 2026-11-14): ✕ = vào thùng rác (ẩn, khôi phục được), PM hỏi lại trước.
          var archiveBtn = document.createElement('button');
          archiveBtn.type = 'button';
          archiveBtn.className = 'goal-archive-btn';
          archiveBtn.textContent = '✕';
          archiveBtn.title = tx('trash.moveTip', { n: g.n });
          archiveBtn.setAttribute('aria-label', tx('trash.moveTip', { n: g.n }));
          archiveBtn.addEventListener('click', async function () {
            var yes = await askAsSeat('pm', { text: tx('trash.askMove', { n: g.n }), note: tx('trash.askMoveNote'), ok: tx('trash.moveOk'), cancel: tx('ask.keepIt') });
            if (!yes) return;
            archiveBtn.disabled = true;
            try {
              var res = await postJson('/api/goals/' + g.n + '/archive', {});
              showFeedback(topFeedback, res && res.error ? res.error : tx('trash.moved', { n: g.n }), Boolean(res && res.error));
            } catch (err) {
              showFeedback(topFeedback, err.message, true);
            } finally {
              archiveBtn.disabled = false;
            }
          });
          // Kho kiến thức: xem nhật ký nén của goal (bản team dùng để trả lời câu hỏi).
          var kb = document.createElement('a');
          kb.className = 'goal-kb-link';
          kb.href = '/api/goals/' + g.n + '/knowledge';
          kb.target = '_blank';
          kb.rel = 'noopener';
          kb.textContent = tx('goal.summary');
          kb.title = tx('goal.summaryTip');
          header.appendChild(kb);
          header.appendChild(archiveBtn);

          // Nút Duyệt merge: chỉ hiện khi goal ở qc_done (không audit) hoặc audit_passed
          var canApprove = hasAuditSeat ? (g.state === 'audit_passed') : (g.state === 'qc_done' || g.state === 'audit_passed');
          if (canApprove) {
            var actions = document.createElement('div');
            actions.className = 'goal-group-actions';
            var approveGoalBtn = document.createElement('button');
            approveGoalBtn.type = 'button';
            approveGoalBtn.className = 'btn btn-primary btn-approve-goal';
            approveGoalBtn.textContent = tx('goal.approveMerge');
            approveGoalBtn.addEventListener('click', async function () {
              var approveYes = await askAsSeat('pm', {
                text: tx('ask.merge', { n: g.n }),
                note: tx('ask.mergeNote'),
                tone: 'primary',
                ok: tx('ask.mergeOk'),
                cancel: tx('ask.notYet'),
              });
              if (!approveYes) return;
              approveGoalBtn.disabled = true;
              try {
                var res = await postJson('/api/goal/approve', { goal: 'G' + g.n });
                if (res && res.ok) {
                  showFeedback(topFeedback, tx('goal.merged', { n: g.n, sha: (res.sha || '').slice(0, 7) }), false);
                } else {
                  showFeedback(topFeedback, (res && res.message) || tx('goal.approveError'), true);
                }
              } catch (err) {
                showFeedback(topFeedback, err.message, true);
              } finally {
                approveGoalBtn.disabled = false;
              }
            });
            actions.appendChild(approveGoalBtn);
            header.appendChild(actions);
          }

          // Decision 0006: kết quả push GitHub (tag + link), lỗi thì có nút Push lại.
          var rel = g.release;
          if (rel && typeof rel === 'object') {
            var relWrap = document.createElement('div');
            relWrap.className = 'goal-group-actions goal-release';
            if (rel.ok && /^https:\/\/github\.com\//.test(String(rel.url || ''))) {
              var relLink = document.createElement('a');
              relLink.href = rel.url;
              relLink.target = '_blank';
              relLink.rel = 'noopener noreferrer';
              relLink.textContent = tx('goal.released', { tag: String(rel.tag || '') });
              relWrap.appendChild(relLink);
            } else if (!rel.ok) {
              var relErr = document.createElement('span');
              relErr.className = 'goal-release-error';
              relErr.textContent = tx('goal.pushFailed', { error: String(rel.error || '') });
              relWrap.appendChild(relErr);
              var pushBtn = document.createElement('button');
              pushBtn.type = 'button';
              pushBtn.className = 'btn btn-secondary btn-sm';
              pushBtn.textContent = tx('goal.pushAgain');
              pushBtn.addEventListener('click', async function () {
                pushBtn.disabled = true;
                try {
                  await postJson('/api/goal/push', { goal: 'G' + g.n });
                } catch (err) {
                  showFeedback(topFeedback, err.message, true);
                } finally {
                  pushBtn.disabled = false;
                }
              });
              relWrap.appendChild(pushBtn);
            }
            header.appendChild(relWrap);
          }

          card.appendChild(header);

          // Thời gian goal (anh Zon 2026-11-14): tổng · agent chạy (theo ghế) · chờ anh / tạm dừng.
          if (g.time) {
            var tl = document.createElement('div');
            tl.className = 'goal-time';
            var seatParts = ['pm', 'dev', 'qc', 'audit'].filter(function (k) { return g.time.bySeat && g.time.bySeat[k]; })
              .map(function (k) { return (SEAT_LABELS[k] || k) + ' ' + formatDuration(g.time.bySeat[k]); });
            tl.textContent = '⏱ ' + tx('goal.timeLine', {
              total: formatDuration(g.time.wallMs),
              agent: formatDuration(g.time.agentMs),
              seats: seatParts.join(' · '),
              wait: formatDuration(Math.max(0, g.time.wallMs - g.time.agentMs))
            }) + (g.time.endedAt ? '' : ' · ' + tx('goal.timeRunning'));
            tl.title = tx('goal.timeTip', { from: formatDateTimeVN(g.time.startedAt), to: g.time.endedAt ? formatDateTimeVN(g.time.endedAt) : '—' });
            card.appendChild(tl);
          }

          // 2. Thanh pipeline 6 chặng (chặng trước chặng hiện tại = đã qua, có dấu ✓)
          var pipeline = document.createElement('div');
          pipeline.className = 'pipeline-bar';
          var activeIdx = PIPELINE_STAGES.findIndex(function (st) { return st.key === g.stage; });
          PIPELINE_STAGES.forEach(function (st, idx) {
            if (idx > 0) {
              var arrow = document.createElement('span');
              arrow.className = 'pipeline-arrow';
              arrow.textContent = '→';
              pipeline.appendChild(arrow);
            }
            var step = document.createElement('span');
            step.className = 'pipeline-step';
            step.setAttribute('data-stage', st.key);
            if (g.stage === st.key) {
              step.classList.add('stage-active');
            } else if (activeIdx > idx) {
              step.classList.add('stage-done');
            }
            step.textContent = st.label;
            pipeline.appendChild(step);
          });
          card.appendChild(pipeline);

          // 3. 5 tab trạng thái cho ticket
          var tickets = Array.isArray(g.tickets) ? g.tickets : [];
          var counts = { pending: 0, in_dev: 0, awaiting_qc: 0, passed: 0, returned: 0 };
          tickets.forEach(function (t) {
            if (t.state === 'pending') counts.pending++;
            else if (t.state === 'in_dev') counts.in_dev++;
            else if (t.state === 'awaiting_qc') counts.awaiting_qc++;
            else if (t.state === 'passed') counts.passed++;
            else counts.returned++;
          });

          // Resolve active tab for this goal
          var goalKey = 'G' + g.n;
          var activeTab = (typeof resolveActiveTab === 'function') ? resolveActiveTab(tickets, goalKey) : 'pending';

          var tabNav = document.createElement('div');
          tabNav.className = 'task-tabs-nav';
          tabNav.setAttribute('role', 'tablist');
          tabNav.setAttribute('aria-label', tx('goal.tableTitle', { n: g.n }));
          tabNav.setAttribute('data-active-state', activeTab);
          tabNav.style.borderBottomColor = 'var(--tab-' + (activeTab === 'in_dev' ? 'in-dev' : (activeTab === 'awaiting_qc' ? 'awaiting-qc' : activeTab)) + ')';

          var panelId = 'goal-G' + g.n + '-tabpanel';
          var panel = document.createElement('div');
          panel.className = 'task-tabpanel';
          panel.setAttribute('role', 'tabpanel');
          panel.id = panelId;
          panel.setAttribute('aria-labelledby', 'goal-G' + g.n + '-tab-' + activeTab);
          panel.tabIndex = 0;

          var table = document.createElement('table');
          table.className = 'task-table';

          var colgroup = document.createElement('colgroup');

          var colId = document.createElement('col');
          colId.className = 'col-id';
          colId.style.width = '72px';
          colgroup.appendChild(colId);

          var colGoal = document.createElement('col');
          colGoal.className = 'col-goal';
          colgroup.appendChild(colGoal);

          var colTags = document.createElement('col');
          colTags.className = 'col-tags';
          colTags.style.width = '140px';
          colgroup.appendChild(colTags);

          var colFixes = document.createElement('col');
          colFixes.className = 'col-fixes';
          colFixes.style.width = '80px';
          colgroup.appendChild(colFixes);

          var colUpdated = document.createElement('col');
          colUpdated.className = 'col-updated';
          colUpdated.style.width = '96px';
          colgroup.appendChild(colUpdated);

          table.appendChild(colgroup);

          var thead = document.createElement('thead');
          var trHead = document.createElement('tr');

          var thId = document.createElement('th');
          thId.scope = 'col';
          thId.className = 'col-id';
          thId.textContent = 'ID';
          trHead.appendChild(thId);

          var thGoal = document.createElement('th');
          thGoal.scope = 'col';
          thGoal.className = 'col-goal';
          thGoal.textContent = tx('goal.col.title');
          trHead.appendChild(thGoal);

          var thTags = document.createElement('th');
          thTags.scope = 'col';
          thTags.className = 'col-tags';
          thTags.textContent = tx('goal.col.tags');
          trHead.appendChild(thTags);

          var thFixes = document.createElement('th');
          thFixes.scope = 'col';
          thFixes.className = 'col-fixes';
          thFixes.textContent = tx('goal.col.rounds');
          trHead.appendChild(thFixes);

          var thUpdated = document.createElement('th');
          thUpdated.scope = 'col';
          thUpdated.className = 'col-updated';
          thUpdated.textContent = tx('goal.col.updated');
          trHead.appendChild(thUpdated);

          thead.appendChild(trHead);
          table.appendChild(thead);

          var tbody = document.createElement('tbody');
          table.appendChild(tbody);
          panel.appendChild(table);

          function renderTicketItems(selectedTabKey) {
            clearChildren(tbody);
            var filtered = tickets.filter(function (t) {
              if (selectedTabKey === 'returned') {
                return t.state === 'returned' || (t.state !== 'pending' && t.state !== 'in_dev' && t.state !== 'awaiting_qc' && t.state !== 'passed');
              }
              return t.state === selectedTabKey;
            });

            if (filtered.length === 0) {
              var trEmpty = document.createElement('tr');
              var tdEmpty = document.createElement('td');
              tdEmpty.colSpan = 5;
              tdEmpty.className = 'empty-placeholder';
              tdEmpty.textContent = tx('goal.noTickets');
              trEmpty.appendChild(tdEmpty);
              tbody.appendChild(trEmpty);
              return;
            }

            filtered.forEach(function (t) {
              var tr = document.createElement('tr');
              tr.className = 'ticket-row';
              tr.tabIndex = 0;
              tr.style.cursor = 'pointer';

              var tdId = document.createElement('td');
              tdId.className = 'col-id';
              tdId.textContent = t.id || '—';
              tr.appendChild(tdId);

              var tdTitle = document.createElement('td');
              tdTitle.className = 'col-goal';
              var titleSpan = document.createElement('span');
              titleSpan.className = 'ticket-title';
              // Format: #<number>/<of> · <tiêu đề>
              titleSpan.textContent = '#' + t.number + '/' + t.of + ' · ' + (t.title || '');
              tdTitle.appendChild(titleSpan);
              tr.appendChild(tdTitle);
              var tdTags = document.createElement('td');
              tdTags.className = 'col-tags';
              var diffBtn = document.createElement('button');
              diffBtn.type = 'button';
              diffBtn.className = 'btn btn-secondary btn-sm';
              diffBtn.textContent = tx('diff.open');
              diffBtn.setAttribute('aria-label', tx('diff.openFor', { ticket: t.id }));
              (function (ticketId) {
                diffBtn.addEventListener('click', function (ev) {
                  ev.stopPropagation();
                  openDiff(ticketId);
                });
              })(t.id);
              tdTags.appendChild(diffBtn);
              // Ticket failed/blocked: nút Làm lại (Dev hỏi lại trước), có phiên sẵn để Resume.
              if (t.state === 'failed' || t.state === 'blocked') {
                var retryBtn = document.createElement('button');
                retryBtn.type = 'button';
                retryBtn.className = 'btn btn-secondary btn-sm btn-accent-outline';
                retryBtn.textContent = tx('ticket.retry');
                retryBtn.setAttribute('aria-label', tx('ticket.retryFor', { ticket: t.id }));
                (function (ticketId, state) {
                  retryBtn.addEventListener('click', async function (ev) {
                    ev.stopPropagation();
                    var yes = await askAsSeat('dev', { text: tx('ticket.askRetry', { ticket: ticketId, state: state }), note: tx('ticket.askRetryNote'), ok: tx('ticket.retryOk'), cancel: tx('ask.notYet') });
                    if (!yes) return;
                    var r = await postJson('/api/tickets/' + encodeURIComponent(ticketId) + '/retry', {});
                    showFeedback(topFeedback, r && r.error ? r.error : tx('ticket.retried', { list: (r.reopened || [ticketId]).join(', ') }), Boolean(r && r.error));
                  });
                })(t.id, t.state);
                tdTags.appendChild(retryBtn);
              }

              if (t.type || t.size) {
                var meta = document.createElement('span');
                meta.className = 'ticket-meta';
                if (t.type) {
                  var typeBadge = document.createElement('span');
                  typeBadge.className = 'badge ticket-badge';
                  typeBadge.textContent = t.type;
                  meta.appendChild(typeBadge);
                }
                if (t.size) {
                  var sizeBadge = document.createElement('span');
                  sizeBadge.className = 'badge ticket-badge';
                  sizeBadge.textContent = t.size;
                  meta.appendChild(sizeBadge);
                }
                tdTags.appendChild(meta);
              }
              tr.appendChild(tdTags);

              var tdFixes = document.createElement('td');
              tdFixes.className = 'col-fixes';
              tdFixes.textContent = String(t.fix_rounds != null ? t.fix_rounds : (t.fixRounds != null ? t.fixRounds : 0));
              tr.appendChild(tdFixes);

              var tdUpdated = document.createElement('td');
              tdUpdated.className = 'col-updated';
              tdUpdated.textContent = (t.updatedAt || t.updated) ? formatTime(t.updatedAt || t.updated) : '—';
              tr.appendChild(tdUpdated);

              tbody.appendChild(tr);

              // Expandable history row
              var trHistory = document.createElement('tr');
              trHistory.className = 'ticket-history-row';
              trHistory.style.display = 'none';

              var tdHistory = document.createElement('td');
              tdHistory.colSpan = 5;
              tdHistory.style.padding = '0';

              var historyPanel = document.createElement('div');
              historyPanel.className = 'ticket-history-panel';
              tdHistory.appendChild(historyPanel);
              trHistory.appendChild(tdHistory);

              tbody.appendChild(trHistory);

              function toggleRowHistory() {
                var isHidden = trHistory.style.display === 'none';
                trHistory.style.display = isHidden ? '' : 'none';
                if (isHidden) {
                  toggleTicketHistory(t.id, historyPanel);
                }
              }

              tr.addEventListener('click', toggleRowHistory);
              tr.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggleRowHistory();
                }
              });
            });
          }

          function selectGoalTab(tabKey, focus) {
            goalTabSelections[goalKey] = tabKey;
            Array.from(tabNav.children).forEach(function (btn) {
              var isCurrent = btn.getAttribute('data-state') === tabKey;
              btn.setAttribute('aria-selected', isCurrent ? 'true' : 'false');
              btn.tabIndex = isCurrent ? 0 : -1;
              if (isCurrent && focus) {
                btn.focus();
              }
            });
            tabNav.setAttribute('data-active-state', tabKey);
            tabNav.style.borderBottomColor = 'var(--tab-' + (tabKey === 'in_dev' ? 'in-dev' : (tabKey === 'awaiting_qc' ? 'awaiting-qc' : tabKey)) + ')';
            panel.setAttribute('aria-labelledby', 'goal-G' + g.n + '-tab-' + tabKey);
            renderTicketItems(tabKey);
          }

          tabNav.addEventListener('keydown', function (e) {
            var curTab = goalTabSelections[goalKey] || activeTab;
            handleTabKeydown(e, curTab, function (newKey, focus) {
              selectGoalTab(newKey, focus);
            });
          });

          TASK_TAB_KEYS.forEach(function (tabKey) {
            var tabBtn = document.createElement('button');
            tabBtn.type = 'button';
            tabBtn.className = 'task-tab';
            tabBtn.setAttribute('role', 'tab');
            tabBtn.id = 'goal-G' + g.n + '-tab-' + tabKey;
            tabBtn.setAttribute('data-tab', tabKey);
            tabBtn.setAttribute('data-state', tabKey);
            var isSel = (tabKey === activeTab);
            tabBtn.setAttribute('aria-selected', isSel ? 'true' : 'false');
            tabBtn.setAttribute('aria-controls', panelId);
            tabBtn.tabIndex = isSel ? 0 : -1;

            var labelSpan = document.createElement('span');
            var tabLabelMap = {
              pending: tx('status.pending'),
              in_dev: tx('status.in_dev'),
              awaiting_qc: tx('status.awaiting_qc'),
              passed: tx('status.passed'),
              returned: tx('status.returned')
            };
            labelSpan.textContent = tabLabelMap[tabKey] || tabKey;
            tabBtn.appendChild(labelSpan);

            var countSpan = document.createElement('span');
            countSpan.className = 'task-tab-count';
            countSpan.id = 'count-G' + g.n + '-' + tabKey;
            countSpan.textContent = String(counts[tabKey] || 0);
            tabBtn.appendChild(countSpan);

            tabBtn.addEventListener('click', function () {
              selectGoalTab(tabKey, false);
            });

            tabNav.appendChild(tabBtn);
          });

          card.appendChild(tabNav);
          card.appendChild(panel);
          renderTicketItems(activeTab);

          container.appendChild(card);
        });
      }

      var notesList = document.getElementById('notes-list');
      var recipientRadios = document.getElementById('recipient-radios');
      var attachImageGroup = document.getElementById('attach-image-group');
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

      function updateAttachVisibility() {
        var checkedRadio = document.querySelector('input[name="cmd-to"]:checked');
        var to = checkedRadio ? checkedRadio.value : 'team';
        setDisplay(attachImageGroup, to === 'team' || to === 'auto', 'flex');
      }

      if (recipientRadios) {
        recipientRadios.addEventListener('change', function () {
          updateAttachVisibility();
        });
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

      function formatTime(str) {
        if (!str) return '—';
        if (str.indexOf('T') !== -1) {
          var d = new Date(str);
          if (!isNaN(d.getTime())) return d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hourCycle: 'h23' });
          return str.split('T')[1].slice(0, 8);
        }
        return str;
      }

      function renderRecipients(seats) {
        if (!recipientRadios) return;
        var currentChecked = document.querySelector('input[name="cmd-to"]:checked');
        var currentVal = currentChecked ? currentChecked.value : 'auto';

        var seatList = Array.isArray(seats) ? seats : [];
        var seatKeys = seatList.map(function (s) { return s.seat; });
        if (seatKeys.length === 0) {
          seatKeys = ['pm', 'dev', 'qc'];
        }

        var options = [{ value: 'auto', label: tx('cmd.auto') }, { value: 'team', label: tx('cmd.team') }];
        seatKeys.forEach(function (sk) {
          options.push({ value: sk, label: formatSeatLabel(sk) });
        });

        var currentInputs = recipientRadios.querySelectorAll('input[name="cmd-to"]');
        var currentVals = Array.from(currentInputs).map(function (inp) { return inp.value; });
        var newVals = options.map(function (o) { return o.value; });
        var isSame = currentVals.length === newVals.length && currentVals.every(function (v, i) { return v === newVals[i]; });

        if (!isSame) {
          clearChildren(recipientRadios);
          options.forEach(function (opt) {
            var label = document.createElement('label');
            label.className = 'radio-label';

            var radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'cmd-to';
            radio.value = opt.value;
            if (opt.value === currentVal || (opt.value === 'auto' && !newVals.includes(currentVal))) {
              radio.checked = true;
            }
            label.appendChild(radio);

            var textNode = document.createTextNode(' ' + opt.label);
            label.appendChild(textNode);

            recipientRadios.appendChild(label);
          });
        }
        updateAttachVisibility();
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

      // Mẫu anh Zon (2026-11-14): New note / Add Goal = soạn trong ô Command (Team / PM) có sẵn.
      function composeFor(to) {
        var radio = document.querySelector('input[name="cmd-to"][value="' + to + '"]');
        if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); }
        var box = document.getElementById('cmd-text');
        if (box) { box.scrollIntoView({ block: 'center' }); box.focus(); }
      }
      (function () {
        var nb = document.getElementById('inbox-new');
        if (nb) nb.addEventListener('click', function () { composeFor('team'); });
        var ga = document.getElementById('goal-add');
        if (ga) ga.addEventListener('click', function () { composeFor('pm'); });
        var ex = document.getElementById('inbox-expand');
        if (ex) ex.addEventListener('click', function () {
          cancelInboxCollapse();
          var open = inboxSection.classList.contains('collapsed');
          setInboxOpen(open);
          ex.querySelector('span').textContent = tx(open ? 'inbox.collapse' : 'inbox.expand');
        });
        var lf = document.getElementById('log-full');
        var ll = document.getElementById('log-list');
        if (lf && ll) lf.addEventListener('click', function () {
          var full = ll.classList.toggle('log-full');
          lf.setAttribute('aria-expanded', full ? 'true' : 'false');
          lf.querySelector('span').textContent = tx(full ? 'log.less' : 'log.full');
        });
      })();

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

      function formatElapsed(ms) {
        var t = Math.max(0, Math.floor(ms / 1000));
        var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
        var mm = (h > 0 && m < 10 ? '0' : '') + m;
        return (h > 0 ? h + ':' : '') + mm + ':' + (sec < 10 ? '0' : '') + sec;
      }

      // Lượt xong gần nhất (ticket · thời gian · kết quả) và tổng thời gian trên ticket đang/vừa làm.
      function renderSeatTiming(seatKey, cardData) {
        var lastEl = document.getElementById(seatKey + '-lastrun');
        var onEl = document.getElementById(seatKey + '-ontask');
        var lr = cardData.lastRun;
        if (lastEl) {
          lastEl.textContent = lr ? [lr.task || '—', formatElapsed(lr.durationMs || 0), String(lr.result || '')].join(' · ') : '—';
          var r = lr ? String(lr.result || '') : '';
          lastEl.setAttribute('data-result', r === 'ok' ? 'ok' : (/^(timeout|no_progress|aborted|usage_limit_hit|idle_timeout)$/.test(r) ? 'warn' : (r ? 'bad' : '')));
        }
        var ot = cardData.onTask;
        if (onEl) onEl.textContent = ot && ot.runs > 0 ? ot.task + ' · ' + formatElapsed(ot.totalMs || 0) + ' · ' + (ot.runs === 1 ? tx('seat.run1') : tx('seat.runs', { n: ot.runs })) : '—';
      }

      function tickSeatElapsed() {
        document.querySelectorAll('.seat-elapsed').forEach(function (el) {
          var since = el.dataset.since ? Date.parse(el.dataset.since) : NaN;
          el.hidden = isNaN(since);
          el.textContent = isNaN(since) ? '' : formatElapsed(Date.now() - since);
        });
      }
      setInterval(tickSeatElapsed, 1000);

      // Đầu khu Agents: tổng số ghế + số Live / Waiting / Idle (mẫu anh Zon 2026-11-14).
      function renderAgentCounts(seats) {
        var list = Array.isArray(seats) ? seats : [];
        var n = { running: 0, waiting: 0, idle: 0 };
        list.forEach(function (x) { n[x.status === 'running' ? 'running' : (x.status === 'waiting' ? 'waiting' : 'idle')]++; });
        var t = document.getElementById('agents-count');
        if (t) t.textContent = tx('agents.title', { n: list.length });
        [['agents-live', n.running], ['agents-waiting', n.waiting], ['agents-idle', n.idle]].forEach(function (p) {
          var el = document.getElementById(p[0]);
          if (el) el.textContent = String(p[1]);
        });
      }
      (function () {
        var b = document.getElementById('agents-refresh');
        if (b) b.addEventListener('click', function () { var r = document.getElementById('refresh-energy-btn'); if (r) r.click(); });
      })();

      function renderSeat(seatKey, cardData, isCurrentHolder, isBusy) {
        var cardEl = document.getElementById('seat-card-' + seatKey);
        if (!cardEl) return;

        if (isCurrentHolder) {
          cardEl.classList.add('is-holder');
        } else {
          cardEl.classList.remove('is-holder');
        }

        // Nút Stop riêng của thẻ: chỉ dừng lượt đang chạy của thẻ này (giữ hàng đợi).
        var cardStop = cardEl.querySelector('.seat-stop-btn');
        if (!cardStop) {
          cardStop = document.createElement('button');
          cardStop.type = 'button';
          cardStop.className = 'btn btn-danger btn-xs seat-stop-btn';
          cardStop.textContent = tx('btn.stop');
          cardStop.setAttribute('aria-label', tx('seat.stopFor', { seat: seatKey.toUpperCase() }));
          cardStop.addEventListener('click', async function () {
            var avBtn = cardEl.querySelector('.seat-avatar');
            var who = agentLabel((avBtn && avBtn.dataset.agent) || '') || seatKey.toUpperCase();
            var onEl = document.getElementById(seatKey + '-ontask');
            var tm = onEl ? /[A-Z][A-Z0-9]*-\d+/.exec(onEl.textContent) : null;
            var ticket = tm ? tm[0] : '';
            var yes = await askOwner({
              who: who + ' · ' + (SEAT_LABELS[seatKey] || seatKey.toUpperCase()),
              avatarFrom: avBtn,
              text: ticket ? tx('ask.stopTicket', { ticket: ticket }) : tx('ask.stopTask'),
              note: tx('ask.stopNote'),
              ok: tx('ask.yesStop'),
              cancel: tx('ask.keep'),
            });
            if (!yes) return;
            cardStop.disabled = true;
            try {
              var res = await postJson('/api/stop', { seat: seatKey });
              showFeedback(topFeedback, res && res.error ? res.error : tx('fb.stopSent'), Boolean(res && res.error));
            } catch (err) {
              showFeedback(topFeedback, err.message, true);
            }
          });
          var header = cardEl.querySelector('.seat-header');
          if (header) header.appendChild(cardStop);
        }
        cardStop.disabled = !(isCurrentHolder && isBusy);

        var selectEl = document.getElementById(seatKey + '-agent-select');
        if (selectEl) {
          selectEl.disabled = Boolean(isBusy);
          if (cardData && Array.isArray(cardData.candidates)) {
            var currentOptions = Array.from(selectEl.options).map(function (o) { return o.value; });
            var sameOptions = currentOptions.length === cardData.candidates.length &&
              currentOptions.every(function (v, i) { return v === cardData.candidates[i]; });
            if (!sameOptions) {
              clearChildren(selectEl);
              cardData.candidates.forEach(function (cand) {
                var opt = document.createElement('option');
                opt.value = cand;
                selectEl.appendChild(opt);
              });
            }
            // Giá trị vẫn là id agent (quy trình dùng id); chữ hiện tên anh đặt, đổi tên là cập nhật ngay.
            Array.from(selectEl.options).forEach(function (o) {
              var label = agentLabel(o.value);
              if (o.textContent !== label) o.textContent = label;
            });
            if (document.activeElement !== selectEl && cardData.agent) {
              selectEl.value = cardData.agent;
            }
          }
        }

        if (cardData) {
          var titleEl = document.getElementById(seatKey + '-title');
          var toolEl = document.getElementById(seatKey + '-tool');
          var spinnerEl = document.getElementById(seatKey + '-spinner');
          var statusBadge = document.getElementById(seatKey + '-status-badge');
          var taskEl = document.getElementById(seatKey + '-task');
          var sinceEl = document.getElementById(seatKey + '-since');
          var turnsEl = document.getElementById(seatKey + '-turns');
          renderSeatTiming(seatKey, cardData);
          var lastLineEl = document.getElementById(seatKey + '-last-line');

          if (titleEl) titleEl.textContent = formatAgentDisplayName(cardData.agent, seatKey);
          renderSeatAvatar(cardEl, cardData.agent);
          if (toolEl) {
            var toolParts = [cardData.tool || '—'];
            if (cardData.model) toolParts.push(cardData.model);
            if (cardData.substitute) toolParts.push(tx('seat.substitute', { agent: cardData.substitute }));
            if (Array.isArray(cardData.also) && cardData.also.length > 0) {
              toolParts.push(tx('seat.also', { seats: cardData.also.map(function (x) { return SEAT_LABELS[x] || x; }).join(', ') }));
            }
            toolEl.textContent = toolParts.join(' · ');
          }

          if (cardData.status === 'running') {
            if (spinnerEl) setDisplay(spinnerEl, true, 'inline-block');
            if (statusBadge) {
              setDisplay(statusBadge, true, 'inline-block');
              statusBadge.className = 'seat-status-badge status-live';
              statusBadge.textContent = tx('seat.live');
            }
          } else {
            if (spinnerEl) setDisplay(spinnerEl, false);
            if (statusBadge) {
              setDisplay(statusBadge, true, 'inline-block');
              statusBadge.className = 'seat-status-badge';
              if (cardData.status === 'waiting') {
                statusBadge.classList.add('status-waiting');
                statusBadge.textContent = tx('seat.waiting');
              } else {
                statusBadge.classList.add('status-idle');
                statusBadge.textContent = tx('seat.idle');
              }
            }
          }

          if (taskEl) taskEl.textContent = cardData.taskId || '—';
          if (sinceEl) sinceEl.textContent = formatTime(cardData.since);
          // Đồng hồ bấm giờ của lượt đang chạy (tính từ Started), tick mỗi giây trong tickSeatElapsed.
          var elapsedEl = document.getElementById(seatKey + '-elapsed');
          if (elapsedEl) {
            if (cardData.status === 'running' && cardData.since) elapsedEl.dataset.since = cardData.since;
            else delete elapsedEl.dataset.since;
            tickSeatElapsed();
          }
          if (turnsEl) turnsEl.textContent = String(cardData.turns || 0);
          if (lastLineEl) lastLineEl.textContent = cardData.agentStatus || cardData.lastLine || '—';

          // Login indicator
          var loginIndicator = document.getElementById(seatKey + '-login-indicator');
          if (loginIndicator && cardData.login) {
            clearChildren(loginIndicator);
            var lDisp = getLoginDisplay(cardData.login);
            var lDot = document.createElement('span');
            lDot.className = 'login-dot ' + lDisp.dotClass;
            loginIndicator.appendChild(lDot);
            var lTxt = document.createElement('span');
            lTxt.className = 'login-text';
            lTxt.textContent = lDisp.text;
            loginIndicator.appendChild(lTxt);
          }

          // Energy box
          var energyBox = document.getElementById(seatKey + '-energy-box');
          if (energyBox) {
            clearChildren(energyBox);
            var eng = cardData.energy;
            var warnChip = energyWarnChip(eng);
            if (warnChip) energyBox.appendChild(warnChip);
            if (eng && eng.status === 'fresh' && Array.isArray(eng.windows) && eng.windows.length > 0) {
              eng.windows.forEach(function (w) {
                var row = document.createElement('div');
                row.className = 'energy-bar-row';

                var wLabel = w.name === '5h' ? tx('energy.5h') : (w.name === 'week' ? tx('energy.week') : w.name);
                var lbl = document.createElement('span');
                lbl.className = 'energy-bar-label';
                lbl.textContent = wLabel;
                row.appendChild(lbl);

                var track = document.createElement('div');
                track.className = 'energy-meter-track';
                track.setAttribute('role', 'meter');
                var rawPct = typeof w.remainingPercent === 'number' ? w.remainingPercent : parseFloat(w.remainingPercent);
                var pct = Math.max(0, Math.min(100, Math.round(Number(rawPct) || 0)));
                track.setAttribute('aria-valuenow', String(pct));
                track.setAttribute('aria-valuemin', '0');
                track.setAttribute('aria-valuemax', '100');
                track.setAttribute('aria-label', wLabel + ': ' + formatEnergy(w));

                var fill = document.createElement('div');
                fill.className = 'energy-meter-fill meter-' + energyColor(w.remainingPercent);
                fill.style.width = Math.max(0, Math.min(100, Number(rawPct) || 0)) + '%';
                track.appendChild(fill);
                row.appendChild(track);

                var txt = document.createElement('span');
                txt.className = 'energy-bar-text';
                txt.textContent = formatEnergy(w);
                row.appendChild(txt);

                energyBox.appendChild(row);
              });
            } else {
              var unk = document.createElement('div');
              unk.className = 'energy-unknown';
              var noteText = (eng && eng.note) ? (' (' + eng.note + ')') : '';
              unk.textContent = tx('energy.unavailable') + noteText;
              energyBox.appendChild(unk);
            }
          }
        }
      }

      // Plan 9 Task 1: phiên bản + số việc chờ anh (câu hỏi, phiên cần anh, goal chờ duyệt merge).
      function renderShell(state) {
        var ver = document.getElementById('app-version');
        if (ver) ver.textContent = state.version ? 'v' + String(state.version) : '';
        var n = Array.isArray(state.questions) ? state.questions.length : 0;
        var st = state.session ? state.session.status : '';
        if (st === 'needs_owner' || st === 'out_of_turns' || st === 'awaiting_approval') n += 1;
        (Array.isArray(state.goals) ? state.goals : []).forEach(function (g) {
          if (g.state === 'audit_passed' || (g.state === 'qc_done' && !state.seats.some(function (x) { return x.seat === 'audit'; }))) n += 1;
        });
        var bell = document.getElementById('bell-count');
        if (bell) { bell.textContent = String(n); bell.hidden = n === 0; }
        renderKpis(state);
      }

      // Plan 9 Task 2: 4 thẻ số tính từ snapshot.
      function renderKpis(state) {
        var set = function (id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
        var accounts = 0;
        (Array.isArray(state.accounts) ? state.accounts : []).forEach(function (a) {
          accounts += Array.isArray(a.accounts) && a.accounts.length ? a.accounts.length : 1;
        });
        var seats = Array.isArray(state.seats) ? state.seats : [];
        var running = seats.filter(function (x) { return x.status === 'running'; }).length;
        var goals = Array.isArray(state.goals) ? state.goals : [];
        var tasks = 0;
        goals.forEach(function (g) { tasks += Number(g.total) || 0; });
        set('kpi-accounts', String(accounts));
        set('kpi-running', running + ' / ' + seats.length);
        set('kpi-goals', String(goals.filter(function (g) { return g.state !== 'merged'; }).length));
        set('kpi-tasks', String(tasks));
      }

      // Plan 9 Task 2: System Status (sidebar) – đọc /api/system mỗi 10 s khi tab đang hiện.
      function fmtRate(bps) {
        if (bps === null || bps === undefined) return '–';
        if (bps >= 1048576) return (bps / 1048576).toFixed(1) + ' MB/s';
        if (bps >= 1024) return (bps / 1024).toFixed(1) + ' KB/s';
        return bps + ' B/s';
      }
      function renderSystem(info) {
        [['cpu', info.cpuPercent], ['ram', info.ramPercent], ['disk', info.diskPercent]].forEach(function (row) {
          var v = row[1];
          var val = document.getElementById('sys-' + row[0]);
          var bar = document.getElementById('sys-' + row[0] + '-bar');
          if (val) val.textContent = typeof v === 'number' ? Math.round(v) + '%' : '–';
          if (bar) {
            bar.style.width = typeof v === 'number' ? Math.max(0, Math.min(100, v)) + '%' : '0';
            bar.className = typeof v === 'number' && v >= 90 ? 'bad' : (typeof v === 'number' && v >= 75 ? 'warn' : '');
          }
        });
        var net = document.getElementById('sys-net');
        if (net) net.textContent = '↓ ' + fmtRate(info.netInBps) + ' · ↑ ' + fmtRate(info.netOutBps);
        var dot = document.getElementById('sys-dot');
        if (dot) dot.className = 'sys-dot ' + (info.healthy ? 'ok' : 'bad');
        var health = document.getElementById('sys-health');
        if (health) health.textContent = info.healthy ? tx('sys.healthy') : tx('sys.busy');
      }
      async function pollSystem() {
        if (document.visibilityState === 'hidden') return;
        try {
          var res = await fetch('/api/system', { cache: 'no-store' });
          if (res.ok) renderSystem(await res.json());
        } catch (e) {}
      }
      pollSystem();
      setInterval(pollSystem, 10000);

      // Thùng rác goal: danh sách, Khôi phục, Xoá hẳn (hỏi lần hai; BTM sao lưu trước khi xoá).
      function setTrashCount(n) {
        var l = document.getElementById('goals-trash-label');
        if (l) l.textContent = tx('trash.label', { n: n || 0 });
      }
      async function loadTrash() {
        var box = document.getElementById('goals-trash');
        if (!box) return;
        try {
          var res = await fetch('/api/goals/trash', { cache: 'no-store' });
          var rows = res.ok ? await res.json() : [];
          clearChildren(box);
          setTrashCount(rows.length);
          if (!rows.length) {
            var e = document.createElement('div');
            e.className = 'empty-placeholder';
            e.textContent = tx('trash.empty');
            box.appendChild(e);
            return;
          }
          rows.forEach(function (g) {
            var row = document.createElement('div');
            row.className = 'trash-row';
            var t = document.createElement('div');
            t.className = 'trash-title';
            t.textContent = 'G' + g.n + ' · ' + (g.title || '') + ' · ' + tx('trash.meta', { tickets: g.tickets, at: formatDateTimeVN(g.archivedAt) });
            row.appendChild(t);
            var restore = document.createElement('button');
            restore.type = 'button';
            restore.className = 'btn btn-secondary btn-sm';
            restore.textContent = tx('trash.restore');
            restore.addEventListener('click', async function () {
              var r = await postJson('/api/goals/' + g.n + '/restore', {});
              showFeedback(topFeedback, r && r.error ? r.error : tx('trash.restored', { n: g.n }), Boolean(r && r.error));
              loadTrash();
            });
            var purge = document.createElement('button');
            purge.type = 'button';
            purge.className = 'btn btn-secondary btn-sm btn-danger-outline';
            purge.textContent = tx('trash.purge');
            purge.addEventListener('click', async function () {
              var yes = await askAsSeat('pm', { text: tx('trash.askPurge', { n: g.n }), note: tx('trash.askPurgeNote'), ok: tx('trash.purgeOk'), cancel: tx('ask.keepIt') });
              if (!yes) return;
              var r = await postJson('/api/goals/' + g.n + '/purge', {});
              showFeedback(topFeedback, r && r.error ? r.error : tx('trash.purged', { n: g.n }), Boolean(r && r.error));
              loadTrash();
            });
            var acts = document.createElement('div');
            acts.className = 'trash-actions';
            acts.appendChild(restore);
            acts.appendChild(purge);
            row.appendChild(acts);
            box.appendChild(row);
          });
        } catch (err) {
          showFeedback(topFeedback, err.message, true);
        }
      }
      (function () {
        var tb = document.getElementById('goals-trash-toggle');
        var box = document.getElementById('goals-trash');
        if (!tb || !box) return;
        tb.addEventListener('click', function () {
          box.hidden = !box.hidden;
          tb.setAttribute('aria-expanded', box.hidden ? 'false' : 'true');
          if (!box.hidden) loadTrash();
        });
      })();

      // Tab Folder (anh Zon 2026-11-14): chỉ xem cấu trúc repo chính + thư mục làm việc từng account.
      function formatDateTimeVN(iso) {
        var d = new Date(iso);
        if (!iso || isNaN(d.getTime())) return '—';
        return d.toLocaleString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      }
      function buildFileTree(files) {
        var root = { dirs: {}, files: [], count: 0 };
        files.forEach(function (f) {
          var parts = String(f).split('/');
          var node = root;
          root.count++;
          for (var i = 0; i < parts.length - 1; i++) {
            if (!Object.prototype.hasOwnProperty.call(node.dirs, parts[i])) node.dirs[parts[i]] = { dirs: {}, files: [], count: 0 };
            node = node.dirs[parts[i]];
            node.count++;
          }
          node.files.push(parts[parts.length - 1]);
        });
        return root;
      }
      function renderFileTree(node, parent) {
        Object.keys(node.dirs).sort().forEach(function (name) {
          var det = document.createElement('details');
          det.className = 'ftree-dir';
          var sum = document.createElement('summary');
          sum.textContent = '📁 ' + name + '/ ';
          var cnt = document.createElement('span');
          cnt.className = 'ftree-count';
          cnt.textContent = String(node.dirs[name].count);
          sum.appendChild(cnt);
          det.appendChild(sum);
          renderFileTree(node.dirs[name], det);
          parent.appendChild(det);
        });
        node.files.sort().forEach(function (name) {
          var f = document.createElement('div');
          f.className = 'ftree-file';
          f.textContent = name;
          parent.appendChild(f);
        });
      }
      function folderCard(title, path, rows, files, truncated, note) {
        var card = document.createElement('div');
        card.className = 'folder-card';
        var h = document.createElement('div');
        h.className = 'folder-title';
        h.textContent = title;
        card.appendChild(h);
        var p = document.createElement('code');
        p.className = 'folder-path';
        p.textContent = path;
        card.appendChild(p);
        var meta = document.createElement('div');
        meta.className = 'folder-meta';
        rows.forEach(function (r) {
          var chip = document.createElement('span');
          chip.className = 'folder-chip';
          var k = document.createElement('span');
          k.className = 'folder-chip-k';
          k.textContent = r[0];
          chip.appendChild(k);
          chip.appendChild(document.createTextNode(' ' + r[1]));
          meta.appendChild(chip);
        });
        card.appendChild(meta);
        if (note) {
          var n = document.createElement('div');
          n.className = 'account-detail';
          n.textContent = note;
          card.appendChild(n);
        }
        if (files && files.length) {
          var det = document.createElement('details');
          det.className = 'ftree';
          var sum = document.createElement('summary');
          sum.textContent = tx('folders.tree', { n: files.length }) + (truncated ? ' · ' + tx('folders.truncated', { n: files.length }) : '');
          det.appendChild(sum);
          renderFileTree(buildFileTree(files), det);
          card.appendChild(det);
        }
        return card;
      }
      function renderFolders(data) {
        var box = document.getElementById('folders-container');
        if (!box) return;
        clearChildren(box);
        var ro = document.createElement('div');
        ro.className = 'account-detail';
        ro.textContent = tx('folders.readOnly');
        box.appendChild(ro);
        if (!data || !data.repo) {
          var e = document.createElement('div');
          e.className = 'empty-placeholder';
          e.textContent = tx('folders.noProject');
          box.appendChild(e);
          return;
        }
        var r = data.repo;
        box.appendChild(folderCard(tx('folders.repo'), r.path, [
          [tx('folders.branch'), r.branch || '—'],
          [tx('folders.commit'), r.commit ? r.commit.sha + ' · ' + r.commit.subject + ' · ' + formatDateTimeVN(r.commit.at) : '—'],
          [tx('folders.dirty'), String(r.dirty)]
        ], r.files, r.truncated, data.isolated ? '' : tx('folders.shared')));
        var grid = document.createElement('div');
        grid.className = 'folder-grid';
        (data.accounts || []).forEach(function (a) {
          var slug = a.key !== a.agent && a.key.indexOf(a.agent + '-') === 0 ? a.key.slice(a.agent.length + 1) : '';
          grid.appendChild(folderCard(agentLabel(a.agent) + (slug ? ' · ' + slug : ''), a.path, [
            [tx('folders.projects'), (a.projects || []).join(', ') || '—'],
            [tx('folders.synced'), a.syncedAt ? formatDateTimeVN(a.syncedAt) : '—'],
            [tx('folders.dirty'), a.dirty == null ? '—' : String(a.dirty)]
          ], a.files, a.truncated, a.error ? tx('folders.notCreated') : ''));
        });
        box.appendChild(grid);
      }
      async function loadFolders() {
        var box = document.getElementById('folders-container');
        if (!box) return;
        if (!box.firstChild) {
          var l = document.createElement('div');
          l.className = 'empty-placeholder';
          l.textContent = tx('folders.loading');
          box.appendChild(l);
        }
        try {
          var res = await fetch('/api/folders', { cache: 'no-store' });
          if (!res.ok) throw new Error(String(res.status));
          renderFolders(await res.json());
        } catch (e) {
          clearChildren(box);
          var f = document.createElement('div');
          f.className = 'empty-placeholder';
          f.textContent = tx('folders.failed');
          box.appendChild(f);
        }
      }
      (function () {
        var tg = document.getElementById('tab-goals');
        var tf = document.getElementById('tab-folders');
        if (!tg || !tf) return;
        function show(folders) {
          tg.classList.toggle('active', !folders);
          tf.classList.toggle('active', folders);
          tg.setAttribute('aria-selected', folders ? 'false' : 'true');
          tf.setAttribute('aria-selected', folders ? 'true' : 'false');
          document.getElementById('goals-container').hidden = folders;
          document.getElementById('folders-container').hidden = !folders;
          // .btn đặt display nên thuộc tính hidden không ăn: ẩn bằng style.
          document.getElementById('goal-add').style.display = folders ? 'none' : '';
          document.getElementById('folders-refresh').style.display = folders ? '' : 'none';
          if (folders) loadFolders();
        }
        tg.addEventListener('click', function () { show(false); });
        tf.addEventListener('click', function () { show(true); });
        document.getElementById('folders-refresh').addEventListener('click', loadFolders);
      })();

      // Lọc log (mẫu anh Zon): chỉ ẩn/hiện dòng đã có, không đổi dữ liệu.
      function isLogError(t) { return /^(error|timeout|rejected|command_denied|fail)/i.test(String(t || '')); }
      function logFilterValue() { var f = document.getElementById('log-filter'); return f ? f.value : 'all'; }
      (function () {
        var f = document.getElementById('log-filter');
        var ll = document.getElementById('log-list');
        if (f && ll) f.addEventListener('change', function () { ll.classList.toggle('log-only-err', f.value === 'err'); });
      })();


      // ===== Bong bóng thoại (anh Zon 2026-11-14) – chỉ giao diện, không đụng backend =====
      // Spec: docs/superpowers/specs/2026-11-14-agent-chat-bubbles-design.md
      // Hàm thuần của chat (kho thoại, phân loại tin, sự kiện): web/app/chat-lib.js (nạp trước file này).
      var chatMode = 'en';
      try { var cm = window.localStorage.getItem('btm.chat'); if (cm === 'en' || cm === 'vi' || cm === 'off') chatMode = cm; } catch (e) {}
      var chatSnap = null;
      var chatBusyUntil = 0;
      var chatTimers = [];
      var chatWaiting = {};
      var chatPending = {};
      var chatNow = function () { return Date.now(); };
      var chatNextCheck = chatNow() + (5 + Math.random() * 3) * 60000;
      // Anh Zon: lúc có người đang làm, người chờ nói chuyện vui về project, giờ ngẫu nhiên 2–4 phút.
      var chatNextChit = chatNow() + (2 + Math.random() * 2) * 60000;

      function chatSeat(snap, seat) {
        var found = null;
        ((snap && snap.seats) || []).forEach(function (s) { if (s.seat === seat) found = s; });
        return found;
      }
      function chatName(snap, seat) {
        var s = chatSeat(snap, seat);
        return s && s.agent ? agentLabel(s.agent) : String(seat || '').toUpperCase();
      }
      function chatTrim(t, n) {
        t = String(t || '').replace(/\s+/g, ' ').trim();
        return t.length > n ? t.slice(0, n - 1) + '…' : t;
      }
      function chatAnchor(target) {
        if (target === 'owner') return document.querySelector('.user-chip');
        var card = document.getElementById('seat-card-' + target);
        if (!card || card.offsetParent === null) return null;
        return card.querySelector('.seat-avatar') || card.querySelector('.seat-title-wrap');
      }
      function chatPlace(el, anchor) {
        var r = anchor.getBoundingClientRect();
        var left = Math.max(8, Math.min(r.left + window.scrollX - 6, window.scrollX + document.documentElement.clientWidth - el.offsetWidth - 8));
        el.style.left = left + 'px';
        el.style.top = Math.max(window.scrollY + 4, r.top + window.scrollY - el.offsetHeight - 10) + 'px';
      }
      function chatClearWaiting(target) {
        var w = chatWaiting[target];
        if (w && w.parentNode) w.parentNode.removeChild(w);
        delete chatWaiting[target];
      }
      // Hiện một bong bóng (text) hoặc bong bóng chờ (waiting) trên avatar.
      function chatShow(target, text, waiting, allowRunning, thought) {
        if (chatMode === 'off') return;
        var seat = target === 'owner' ? null : chatSeat(chatSnap, target);
        if (seat && seat.status === 'running' && !allowRunning && !waiting) return;
        var anchor = chatAnchor(target);
        if (!anchor) return;
        chatClearWaiting(target);
        var old = document.querySelector('.chat-bubble[data-target="' + target + '"]');
        if (old && old.parentNode) old.parentNode.removeChild(old);
        var el = document.createElement('div');
        el.className = 'chat-bubble style-' + (target === 'owner' ? 'owner' : chatStyleOf(seat ? seat.agent : target)) + (waiting ? ' chat-wait' : '') + (thought ? ' chat-thought' : '');
        el.setAttribute('data-target', target);
        el.setAttribute('role', 'status');
        if (waiting) {
          for (var i = 0; i < 3; i++) { var d = document.createElement('span'); d.className = 'chat-dot'; el.appendChild(d); }
          el.setAttribute('aria-label', tx('chat.waiting'));
        } else {
          el.textContent = text;
        }
        document.body.appendChild(el);
        chatPlace(el, anchor);
        if (waiting) { chatWaiting[target] = el; return; }
        chatTimers.push(setTimeout(function () { el.classList.add('chat-fade'); }, CHAT_SHOW_MS));
        chatTimers.push(setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, CHAT_SHOW_MS + 600));
      }
      // Một cuộc thoại = các bước {target, text|waiting, delay}; các cuộc xếp hàng, không chồng nhau.
      function chatRun(steps) {
        if (chatMode === 'off' || !steps.length) return;
        var start = Math.max(chatNow(), chatBusyUntil);
        var last = 0;
        steps.forEach(function (st) {
          last = Math.max(last, st.delay || 0);
          chatTimers.push(setTimeout(function () {
            if (st.clear) chatClearWaiting(st.clear);
            if (st.target) chatShow(st.target, st.text, st.waiting, st.allowRunning);
            if (st.then) st.then();
          }, start - chatNow() + (st.delay || 0)));
        });
        chatBusyUntil = start + last + CHAT_SHOW_MS + 600;
      }
      function chatPlay(events, snap) {
        if (chatMode === 'off') return;
        var L = chatMode;
        events.forEach(function (e) {
          var vars = { ticket: e.ticket || '' };
          if (e.type === 'assign' || e.type === 'to_qc' || e.type === 'returned') {
            vars.to = chatName(snap, e.to);
            vars.from = chatName(snap, e.from);
            var ackKind = e.type === 'assign' ? 'assignAck' : (e.type === 'to_qc' ? 'toQcAck' : 'returnedAck');
            var receiver = chatSeat(snap, e.to);
            var steps = [{ target: e.from, text: pickChatLine(e.type, vars, L), delay: 0, allowRunning: true }];
            if (receiver && receiver.status === 'running') {
              steps.push({ target: e.to, text: pickChatLine(ackKind, vars, L), delay: 1500, allowRunning: true });
            } else {
              steps.push({ target: e.to, waiting: true, delay: 1500 });
              chatPending[e.to] = { kind: ackKind, vars: vars };
            }
            chatRun(steps);
          } else if (e.type === 'passed') {
            vars.to = chatName(snap, 'dev');
            vars.from = chatName(snap, 'qc');
            chatRun([
              { target: 'qc', text: pickChatLine('passed', vars, L), delay: 0, allowRunning: true },
              { target: 'dev', text: pickChatLine('passedAck', vars, L), delay: 1500, allowRunning: true }
            ]);
          } else if (e.type === 'start') {
            var p = chatPending[e.seat];
            delete chatPending[e.seat];
            if (p) chatRun([{ clear: e.seat, target: e.seat, text: pickChatLine(p.kind, p.vars, L), delay: 0, allowRunning: true }]);
            else chatClearWaiting(e.seat);
          } else if (e.type === 'question') {
            vars.text = chatTrim(e.text, 70);
            chatRun([
              { target: e.seat, text: pickChatLine('question', vars, L), delay: 0, allowRunning: true },
              { target: e.seat, waiting: true, delay: CHAT_SHOW_MS + 700 }
            ]);
          } else if (e.type === 'answered') {
            vars.to = chatName(snap, e.seat);
            chatRun([
              { clear: e.seat, target: 'owner', text: pickChatLine('answered', vars, L), delay: 0 },
              { target: e.seat, text: pickChatLine('answeredAck', vars, L), delay: 1500, allowRunning: true }
            ]);
          } else if (e.type === 'answer') {
            chatRun([{ target: e.seat, text: chatTrim(e.text, 120), delay: 0, allowRunning: true }]);
          } else if (e.type === 'error') {
            chatRun([{ clear: e.seat, target: e.seat, text: pickChatLine('error', vars, L), delay: 0 }]);
          }
        });
      }
      // Hỏi tiến độ: người đang chạy im lặng; người giao việc nói giờ giao, Finn (hoặc người rảnh) check và báo.
      function chatCheckIn(snap, now) {
        var run = null;
        ((snap && snap.seats) || []).forEach(function (s) { if (!run && s.status === 'running' && s.agent) run = s; });
        if (!run) return [];
        var L = chatMode;
        var idle = ((snap && snap.seats) || []).filter(function (s) { return s.agent && s.status !== 'running'; }).map(function (s) { return s.seat; });
        var pmFree = idle.indexOf('pm') >= 0;
        var asker = Math.random() < 0.5 || !pmFree ? 'owner' : 'pm';
        var giver = { dev: 'pm', qc: 'dev', audit: 'qc' }[run.seat];
        var checker = pmFree && asker !== 'pm' ? 'pm' : (idle.filter(function (s) { return s !== giver; })[0] || (pmFree ? 'pm' : null));
        var mins = run.since ? Math.max(0, Math.round((now - Date.parse(run.since)) / 60000)) : 0;
        var vars = {
          to: agentLabel(run.agent),
          ticket: run.ticket || '',
          time: run.since ? formatHHmm(run.since) : '—',
          mins: mins,
          status: chatTrim(run.agentStatus || run.lastLine || '', 80) || '…'
        };
        var steps = [{ target: asker, text: pickChatLine(Math.random() < 0.5 ? 'checkAskTeam' : 'checkAskOne', vars, L), delay: 0 }];
        var t = 1500;
        if (giver && idle.indexOf(giver) >= 0 && giver !== asker) {
          steps.push({ target: giver, text: pickChatLine('checkGiver', vars, L), delay: t });
          t += 2500;
        }
        if (checker && checker !== asker) {
          steps.push({ target: checker, text: pickChatLine('checkFinn', vars, L), delay: t });
          steps.push({ target: checker, waiting: true, delay: t + 1800 });
          steps.push({ target: checker, text: pickChatLine('checkReport', vars, L), delay: t + 3800 });
        } else if (asker === 'pm') {
          steps.push({ target: 'pm', text: pickChatLine('checkReport', vars, L), delay: t });
        }
        return steps;
      }
      function chatTick() {
        if (chatMode === 'off' || !chatSnap || document.visibilityState === 'hidden') return;
        var now = chatNow();
        if (now >= chatNextCheck) {
          chatNextCheck = now + (5 + Math.random() * 3) * 60000;
          chatRun(chatCheckIn(chatSnap, now));
        } else if (now >= chatNextChit) {
          chatNextChit = now + (2 + Math.random() * 2) * 60000;
          // Mỗi agent một tiếng nói (Finn ngồi cả PM lẫn QC thì chỉ tính một lần).
          var seenAgent = {};
          var idle = (chatSnap.seats || []).filter(function (s) {
            if (!s.agent || s.status === 'running' || seenAgent[s.agent]) return false;
            seenAgent[s.agent] = true;
            return true;
          }).map(function (s) { return s.seat; });
          var runner = null;
          (chatSnap.seats || []).forEach(function (s) { if (!runner && s.status === 'running' && s.agent) runner = s; });
          var goal = (chatSnap.goals || [])[0];
          // Hỏi thăm theo giờ VN / thời tiết (anh Zon 2026-11-14): người rảnh hỏi anh hoặc hỏi nhau.
          if (idle.length >= 1 && Math.random() < 0.4) {
            var speaker = idle[Math.floor(Math.random() * idle.length)];
            var others = idle.filter(function (x) { return x !== speaker; });
            var weather = Math.random() < 0.25;
            var kindT = weather ? 'weatherAsk' : timeKind(vnHour());
            if (weather || !others.length || Math.random() < 0.5) {
              chatRun([{ target: speaker, text: pickChatLine(kindT, { to: chatMode === 'vi' ? 'anh Zon' : 'Zon' }, chatMode), delay: 0 }]);
            } else {
              var other = others[Math.floor(Math.random() * others.length)];
              var otherSeat = (chatSnap.seats || []).filter(function (x) { return x.seat === other; })[0];
              chatRun([
                { target: speaker, text: pickChatLine(kindT, { to: agentLabel(otherSeat && otherSeat.agent) || other }, chatMode), delay: 0 },
                { target: other, text: pickChatLine('timeAck', {}, chatMode), delay: 1800 }
              ]);
            }
          } else if (runner && goal && idle.length >= 2 && Math.random() < 0.7) {
            var pv = { goal: chatTrim(goal.title, 32), ticket: runner.ticket || 'G' + goal.n, runner: agentLabel(runner.agent) };
            var order = idle.slice().sort(function () { return Math.random() - 0.5; });
            var talk = [
              { target: order[0], text: pickChatLine('projectChit', pv, chatMode), delay: 0 },
              { target: order[1], text: pickChatLine('projectChitAck', pv, chatMode), delay: 1800 }
            ];
            if (order[2] && Math.random() < 0.6) talk.push({ target: order[2], text: pickChatLine('projectChit3', pv, chatMode), delay: 3600 });
            chatRun(talk);
          } else if (idle.length >= 1 && (idle.length === 1 || Math.random() < 0.5)) {
            chatRun([{ target: idle[Math.floor(Math.random() * idle.length)], text: pickChatLine('chitOwner', {}, chatMode), delay: 0 }]);
          } else if (idle.length >= 2) {
            var a = idle[Math.floor(Math.random() * idle.length)];
            var b = idle.filter(function (s) { return s !== a; })[Math.floor(Math.random() * (idle.length - 1))];
            chatRun([
              { target: a, text: pickChatLine('chit', {}, chatMode), delay: 0 },
              { target: b, text: pickChatLine('chitAck', {}, chatMode), delay: 1500 }
            ]);
          }
        }
      }
      setInterval(chatTick, 30000);
      // Anh gửi Command: bong bóng của anh ngay, người nhận (không đang chạy) đáp lệch nhau.
      function chatOwnerSays(text, to) {
        if (chatMode === 'off') return;
        var steps = [{ target: 'owner', text: chatTrim(text, 80), delay: 0 }];
        chatTargetsFor(to, chatSnap).forEach(function (seat, i) {
          steps.push({ target: seat, text: pickChatLine('ownerAck', {}, chatMode), delay: 1500 + i * 300 });
        });
        chatRun(steps);
      }
      function chatReset() {
        chatTimers.forEach(clearTimeout);
        chatTimers = [];
        chatBusyUntil = 0;
        chatPending = {};
        document.querySelectorAll('.chat-bubble').forEach(function (el) { if (el.parentNode) el.parentNode.removeChild(el); });
        chatWaiting = {};
      }
      var chatThoughtSeen = {};
      var chatThoughtAt = {};
      // Agent đang chạy "nghĩ thành tiếng" khi Last log đổi: tối đa 1 lần mỗi 60–90 s, không vào hàng đợi thoại.
      function chatThoughts(state) {
        var now = chatNow();
        ((state && state.seats) || []).forEach(function (s) {
          if (s.status !== 'running' || !s.agent) return;
          var line = chatThoughtLine(s.lastLine || s.agentStatus);
          if (!line || chatThoughtSeen[s.seat] === line) return;
          if (now - (chatThoughtAt[s.seat] || 0) < 60000 + Math.random() * 30000) return;
          chatThoughtSeen[s.seat] = line;
          chatThoughtAt[s.seat] = now;
          var lead = Math.random() < 0.4 ? pickChatLine('thoughtLead', {}, chatMode) : '';
          chatShow(s.seat, '💭 ' + lead + line, false, true, true);
        });
      }
      function chatOnSnapshot(state) {
        var events = chatEvents(chatSnap, state);
        chatSnap = state;
        chatPlay(events, state);
        if (chatMode !== 'off') chatThoughts(state);
        Object.keys(chatWaiting).forEach(function (t) { var a = chatAnchor(t); if (a) chatPlace(chatWaiting[t], a); else chatClearWaiting(t); });
      }
      (function () {
        var sel = document.getElementById('chat-toggle');
        if (!sel) return;
        sel.value = chatMode;
        sel.addEventListener('change', function () {
          chatMode = sel.value;
          try { window.localStorage.setItem('btm.chat', chatMode); } catch (e) {}
          if (chatMode === 'off') chatReset();
        });
      })();

      function renderSnapshot(state) {
        agentNames = (state && state.settings && state.settings.names) || {};
        agentAvatars = (state && state.settings && state.settings.avatars) || {};
        if (!state) return;
        latestSnapshot = state;
        renderShell(state);
        // Bong bóng thoại: chạy sau, không chặn render; lỗi ở đây không được làm hỏng dashboard.
        setTimeout(function () { try { chatOnSnapshot(state); } catch (e) {} }, 0);

        // Project
        if (projectBadge) {
          projectBadge.textContent = state.project ? tx('bar.project', { name: state.project }) : tx('bar.noProject');
        }

        // Settings
        if (autoApproveToggle && state.settings && typeof state.settings.autoApprove === 'boolean') {
          autoApproveToggle.checked = state.settings.autoApprove;
        }

        // Session & Turns
        if (state.session) {
          if (sessionBadge) sessionBadge.textContent = tx('bar.session', { id: state.session.id, status: formatStatus(state.session.status) });
          if (turnsBadge) turnsBadge.textContent = tx('bar.turns', { used: state.session.turnsUsed, max: state.session.maxTurns });
        } else {
          if (sessionBadge) sessionBadge.textContent = tx('bar.noSession');
          if (turnsBadge) turnsBadge.textContent = tx('bar.turns', { used: 0, max: 0 });
        }

        if (approveBtn) {
          updateApproveButton(state);
        }

        // Holder
        if (state.holder) {
          var seatObj = (state.seats || []).find(function (s) { return s.seat === state.holder; });
          var holderName = seatObj ? formatAgentDisplayName(seatObj.agent, seatObj.seat) : formatLogWho(state.holder, state.seats);
          if (holderText) holderText.textContent = tx('bar.holder', { seat: holderName });
          setDisplay(holderDot, true, 'inline-block');
        } else {
          if (holderText) holderText.textContent = tx('bar.noHolder');
          setDisplay(holderDot, false);
        }

        // Seats (pm, dev, qc, audit)
        var seatsMap = {};
        if (Array.isArray(state.seats)) {
          state.seats.forEach(function (s) {
            seatsMap[s.seat] = s;
          });
        }
        var isBusy = (state.session && state.session.status === 'running') || Boolean(state.holder);
        renderAgentCounts(state.seats);
        renderSeat('pm', seatsMap['pm'], state.holder === 'pm', isBusy);
        renderSeat('dev', seatsMap['dev'], state.holder === 'dev', isBusy);
        renderSeat('qc', seatsMap['qc'], state.holder === 'qc', isBusy);
        if (seatsMap['audit']) {
          setDisplay(document.getElementById('seat-card-audit'), true, 'flex');
          renderSeat('audit', seatsMap['audit'], state.holder === 'audit', isBusy);
        } else {
          setDisplay(document.getElementById('seat-card-audit'), false);
        }

        // Goals & Pipeline & Tickets
        renderGoals(state.goals, state.seats);
        setTrashCount(state.trash);
        var trashBox = document.getElementById('goals-trash');
        if (trashBox && !trashBox.hidden && trashBox.getAttribute('data-count') !== String(state.trash || 0)) {
          trashBox.setAttribute('data-count', String(state.trash || 0));
          loadTrash();
        }

        // Logs
        if (logList) {
          logList.classList.toggle('log-only-err', logFilterValue() === 'err');
          clearChildren(logList);
          var logs = Array.isArray(state.log) ? state.log : [];
          if (logs.length === 0) {
            var emptyLog = document.createElement('div');
            emptyLog.className = 'empty-placeholder';
            emptyLog.textContent = tx('log.empty');
            logList.appendChild(emptyLog);
          } else {
            logs.forEach(function (item) {
              var row = document.createElement('div');
              row.className = 'log-item';

              var time = document.createElement('span');
              time.className = 'log-time';
              time.textContent = formatTime(item.at);
              row.appendChild(time);

              var who = document.createElement('span');
              who.className = 'log-who';
              var whoDisplay = formatLogWho(item.who, state.seats);
              who.textContent = '[' + (whoDisplay || 'info') + ']';
              row.appendChild(who);

              var text = document.createElement('span');
              text.className = 'log-text';
              text.textContent = item.text || '';
              row.appendChild(text);
              if (isLogError(item.text)) row.classList.add('log-err');

              logList.appendChild(row);
            });
          }
        }

        // Phiên + hàng đợi (gộp Session goals vào đây cho gọn)
        // Lịch sử chung (anh Zon 2026-11-14): goal đang chạy + lệnh + câu hỏi kèm câu trả lời, một danh sách.
        if (queueList) renderHistory(queueList, state);

        // Notes
        renderNotes(state.notes);

        // Recipient radios
        if (state.seats) {
          renderRecipients(state.seats);
        }

        // Accounts
        lastAccounts = Array.isArray(state.accounts) ? state.accounts : [];
        lastSshHint = state.sshHint;
        renderAccounts(state.accounts, state.sshHint);
        renderSeatWarnings(state.seatWarnings);
        renderQuestions(state.questions);
      }

      function renderAccounts(accounts, sshHint) {
        var container = document.getElementById('accounts-list');
        if (!container) return;
        // Đang gõ model / chọn effort: không vẽ lại kẻo mất chữ đang nhập.
        var active = document.activeElement;
        if (active && container.contains(active) && active.tagName === 'SELECT') return;
        clearChildren(container);

        if (!Array.isArray(accounts) || accounts.length === 0) {
          var empty = document.createElement('div');
          empty.className = 'empty-placeholder';
          empty.textContent = tx('acc.empty');
          container.appendChild(empty);
          return;
        }

        var sshTarget = getSshTarget(sshHint);

        accounts.forEach(function (acc) {
          var row = document.createElement('div');
          row.className = 'account-row';

          var lDisp = getLoginDisplay(acc.login);
          // Đầu thẻ: đèn đăng nhập · "Tên · accounts: N" ✎ | chip công cụ · user
          var head = document.createElement('div');
          head.className = 'acc-card-head';
          var headDot = document.createElement('span');
          headDot.className = 'login-dot ' + lDisp.dotClass;
          headDot.setAttribute('aria-hidden', 'true');
          head.appendChild(headDot);
          var nameEl = document.createElement('span');
          nameEl.className = 'account-name';
          nameEl.textContent = acc.agent;
          head.appendChild(nameEl);
          var sep = document.createElement('span');
          sep.className = 'acc-head-sep';
          head.appendChild(sep);
          var toolEl = document.createElement('span');
          toolEl.className = 'account-tool acc-tool-chip';
          var toolFull = (acc.tool || '') + (acc.user ? ' · ' + acc.user : '');
          // user dài (tài khoản phụ) thì chip chỉ hiện công cụ, đủ chữ ở title
          toolEl.textContent = acc.user && acc.user.length <= 12 ? toolFull : (acc.tool || '');
          toolEl.title = toolFull;
          head.appendChild(toolEl);
          row.appendChild(head);
          row.appendChild(buildModelControls(acc));

          var info = document.createElement('div');
          info.className = 'account-info';
          var loginWrap = document.createElement('div');
          loginWrap.className = 'account-login';

          var dot = document.createElement('span');
          dot.className = 'login-dot ' + lDisp.dotClass;
          loginWrap.appendChild(dot);

          var loginTxt = document.createElement('span');
          loginTxt.textContent = lDisp.text;
          loginWrap.appendChild(loginTxt);

          info.appendChild(loginWrap);
          var accWarn = energyWarnChip(acc.energy);
          if (accWarn) info.appendChild(accWarn);

          if (acc.login && acc.login.detail && acc.login.detail !== lDisp.text) {
            var detailEl = document.createElement('span');
            detailEl.className = 'account-detail';
            detailEl.textContent = '(' + acc.login.detail + ')';
            info.appendChild(detailEl);
          }

          row.appendChild(info);

          var cmdWrap = document.createElement('div');
          cmdWrap.className = 'account-cmd-wrap';

          var cmdStr = getLoginCommand(acc.tool, sshTarget, acc.user);
          var cmdBox = document.createElement('div');
          cmdBox.className = 'acc-cmd-box';
          var prefix = document.createElement('span');
          prefix.className = 'acc-cmd-prefix';
          prefix.setAttribute('aria-hidden', 'true');
          prefix.textContent = '>_';
          cmdBox.appendChild(prefix);
          var codeEl = document.createElement('input');
          codeEl.type = 'text';
          codeEl.readOnly = true;
          codeEl.className = 'account-cmd-code';
          codeEl.value = cmdStr;
          codeEl.setAttribute('aria-label', tx('acc.loginCmdFor', { agent: acc.agent }));
          cmdBox.appendChild(codeEl);
          cmdWrap.appendChild(cmdBox);

          var copyBtn = document.createElement('button');
          copyBtn.className = 'btn btn-secondary btn-sm copy-btn';
          copyBtn.setAttribute('type', 'button');
          copyBtn.setAttribute('aria-label', tx('acc.copyLoginFor', { agent: acc.agent }));
          copyBtn.textContent = '⧉ ' + tx('acc.copy');

          copyBtn.addEventListener('click', function () {
            copyLoginCommand(cmdStr, codeEl, copyBtn);
          });

          cmdWrap.appendChild(copyBtn);
          row.appendChild(cmdWrap);

          // Plan 7: tên Worker + danh sách tài khoản theo thứ tự (lọc theo tab).
          var items = Array.isArray(acc.accounts) ? acc.accounts : [];
          nameEl.textContent = tx('acc.workerTitle', { name: agentLabel(acc.agent), n: items.length || 1 });
          var renameBtn = document.createElement('button');
          renameBtn.type = 'button';
          renameBtn.className = 'acc-rename-btn';
          renameBtn.textContent = '✎';
          renameBtn.setAttribute('aria-label', tx('acc.renameFor', { agent: acc.agent }));
          renameBtn.title = tx('acc.renameFor', { agent: acc.agent });
          renameBtn.addEventListener('click', function () { renameAgent(acc.agent); });
          nameEl.insertAdjacentElement('afterend', renameBtn);
          var shown = items;
          var awake = shown.filter(function (a) { return a.active; });
          var sleeping = shown.filter(function (a) { return !a.active; });
          var primary = awake.find(function (a) { return a.status === 'in_use'; }) || awake[0];
          if (awake.length) row.appendChild(buildAccountItems(acc, awake, sshTarget, primary));
          if (sleeping.length) {
            var open = Boolean(accSleepOpen[acc.agent]);
            var toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'acc-sleep-toggle';
            toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
            toggle.textContent = (open ? '▾ ' : '▸ ') + tx('acc.sleepingN', { n: sleeping.length });
            toggle.addEventListener('click', function () {
              var agent = acc.agent;
              clearTimeout(accSleepOpen[agent]);
              if (accSleepOpen[agent]) delete accSleepOpen[agent];
              else accSleepOpen[agent] = setTimeout(function () { delete accSleepOpen[agent]; renderAccounts(lastAccounts, lastSshHint); }, ACC_SLEEP_COLLAPSE_MS);
              renderAccounts(lastAccounts, lastSshHint);
            });
            row.appendChild(toggle);
            if (open) row.appendChild(buildAccountItems(acc, sleeping, sshTarget));
          }

          container.appendChild(row);
        });
      }

      // ===== Plan 7: tài khoản của Worker =====
      // Danh sách tài khoản ngủ: mở theo Worker, tự gập sau 3 phút (giống Team inbox).
      var ACC_SLEEP_COLLAPSE_MS = 3 * 60 * 1000;
      var accSleepOpen = {};
      // Nút ▸/▾ cạnh tab: mở chi tiết mọi Worker, tự thu gọn sau 3 phút. Thu gọn chỉ còn dòng tài khoản đang dùng.
      var accDetailsTimer = null;
      function syncAccDetails() {
        var list = document.getElementById('accounts-list');
        var btn = document.getElementById('acc-details-toggle');
        var open = accDetailsTimer !== null;
        if (list) list.classList.toggle('acc-collapsed', !open);
        if (btn) {
          btn.textContent = open ? '▾' : '▸';
          btn.setAttribute('aria-expanded', open ? 'true' : 'false');
          btn.setAttribute('aria-label', tx(open ? 'acc.detailsHide' : 'acc.details'));
        }
      }
      (function () {
        var btn = document.getElementById('acc-details-toggle');
        if (btn) btn.addEventListener('click', function () {
          if (accDetailsTimer !== null) { clearTimeout(accDetailsTimer); accDetailsTimer = null; }
          else accDetailsTimer = setTimeout(function () { accDetailsTimer = null; syncAccDetails(); }, ACC_SLEEP_COLLAPSE_MS);
          syncAccDetails();
        });
        syncAccDetails();
      })();
      var lastAccounts = [];
      var lastSshHint = null;


      async function accountPost(key, body) {
        try {
          await postJson('/api/accounts/' + encodeURIComponent(key), body);
        } catch (err) {
          showFeedback(topFeedback, err.message, true);
        }
      }

      var ACC_STATUS = { in_use: 'acc.st.in_use', next: 'acc.st.next', free: 'acc.st.free', sleeping: 'acc.st.sleeping', relogin: 'acc.st.relogin' };
      function statusText(a) {
        if (a.status === 'limited') return tx('acc.st.limited', { time: a.resetsAt ? formatTime(a.resetsAt) : '—' });
        return tx(ACC_STATUS[a.status] || 'acc.st.free');
      }

      function buildAccountItems(worker, items, sshTarget, primary) {
        var box = document.createElement('div');
        box.className = 'acc-items';
        items.forEach(function (a) {
          var line = document.createElement('div');
          line.className = 'acc-item' + (a === primary ? ' acc-primary' : '');

          var name = document.createElement('span');
          name.className = 'acc-item-name' + (a.email ? '' : ' acc-slug-pill');
          name.textContent = a.slug;
          line.appendChild(name);

          if (a.email) {
            var email = document.createElement('span');
            email.className = 'acc-item-email';
            email.textContent = a.email;
            email.title = a.email;
            line.appendChild(email);
          }

          var badge = document.createElement('span');
          badge.className = 'acc-badge st-' + a.status;
          badge.textContent = statusText(a);
          line.appendChild(badge);

          var ctrl = document.createElement('span');
          ctrl.className = 'acc-ctrl';

          var activeWrap = document.createElement('label');
          var active = document.createElement('input');
          active.type = 'checkbox';
          active.checked = Boolean(a.active);
          active.setAttribute('aria-label', tx('acc.activeFor', { key: a.key }));
          active.addEventListener('change', function () { accountPost(a.key, { active: active.checked }); });
          activeWrap.appendChild(active);
          activeWrap.appendChild(document.createTextNode(' ' + tx('acc.activeHere')));
          ctrl.appendChild(activeWrap);

          [['up', '↑', tx('acc.up', { key: a.key })], ['down', '↓', tx('acc.down', { key: a.key })]].forEach(function (d) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'btn btn-secondary btn-xs';
            b.textContent = d[1];
            b.setAttribute('aria-label', d[2]);
            b.addEventListener('click', function () { accountPost(a.key, { move: d[0] }); });
            ctrl.appendChild(b);
          });

          if (worker.tool !== 'antigravity-cli') {
            var signIn = document.createElement('button');
            signIn.type = 'button';
            signIn.className = 'btn btn-secondary btn-xs';
            signIn.textContent = tx('acc.signIn');
            signIn.setAttribute('aria-label', tx('acc.signInFor', { key: a.key }));
            signIn.addEventListener('click', async function () {
              try {
                var res = await postJson('/api/accounts/' + encodeURIComponent(a.key) + '/login', {});
                accAddPanel.hidden = false;
                pollLogin(res.loginId, res.key);
              } catch (err) {
                showFeedback(topFeedback, err.message, true);
              }
            });
            ctrl.appendChild(signIn);
          }

          var copy = document.createElement('button');
          copy.type = 'button';
          copy.className = 'btn btn-secondary btn-xs';
          copy.textContent = tx('acc.copy');
          copy.setAttribute('aria-label', tx('acc.copyLoginItem', { key: a.key }));
          var cmd = getLoginCommand(worker.tool, sshTarget, a.user);
          copy.addEventListener('click', function () { copyLoginCommand(cmd, null, copy); });
          ctrl.appendChild(copy);

          line.appendChild(ctrl);
          box.appendChild(line);
        });
        return box;
      }

      // Add Account
      var accAddPanel = document.getElementById('acc-add-panel');
      var accAddWorker = document.getElementById('acc-add-worker');
      var accAddAgy = document.getElementById('acc-add-agy');
      var accAddJson = document.getElementById('acc-add-json');
      var accLogin = document.getElementById('acc-login');
      var accLoginTimer = null;

      function workerTool(agent) {
        var w = lastAccounts.find(function (x) { return x.agent === agent; });
        return w ? w.tool : '';
      }
      function syncAddForm() {
        accAddAgy.hidden = workerTool(accAddWorker.value) !== 'antigravity-cli';
      }
      document.getElementById('acc-add-btn').addEventListener('click', function () {
        clearChildren(accAddWorker);
        lastAccounts.forEach(function (w) {
          var o = document.createElement('option');
          o.value = w.agent;
          o.textContent = w.agent + ' · ' + w.tool;
          accAddWorker.appendChild(o);
        });
        accAddPanel.hidden = false;
        accLogin.hidden = true;
        syncAddForm();
      });
      accAddWorker.addEventListener('change', syncAddForm);
      document.getElementById('acc-add-cancel').addEventListener('click', function () {
        accAddPanel.hidden = true;
        if (accLoginTimer) { clearInterval(accLoginTimer); accLoginTimer = null; }
      });
      document.getElementById('acc-add-json-file').addEventListener('change', async function (e) {
        var f = e.target.files && e.target.files[0];
        if (f) accAddJson.value = await f.text();
      });

      function showLogin(view, key) {
        accLogin.hidden = false;
        var msg = document.getElementById('acc-login-msg');
        var link = document.getElementById('acc-login-link');
        var code = document.getElementById('acc-login-code');
        var codeRow = document.getElementById('acc-login-code-row');
        var url = view && typeof view.url === 'string' && view.url.indexOf('https://') === 0 ? view.url : '';
        link.textContent = url;
        if (url) link.href = url; else link.removeAttribute('href');
        code.textContent = (view && view.code) || '';
        codeRow.hidden = !(view && view.state === 'needs_code');
        if (!view) msg.textContent = '';
        else if (view.state === 'done') msg.textContent = tx('acc.loginDone', { key: key });
        else if (view.state === 'failed') msg.textContent = tx('acc.loginFailed', { error: view.error || '' });
        else msg.textContent = view.state === 'needs_code' ? tx('acc.loginCode') : tx('acc.loginOpen');
      }

      function pollLogin(id, key) {
        if (accLoginTimer) clearInterval(accLoginTimer);
        var tickLogin = async function () {
          try {
            var res = await fetch('/api/accounts/login/' + id, { headers: { 'x-btm': '1' } });
            var view = await res.json();
            showLogin(view, key);
            if (view.state === 'done' || view.state === 'failed') { clearInterval(accLoginTimer); accLoginTimer = null; }
          } catch (e) {}
        };
        accLoginTimer = setInterval(tickLogin, 2000);
        tickLogin();
        document.getElementById('acc-login-code-send').onclick = async function () {
          var input = document.getElementById('acc-login-code-input');
          try {
            await postJson('/api/accounts/login/' + id + '/code', { code: input.value.trim() });
            input.value = '';
          } catch (err) {
            showFeedback(topFeedback, err.message, true);
          }
        };
      }

      document.getElementById('acc-add-create').addEventListener('click', async function () {
        var body = { agent: accAddWorker.value, slug: document.getElementById('acc-add-slug').value.trim() };
        if (!accAddAgy.hidden) {
          try { body.agy = JSON.parse(accAddJson.value); } catch (e) { showFeedback(topFeedback, tx('acc.badJson'), true); return; }
        }
        try {
          var res = await postJson('/api/accounts', body);
          accAddJson.value = '';
          showFeedback(topFeedback, tx('acc.created', { key: res.key }), false);
          if (res.loginId) pollLogin(res.loginId, res.key);
          else accAddPanel.hidden = true;
        } catch (err) {
          showFeedback(topFeedback, err.message, true);
        }
      });

      // Export: file JSON có token đăng nhập → tải xuống, không hiển thị.
      document.getElementById('acc-export-btn').addEventListener('click', async function () {
        try {
          var res = await fetch('/api/accounts/export', { method: 'POST', headers: { 'x-btm': '1', 'content-type': 'application/json' }, body: '{}' });
          if (!res.ok) { var b = await res.json().catch(function () { return {}; }); throw new Error(b.error || tx('fb.serverError', { status: res.status })); }
          var blob = await res.blob();
          var m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '');
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = m ? m[1] : 'btm-accounts.json';
          document.body.appendChild(a);
          a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
          showFeedback(topFeedback, tx('acc.exported'), false);
        } catch (err) {
          showFeedback(topFeedback, err.message, true);
        }
      });

      // Import: xem trước (dryRun) → tick ghi đè → Import.
      var accImportFile = document.getElementById('acc-import-file');
      var accImportPanel = document.getElementById('acc-import-panel');
      var accImportData = null;
      document.getElementById('acc-import-btn').addEventListener('click', function () { accImportFile.value = ''; accImportFile.click(); });
      accImportFile.addEventListener('change', async function () {
        var f = accImportFile.files && accImportFile.files[0];
        if (!f) return;
        var rawText = await f.text();
        try {
          // Chấp nhận dấu phẩy thừa trước ] hoặc } (file Antigravity sửa tay hay có).
          try { accImportData = JSON.parse(rawText); } catch (e1) { accImportData = JSON.parse(rawText.replace(/,\s*([\]}])/g, '$1')); }
        } catch (e) {
          showFeedback(topFeedback, tx('acc.badJson'), true);
          return;
        }
        try {
          var dry = await postJson('/api/accounts/import', { file: accImportData, dryRun: true });
          var sum = document.getElementById('acc-import-summary');
          clearChildren(sum);
          var add = function (text) { var d = document.createElement('div'); d.textContent = text; sum.appendChild(d); return d; };
          if (dry.new.length) add(tx('acc.importNew', { list: dry.new.join(', ') }));
          if (dry.conflicts.length) {
            add(tx('acc.importConflicts'));
            dry.conflicts.forEach(function (c) {
              var l = document.createElement('label');
              var cb = document.createElement('input');
              cb.type = 'checkbox';
              cb.className = 'acc-overwrite';
              cb.value = c;
              l.appendChild(cb);
              l.appendChild(document.createTextNode(' ' + c));
              add('').appendChild(l);
            });
          }
          dry.rejected.forEach(function (r) { add(tx('acc.importRejected', { entry: r.entry, reason: r.reason })); });
          if (!dry.new.length && !dry.conflicts.length) add(tx('acc.importNothing'));
          accImportPanel.hidden = false;
        } catch (err) {
          showFeedback(topFeedback, err.message, true);
        }
      });
      document.getElementById('acc-import-cancel').addEventListener('click', function () { accImportPanel.hidden = true; accImportData = null; });
      document.getElementById('acc-import-confirm').addEventListener('click', async function () {
        if (!accImportData) return;
        var overwrite = Array.from(accImportPanel.querySelectorAll('.acc-overwrite')).filter(function (c) { return c.checked; }).map(function (c) { return c.value; });
        try {
          var res = await postJson('/api/accounts/import', { file: accImportData, overwrite: overwrite });
          var msg = tx('acc.imported', { n: res.imported.length });
          res.failed.forEach(function (x) { msg += ' · ' + x.entry + ': ' + x.reason; });
          showFeedback(topFeedback, msg, res.failed.length > 0);
          accImportPanel.hidden = true;
          accImportData = null;
        } catch (err) {
          showFeedback(topFeedback, err.message, true);
        }
      });

      // 5. Connect SSE
      function connectSSE() {
        var es = new EventSource('/api/events');
        es.addEventListener('state', function (e) {
          setDisplay(connBanner, false);
          try {
            var snapshot = JSON.parse(e.data);
            renderSnapshot(snapshot);
          } catch (err) {}
        });

        es.onerror = function () {
          setDisplay(connBanner, true, 'block');
        };
      }
      connectSSE();

      // 6. Action Handlers
      var initialCopyBtns = document.querySelectorAll('.copy-btn');
      initialCopyBtns.forEach(function (btn) {
        btn.addEventListener('click', function () {
          var wrap = btn.closest('.account-cmd-wrap');
          var input = wrap ? wrap.querySelector('.account-cmd-code') : null;
          var text = input ? (input.value || input.textContent) : '';
          copyLoginCommand(text, input, btn);
        });
      });

      var refreshEnergyBtn = document.getElementById('refresh-energy-btn');
      if (refreshEnergyBtn) {
        refreshEnergyBtn.addEventListener('click', async function () {
          refreshEnergyBtn.disabled = true;
          try {
            var res = await postJson('/api/energy/refresh', {});
            if (res && res.error) {
              showFeedback(topFeedback, res.error, true);
            } else {
              showFeedback(topFeedback, tx('fb.energyRefreshed'), false);
            }
          } catch (err) {
            showFeedback(topFeedback, err.message, true);
          } finally {
            refreshEnergyBtn.disabled = false;
          }
        });
      }

      ['pm', 'dev', 'qc', 'audit'].forEach(function (sk) {
        var selectEl = document.getElementById(sk + '-agent-select');
        if (selectEl) {
          selectEl.addEventListener('change', async function () {
            var newAgent = selectEl.value;
            try {
              var res = await postJson('/api/seat', { seat: sk, agent: newAgent });
              if (res && res.error) {
                showFeedback(topFeedback, res.error, true);
              } else {
                showFeedback(topFeedback, tx('fb.seatChanged', { seat: SEAT_LABELS[sk] || sk }), false);
              }
            } catch (err) {
              showFeedback(topFeedback, err.message, true);
              if (latestSnapshot && Array.isArray(latestSnapshot.seats)) {
                var prevCard = latestSnapshot.seats.find(function (s) { return s.seat === sk; });
                if (prevCard) {
                  selectEl.value = prevCard.agent;
                }
              }
            }
          });
        }
      });

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

      if (stopBtn) {
        stopBtn.addEventListener('click', async function () {
          var yesAll = await askOwner({
            who: tx('ask.team'),
            text: tx('ask.stopAll'),
            note: tx('ask.stopAllNote'),
            ok: tx('ask.yesStopAll'),
            cancel: tx('ask.keepAll'),
          });
          if (!yesAll) return;
          stopBtn.disabled = true;
          try {
            var res = await postJson('/api/stop', {});
            if (res && res.error) {
              showFeedback(topFeedback, res.error, true);
            } else {
              showFeedback(topFeedback, tx('fb.stopSent'), false);
            }
          } catch (err) {
            showFeedback(topFeedback, err.message, true);
          } finally {
            stopBtn.disabled = false;
          }
        });
      }

      if (approveBtn) {
        approveBtn.addEventListener('click', async function () {
          var status = latestSnapshot && latestSnapshot.session ? latestSnapshot.session.status : null;
          var isResume = status === 'needs_owner' || status === 'stopped' || status === 'out_of_turns';
          var endpoint = isResume ? '/api/resume' : '/api/approve';
          var successMsg = isResume ? tx('fb.resumeSent') : tx('fb.approved');
          approveBtn.disabled = true;
          try {
            var res = await postJson(endpoint, {});
            if (res && res.error) {
              showFeedback(topFeedback, res.error, true);
            } else {
              showFeedback(topFeedback, successMsg, false);
            }
          } catch (err) {
            showFeedback(topFeedback, err.message, true);
          } finally {
            updateApproveButton(latestSnapshot);
          }
        });
      }

      if (autoApproveToggle) {
        autoApproveToggle.addEventListener('change', async function () {
          var checked = autoApproveToggle.checked;
          try {
            var res = await postJson('/api/settings', { autoApprove: checked });
            if (res && res.error) {
              showFeedback(topFeedback, res.error, true);
              autoApproveToggle.checked = !checked;
            }
          } catch (err) {
            showFeedback(topFeedback, err.message, true);
            autoApproveToggle.checked = !checked;
          }
        });
      }

      var cmdSendBtn = document.getElementById('cmd-send-btn');
      var cmdTextArea = document.getElementById('cmd-text');

      if (cmdTextArea) {
        // Nút Mic (anh Zon 2026-11-14): Web Speech API có sẵn trong Chrome/Edge, chữ hiện dần vào ô Command,
        // anh xem lại rồi tự gửi. Trình duyệt không hỗ trợ thì ẩn nút. Âm thanh do trình duyệt gửi đi nhận diện.
        (function () {
          var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
          var group = document.getElementById('mic-group');
          var btn = document.getElementById('mic-btn');
          var lang = document.getElementById('mic-lang');
          if (!SR || !group || !btn || !lang) return;
          group.hidden = false;
          try { var ml = window.localStorage.getItem('btm.micLang'); if (ml === 'vi-VN' || ml === 'en-US') lang.value = ml; } catch (e) {}
          lang.addEventListener('change', function () { try { window.localStorage.setItem('btm.micLang', lang.value); } catch (e) {} });
          var rec = null;
          var base = '';
          function setOn(on) {
            btn.classList.toggle('recording', on);
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
            btn.title = tx(on ? 'mic.stop' : 'mic.start');
          }
          btn.addEventListener('click', function () {
            if (rec) { rec.stop(); return; }
            rec = new SR();
            rec.lang = lang.value;
            rec.interimResults = true;
            rec.continuous = true;
            base = cmdTextArea.value.replace(/\s+$/, '');
            rec.onresult = function (ev) {
              var heard = '';
              for (var i = 0; i < ev.results.length; i++) heard += ev.results[i][0].transcript;
              cmdTextArea.value = (base ? base + ' ' : '') + heard.trim();
            };
            rec.onerror = function (ev) {
              // Tách lỗi để biết sửa ở đâu: trình duyệt chặn / dịch vụ nhận diện bị chặn / không có mic (vd RDP chưa chuyển mic).
              var key = ev.error === 'not-allowed' ? 'mic.blocked' : ev.error === 'service-not-allowed' ? 'mic.service' : ev.error === 'audio-capture' ? 'mic.none' : null;
              showFeedback(cmdFeedback, key ? tx(key) : tx('mic.error', { err: ev.error }), true);
            };
            rec.onend = function () { rec = null; setOn(false); cmdTextArea.focus(); };
            try {
              rec.start();
              setOn(true);
              showFeedback(cmdFeedback, tx('mic.listening'), false);
            } catch (err) {
              rec = null;
              setOn(false);
              showFeedback(cmdFeedback, tx('mic.error', { err: err.message }), true);
            }
          });
        })();
        // Ctrl+Enter (Cmd+Enter trên Mac) = bấm Send.
        cmdTextArea.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && cmdSendBtn && !cmdSendBtn.disabled) { e.preventDefault(); cmdSendBtn.click(); }
        });
        cmdTextArea.addEventListener('paste', function (e) {
          var checkedRadio = document.querySelector('input[name="cmd-to"]:checked');
          var to = checkedRadio ? checkedRadio.value : 'team';
          if (to !== 'team' && to !== 'auto') return;
          if (e.clipboardData && e.clipboardData.items) {
            for (var i = 0; i < e.clipboardData.items.length; i++) {
              var item = e.clipboardData.items[i];
              if (item.type && item.type.startsWith('image/')) {
                var file = item.getAsFile();
                if (file) {
                  processImageFile(file);
                  break;
                }
              }
            }
          }
        });
      }

      // Chat Auto: hỏi / bàn kế hoạch → lượt chỉ đọc (ask-<ghế>); goal mới → Finn tóm tắt và chờ anh xác nhận.
      function seatNames() {
        var out = {};
        ((latestSnapshot && latestSnapshot.seats) || []).forEach(function (s) {
          out[s.seat] = [s.seat === 'pm' ? 'pm' : s.seat, agentLabel(s.agent)].concat(s.seat === 'audit' ? ['audit'] : []);
        });
        return out;
      }
      async function sendAuto(text) {
        var c = classifyMessage(text, seatNames());
        if (c.kind === 'unknown') {
          var pick = await askAsSeat('pm', { text: tx('auto.unknown', { text: text.slice(0, 100) }), ok: tx('auto.asAsk'), alt: tx('auto.asGoal'), tone: 'primary', cancel: tx('ask.notYet') });
          if (!pick) return;
          c.kind = pick === 'alt' ? 'goal' : 'ask';
        }
        if (c.kind === 'project') {
          await askAsSeat('pm', { text: tx('auto.project'), note: tx('auto.projectNote'), ok: tx('auto.gotIt'), cancel: tx('ask.keepIt'), tone: 'primary' });
          return;
        }
        if (c.kind === 'goal') {
          var yes = await askAsSeat('pm', { text: tx('auto.goalConfirm', { text: text.slice(0, 160) }), note: tx('auto.goalNote'), ok: tx('q.teamGuardOk'), cancel: tx('q.teamGuardCancel'), tone: 'primary' });
          if (!yes) return;
          var payload = { text: text };
          if (attachedImage && attachedImage.base64) payload.image = { name: attachedImage.name || 'image.png', base64: attachedImage.base64 };
          var rg = await postJson('/api/team-note', payload);
          if (rg && rg.error) { showFeedback(cmdFeedback, rg.error, true); return; }
          showFeedback(cmdFeedback, tx('cmd.noteSent'), false);
          cmdTextArea.value = '';
          clearAttachedImage();
          return;
        }
        var seat = c.kind === 'plan' ? 'pm' : (c.seat || 'pm');
        var r = await postJson('/api/command', { to: 'ask-' + seat, text: (c.kind === 'plan' ? '[plan] ' : '') + text });
        if (r && r.ok === false) { showFeedback(cmdFeedback, r.error || tx('cmd.failed'), true); return; }
        try { chatRun([{ target: seat, text: ackLine(r && r.id, text), delay: 1200, allowRunning: true }]); } catch (e) {}
        var who = agentLabel(((latestSnapshot && latestSnapshot.seats) || []).filter(function (s) { return s.seat === seat; }).map(function (s) { return s.agent; })[0]) || seat.toUpperCase();
        showFeedback(cmdFeedback, tx(c.kind === 'plan' ? 'auto.planSent' : 'auto.askSent', { name: who }), false);
        cmdTextArea.value = '';
      }

      if (cmdSendBtn && cmdTextArea) {
        cmdSendBtn.addEventListener('click', async function () {
          var checkedRadio = document.querySelector('input[name="cmd-to"]:checked');
          var to = checkedRadio ? checkedRadio.value : 'team';
          var text = cmdTextArea.value.trim();

          if (!text) {
            showFeedback(cmdFeedback, tx('cmd.empty'), true);
            return;
          }
          try { chatOwnerSays(text, to); } catch (e) {}

          cmdSendBtn.disabled = true;
          try {
            if (isResumeWord(text)) {
              var rst = latestSnapshot && latestSnapshot.session ? latestSnapshot.session.status : null;
              if (rst === 'needs_owner' || rst === 'stopped' || rst === 'out_of_turns') {
                var rr = await postJson('/api/resume', {});
                if (rr && rr.error) showFeedback(cmdFeedback, rr.error, true);
                else { showFeedback(cmdFeedback, tx('fb.resumeSent'), false); cmdTextArea.value = ''; }
              } else {
                showFeedback(cmdFeedback, tx('cmd.nothingToResume'), true);
              }
              return;
            }
            if (to === 'auto') {
              await sendAuto(text);
              return;
            }
            // Gửi cho PM = tạo GOAL MỚI (không phải hỏi Finn): Finn hỏi lại trước.
            if (to === 'pm') {
              var goPm = await askAsSeat('pm', { text: tx('cmd.pmGuard', { text: text.slice(0, 120) }), note: tx('cmd.pmGuardNote'), ok: tx('q.teamGuardOk'), cancel: tx('q.teamGuardCancel') });
              if (!goPm) return;
            }
            if (to === 'team' && latestSnapshot && (latestSnapshot.questions || []).length > 0) {
              var goOn = await askOwner({
                who: tx('ask.team'),
                text: tx('q.teamGuard'),
                ok: tx('q.teamGuardOk'),
                cancel: tx('q.teamGuardCancel'),
              });
              if (!goOn) return;
            }
            if (to === 'team') {
              var payload = { text: text };
              if (attachedImage && attachedImage.base64) {
                payload.image = {
                  name: attachedImage.name || 'image.png',
                  base64: attachedImage.base64
                };
              }
              var res = await postJson('/api/team-note', payload);
              if (res && res.error) {
                showFeedback(cmdFeedback, res.error, true);
              } else {
                showFeedback(cmdFeedback, tx('cmd.noteSent'), false);
                cmdTextArea.value = '';
                clearAttachedImage();
              }
            } else {
              var res = await postJson('/api/command', { to: to, text: text });
              if (res && res.ok !== false) { try { chatRun([{ target: to, text: ackLine(res.id, text), delay: 1200, allowRunning: true }]); } catch (e) {} }
              if (res && res.ok === false) {
                showFeedback(cmdFeedback, res.error || tx('cmd.failed'), true);
              } else {
                showFeedback(cmdFeedback, tx('cmd.sent'), false);
                cmdTextArea.value = '';
              }
            }
          } catch (err) {
            showFeedback(cmdFeedback, err.message, true);
          } finally {
            cmdSendBtn.disabled = false;
          }
        });
      }

      // ===== Ô Search (anh Zon 2026-11-14): kết quả tạm, không lưu; X xoá; 📋 copy để dán hỏi team. =====
      (function () {
        var input = document.getElementById('search-input');
        var panel = document.getElementById('search-panel');
        var list = document.getElementById('search-list');
        var count = document.getElementById('search-count');
        var clearBtn = document.getElementById('search-clear');
        if (!input || !panel || !list) return; // panel: khung Results (luôn hiện)
        var timer = null;
        var seq = 0;
        var KIND_KEY = { goal: 'search.kind.goal', ticket: 'search.kind.ticket', qa: 'search.kind.qa', history: 'search.kind.history', log: 'search.kind.log' };
        // Ô Results luôn hiện (anh Zon 2026-11-14); trống → dòng hướng dẫn.
        function hide() { seq++; clearChildren(list); count.textContent = ''; list.appendChild(line('empty-placeholder', tx('search.hint'))); }
        function line(cls, text) { var d = document.createElement('div'); d.className = cls; d.textContent = text; return d; }
        function show(hits) {
          clearChildren(list);
          count.textContent = hits.length ? tx('search.count', { n: hits.length }) : '';
          if (!hits.length) { list.appendChild(line('empty-placeholder', tx('search.none'))); return; }
          hits.forEach(function (h) {
            var li = document.createElement('li');
            li.className = 'search-hit';
            li.appendChild(line('search-hit-head', tx(KIND_KEY[h.kind] || 'search.kind.log') + ' · ' + h.title + (h.at ? ' · ' + formatHHmm(h.at) : '')));
            li.appendChild(line('search-hit-text', h.text));
            var copy = document.createElement('button');
            copy.type = 'button';
            copy.className = 'cmd-icon-btn search-copy';
            copy.textContent = '📋';
            copy.title = tx('search.copy');
            copy.setAttribute('aria-label', tx('search.copy'));
            copy.addEventListener('click', function () {
              var text = h.title + '\n' + h.text;
              Promise.resolve(navigator.clipboard && navigator.clipboard.writeText(text)).then(function () {
                copy.textContent = '✓';
                copy.title = tx('search.copied');
                setTimeout(function () { copy.textContent = '📋'; copy.title = tx('search.copy'); }, 1500);
              }).catch(function () {});
            });
            li.appendChild(copy);
            list.appendChild(li);
          });
        }
        async function run() {
          var q = input.value.trim();
          if (!q) { hide(); return; }
          var my = ++seq;
          try {
            var res = await fetch('/api/search?q=' + encodeURIComponent(q), { cache: 'no-store' });
            var data = await res.json();
            if (my === seq) show((data && data.hits) || []);
          } catch (e) {
            if (my === seq) { show([]); count.textContent = tx('search.failed'); }
          }
        }
        hide();
        input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(run, 300); });
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { clearTimeout(timer); run(); }
          if (e.key === 'Escape') { input.value = ''; hide(); }
        });
        clearBtn.addEventListener('click', function () { input.value = ''; hide(); input.focus(); });
      })();
    })();
