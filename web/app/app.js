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
        if (key === 'backup') return tx('mb.badge');
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
          // Truy vết (anh Zon 2026-11-14): tổng + đổi trạng thái + lượt chạy (ai, ghế, bao lâu, kết quả, log).
          var res = await fetch('/api/tickets/' + encodeURIComponent(ticketId) + '/trace');
          if (!res.ok) throw new Error(tx('history.cannotLoad'));
          var trace = await res.json();
          var list = (trace && trace.events) || [];
          clearChildren(containerEl);
          if (list.length === 0) {
            var emptyEl = document.createElement('div');
            emptyEl.className = 'empty-placeholder';
            emptyEl.textContent = tx('history.empty');
            containerEl.appendChild(emptyEl);
            return;
          }
          var tot = trace.totals || {};
          var totEl = document.createElement('div');
          totEl.className = 'history-totals';
          totEl.textContent = tx('history.totals', {
            turns: tot.turns || 0,
            agent: goalsUi.formatDuration(tot.agentMs || 0),
            seats: Object.keys(tot.bySeat || {}).map(function (k) { return (SEAT_LABELS[k] || k) + ' ' + goalsUi.formatDuration(tot.bySeat[k]); }).join(' · '),
            fix: tot.fixRounds || 0,
            ret: tot.returns || 0
          });
          containerEl.appendChild(totEl);
          list.forEach(function (h) {
            var entry = document.createElement('div');
            entry.className = 'history-entry';

            var timeEl = document.createElement('span');
            timeEl.className = 'history-time';
            timeEl.textContent = formatTime(h.at);
            entry.appendChild(timeEl);

            if (h.kind === 'turn') {
              var turnEl = document.createElement('span');
              turnEl.className = 'history-trans';
              turnEl.textContent = tx('history.turn', {
                seat: SEAT_LABELS[h.seat] || h.seat,
                agent: agentLabel(h.agent),
                dur: goalsUi.formatDuration(h.ms || 0),
                result: h.endedAt ? (h.result || '?') + (h.error ? ' – ' + h.error : '') : tx('history.running')
              });
              entry.appendChild(turnEl);
              containerEl.appendChild(entry);
              if (!h.hasLog) return;
              var logBtn = document.createElement('button');
              logBtn.type = 'button';
              logBtn.className = 'history-log-btn';
              logBtn.textContent = tx('history.log');
              entry.appendChild(logBtn);
              var pre = document.createElement('pre');
              pre.className = 'history-log';
              pre.hidden = true;
              containerEl.appendChild(pre);
              logBtn.addEventListener('click', async function () {
                if (!pre.hidden) { pre.hidden = true; logBtn.textContent = tx('history.log'); return; }
                pre.hidden = false;
                logBtn.textContent = tx('history.logHide');
                pre.textContent = tx('history.loading');
                try {
                  var lr = await fetch('/api/turns/' + encodeURIComponent(h.id) + '/log');
                  pre.textContent = lr.ok ? await lr.text() : tx('history.cannotLoad');
                } catch (e) {
                  pre.textContent = tx('history.cannotLoad');
                }
              });
              return;
            }

            var whoEl = document.createElement('span');
            whoEl.className = 'history-who';
            whoEl.textContent = '[' + (h.by || 'system') + ']';
            entry.appendChild(whoEl);

            var transEl = document.createElement('span');
            transEl.className = 'history-trans';
            transEl.textContent = (h.from || 'none') + ' → ' + (h.to || 'none');
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

      // Goals + khung History: web/app/goals.js (nạp trước file này).
      var goalsUi = btmGoals({
        formatStatus: formatStatus, SEAT_LABELS: SEAT_LABELS, agentLabel: agentLabel, clearChildren: clearChildren, formatHHmm: formatHHmm,
        askAsSeat: askAsSeat, showFeedback: showFeedback, openDiff: openDiff, postJson: postJson, topFeedback: topFeedback,
        TASK_TAB_KEYS: TASK_TAB_KEYS, goalTabSelections: goalTabSelections, PIPELINE_STAGES: PIPELINE_STAGES, resolveActiveTab: resolveActiveTab,
        handleTabKeydown: handleTabKeydown, toggleTicketHistory: toggleTicketHistory, formatTime: formatTime
      });
      var formatDuration = goalsUi.formatDuration;
      var renderHistory = goalsUi.renderHistory;
      var renderGoals = goalsUi.renderGoals;

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

      // Thẻ thứ 5 (anh Zon 2026-11-14): Boss luôn có thẻ riêng. Đang ngồi ghế nào thì thẻ hiện lượt của ghế đó.
      function bossCardData(state) {
        var acc = ((state && state.accounts) || []).filter(function (a) { return a.provider === 'zai'; })[0];
        if (!acc) return null;
        var sitting = ((state && state.seats) || []).filter(function (s) { return s.agent === acc.agent; });
        var live = sitting.filter(function (s) { return s.status === 'running'; })[0] || sitting[0];
        var base = live ? Object.assign({}, live) : { status: 'idle', taskId: null, since: null, turns: 0, lastLine: '' };
        base.agent = acc.agent;
        base.tool = acc.tool;
        base.model = acc.model;
        base.login = acc.login;
        base.energy = acc.energy;
        base.candidates = [acc.agent];
        base.also = sitting.map(function (s) { return s.seat; });
        return base;
      }
      function renderBossCard(state, isBusy) {
        var card = document.getElementById('seat-card-backup');
        if (!card) return;
        var data = bossCardData(state);
        setDisplay(card, Boolean(data), 'flex');
        if (!data) return;
        renderSeat('backup', data, state.holder && data.also.indexOf(state.holder) >= 0, isBusy);
        var stop = card.querySelector('.seat-stop-btn');
        if (stop) stop.hidden = true; // Stop theo ghế: dùng nút Stop trên thẻ ghế Boss đang ngồi
        var sel = document.getElementById('backup-agent-select');
        var row = sel && sel.closest('.seat-swap-row');
        if (row) row.hidden = true;
      }
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

      // Bài học (anh Zon 2026-11-14): mở ra thì nạp file; Save ghi cả hai ô.
      (function () {
        var tb = document.getElementById('lessons-toggle');
        var box = document.getElementById('lessons-box');
        var own = document.getElementById('lessons-project');
        var shared = document.getElementById('lessons-shared');
        var save = document.getElementById('lessons-save');
        var fb = document.getElementById('lessons-feedback');
        if (!tb || !box || !own || !shared || !save || !fb) return;
        tb.addEventListener('click', async function () {
          box.hidden = !box.hidden;
          tb.setAttribute('aria-expanded', box.hidden ? 'false' : 'true');
          if (box.hidden) return;
          fb.textContent = '';
          try {
            var r = await fetch('/api/lessons');
            var b = r.ok ? await r.json() : { project: '', shared: '' };
            own.value = b.project || '';
            shared.value = b.shared || '';
            if (!own.value && !shared.value) fb.textContent = tx('lessons.empty');
          } catch (e) {
            fb.textContent = tx('history.cannotLoad');
          }
        });
        save.addEventListener('click', async function () {
          save.disabled = true;
          try {
            await postJson('/api/lessons', { scope: 'project', text: own.value });
            await postJson('/api/lessons', { scope: 'shared', text: shared.value });
            fb.textContent = tx('lessons.saved');
          } catch (e) {
            fb.textContent = e.message;
          } finally {
            save.disabled = false;
          }
        });
      })();

      // Tab Folder: web/app/folders.js (nạp trước file này).
      btmFolders({ clearChildren: clearChildren, agentLabel: agentLabel });

      // Lọc log (mẫu anh Zon): chỉ ẩn/hiện dòng đã có, không đổi dữ liệu.
      function isLogError(t) { return /^(error|timeout|rejected|command_denied|fail)/i.test(String(t || '')); }
      function logFilterValue() { var f = document.getElementById('log-filter'); return f ? f.value : 'all'; }
      (function () {
        var f = document.getElementById('log-filter');
        var ll = document.getElementById('log-list');
        if (f && ll) f.addEventListener('change', function () { ll.classList.toggle('log-only-err', f.value === 'err'); });
      })();


      // Bong bóng thoại: web/app/chat-bubbles.js (nạp trước file này).
      var chatUi = btmChat({ agentLabel: agentLabel, formatHHmm: formatHHmm });
      var chatRun = chatUi.chatRun;
      var chatOwnerSays = chatUi.chatOwnerSays;
      var chatOnSnapshot = chatUi.chatOnSnapshot;

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
        renderBossCard(state, isBusy);

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
        rememberAccounts(state);
        renderAccounts(state.accounts, state.sshHint);
        renderSeatWarnings(state.seatWarnings);
        renderQuestions(state.questions);
      }

      // Accounts: web/app/accounts.js (nạp trước file này).
      var accountsUi = btmAccounts({
        renameAgent: renameAgent, agentLabel: agentLabel, clearChildren: clearChildren, showFeedback: showFeedback,
        getLoginDisplay: getLoginDisplay, copyLoginCommand: copyLoginCommand, getSshTarget: getSshTarget, getLoginCommand: getLoginCommand,
        energyWarnChip: energyWarnChip, buildModelControls: buildModelControls, postJson: postJson, topFeedback: topFeedback, formatTime: formatTime
      });
      var renderAccounts = accountsUi.renderAccounts;
      var rememberAccounts = accountsUi.rememberAccounts;

      // 5. Connect SSE
      function connectSSE() {
        var es = new EventSource('/api/events');
        es.addEventListener('state', function (e) {
          setDisplay(connBanner, false);
          try {
            var snapshot = JSON.parse(e.data);
            renderSnapshot(snapshot);
            paintMbKey(snapshot);
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
        var KIND_KEY = { goal: 'search.kind.goal', ticket: 'search.kind.ticket', qa: 'search.kind.qa', history: 'search.kind.history', log: 'search.kind.log', lesson: 'search.kind.lesson' };
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

      // ===== Boss key (decision 0003): dán key một lần; trang chỉ hiện 4 ký tự cuối. Không bao giờ đọc key ra. =====
      var mbEnabled = true;
      function paintMbKey(snap, st) {
        var card = document.getElementById('mb-key-card');
        if (!card) return;
        if (snap) card.hidden = !((snap.accounts || []).some(function (a) { return a.provider === 'zai'; }));
        st = st || (snap && snap.settings && snap.settings.mb);
        if (!st) return;
        mbEnabled = st.enabled;
        document.getElementById('mb-key-status').textContent = st.set
          ? tx('mb.statusSet', { last4: st.last4, state: tx(st.enabled ? 'mb.on' : 'mb.off') }) : tx('mb.statusNone');
        var toggle = document.getElementById('mb-key-toggle');
        toggle.textContent = tx(st.enabled ? 'mb.disable' : 'mb.enable');
        toggle.disabled = !st.set;
        document.getElementById('mb-key-remove').disabled = !st.set;
      }
      (function () {
        var input = document.getElementById('mb-key-input');
        var fb = document.getElementById('mb-key-feedback');
        if (!input) return;
        async function send(body) {
          var res = await fetch('/api/mb', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-btm': '1' }, body: JSON.stringify(body) });
          var data = await res.json().catch(function () { return {}; });
          if (!res.ok) throw new Error(data.error || tx('cmd.failed'));
          paintMbKey(null, data);
          return data;
        }
        document.getElementById('mb-key-save').addEventListener('click', async function () {
          if (!input.value.trim()) { input.focus(); return; }
          try {
            await send({ action: 'set', key: input.value });
            input.value = '';
            showFeedback(fb, tx('mb.saved'), false);
          } catch (e) { showFeedback(fb, e.message, true); }
        });
        document.getElementById('mb-key-toggle').addEventListener('click', function () {
          send({ action: mbEnabled ? 'disable' : 'enable' }).catch(function (e) { showFeedback(fb, e.message, true); });
        });
        document.getElementById('mb-key-remove').addEventListener('click', async function () {
          if (!(await askOwner({ who: 'Boss', text: tx('mb.removeConfirm'), ok: tx('mb.remove'), cancel: tx('acc.cancel') }))) return;
          send({ action: 'remove' }).catch(function (e) { showFeedback(fb, e.message, true); });
        });
      })();
    })();
