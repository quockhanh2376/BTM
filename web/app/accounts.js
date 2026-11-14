/* BTM dashboard – khu Accounts của Worker (danh sách, thêm, đăng nhập, export/import). Tách từ app.js 2026-11-14, không đổi hành vi.
   Hàm dùng chung của app.js truyền vào qua d; thân hàm giữ nguyên thụt lề cũ. */
    function btmAccounts(d) {
      var renameAgent = d.renameAgent, agentLabel = d.agentLabel, clearChildren = d.clearChildren, showFeedback = d.showFeedback,
        getLoginDisplay = d.getLoginDisplay, copyLoginCommand = d.copyLoginCommand, getSshTarget = d.getSshTarget,
        getLoginCommand = d.getLoginCommand, energyWarnChip = d.energyWarnChip, buildModelControls = d.buildModelControls,
        postJson = d.postJson, topFeedback = d.topFeedback, formatTime = d.formatTime;

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
          // ID Worker (anh Zon 2026-11-14): đối chiếu với log; Boss có nhãn dự phòng mọi ghế.
          var idEl = document.createElement('span');
          idEl.className = 'acc-id';
          idEl.textContent = acc.agent;
          idEl.title = tx('acc.idTitle');
          renameBtn.insertAdjacentElement('afterend', idEl);
          if (acc.provider === 'zai') {
            var bossEl = document.createElement('span');
            bossEl.className = 'acc-boss-badge';
            bossEl.textContent = tx('mb.badge');
            idEl.insertAdjacentElement('afterend', bossEl);
          }
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
          btn.textContent = tx('acc.detailsBtn') + ' ' + (open ? '▾' : '▸');
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
      // Thu gọn CẢ thẻ Accounts (anh Zon 2026-11-14): mũi tên to ▾/▸; mở mà 3 phút không đụng tới thì tự thu, chỉ còn hàng tiêu đề.
      (function () {
        var card = document.getElementById('accounts-container');
        var btn = document.getElementById('acc-card-toggle');
        if (!card || !btn) return;
        var open = true;
        var timer = null;
        function arm() {
          if (timer) clearTimeout(timer);
          timer = open ? setTimeout(function () { setOpen(false); }, ACC_SLEEP_COLLAPSE_MS) : null;
        }
        function setOpen(v) {
          open = v;
          card.classList.toggle('acc-card-collapsed', !open);
          btn.textContent = open ? '▾' : '▸';
          btn.setAttribute('aria-expanded', open ? 'true' : 'false');
          btn.setAttribute('aria-label', tx(open ? 'acc.cardHide' : 'acc.cardShow'));
          btn.title = tx(open ? 'acc.cardHide' : 'acc.cardShow');
          arm();
        }
        btn.addEventListener('click', function (ev) { ev.stopPropagation(); setOpen(!open); });
        // Đang thu gọn mà bấm Import / Add Account / All accounts… thì mở thẻ ra để thấy kết quả.
        var bar = card.querySelector('.acc-toolbar');
        if (bar) bar.addEventListener('click', function (ev) { if (!open && ev.target !== btn) setOpen(true); });
        ['mousemove', 'click', 'keydown', 'focusin'].forEach(function (ev) { card.addEventListener(ev, function () { if (open) arm(); }); });
        setOpen(true);
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

      var TOOL_LABELS = { 'claude-code': 'Claude', 'codex-cli': 'Codex', 'antigravity-cli': 'Antigravity' };
      function toolLabel(t) { return TOOL_LABELS[t] || String(t || ''); }
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

          // Một member dùng nhiều công cụ (anh Zon 2026-11-14): tài khoản khác công cụ chính của Worker có nhãn công cụ.
          var accTool = a.tool || worker.tool;
          if (accTool !== worker.tool) {
            var toolTag = document.createElement('span');
            toolTag.className = 'acc-tool-tag';
            toolTag.textContent = toolLabel(accTool);
            toolTag.title = tx('acc.toolTip', { tool: toolLabel(accTool) });
            line.appendChild(toolTag);
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

          if (accTool !== 'antigravity-cli') {
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
          var cmd = getLoginCommand(accTool, sshTarget, a.user);
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
      var accAddTool = document.getElementById('acc-add-tool');
      var accAddAgy = document.getElementById('acc-add-agy');
      var accAddJson = document.getElementById('acc-add-json');
      var accLogin = document.getElementById('acc-login');
      var accLoginTimer = null;

      function workerTool(agent) {
        var w = lastAccounts.find(function (x) { return x.agent === agent; });
        return w ? w.tool : '';
      }
      // Ô Công cụ mặc định theo Worker; đổi sang công cụ khác thì tài khoản mới dùng công cụ đó (Finn thêm tài khoản Antigravity).
      function syncAddForm(resetTool) {
        if (resetTool !== false && accAddTool) accAddTool.value = workerTool(accAddWorker.value) || 'claude-code';
        var t = accAddTool ? accAddTool.value : workerTool(accAddWorker.value);
        accAddAgy.hidden = t !== 'antigravity-cli';
      }
      document.getElementById('acc-add-btn').addEventListener('click', function () {
        clearChildren(accAddWorker);
        lastAccounts.forEach(function (w) {
          if (w.provider === 'zai') return; // Boss dùng API key, không thêm tài khoản
          var o = document.createElement('option');
          o.value = w.agent;
          o.textContent = w.agent + ' · ' + w.tool;
          accAddWorker.appendChild(o);
        });
        accAddPanel.hidden = false;
        accLogin.hidden = true;
        syncAddForm();
      });
      accAddWorker.addEventListener('change', function () { syncAddForm(true); });
      if (accAddTool) accAddTool.addEventListener('change', function () { syncAddForm(false); });
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
        if (accAddTool && accAddTool.value && accAddTool.value !== workerTool(accAddWorker.value)) body.tool = accAddTool.value;
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
      var accImportTarget = document.getElementById('acc-import-target');
      // Danh sách "Nhập vào Worker" (anh Zon 2026-11-14): danh sách Antigravity [{email, refresh_token}] không ghi agent thì vào Worker này.
      function fillImportTargets() {
        if (!accImportTarget) return;
        var keep = accImportTarget.value;
        clearChildren(accImportTarget);
        var workers = lastAccounts.filter(function (w) { return w.provider !== 'zai'; });
        var agyWorkers = workers.filter(function (w) { return w.tool === 'antigravity-cli'; });
        var auto = document.createElement('option');
        auto.value = '';
        auto.textContent = agyWorkers.length === 1 ? tx('acc.importTargetAuto', { name: agentLabel(agyWorkers[0].agent) }) : tx('acc.importTargetAutoNone');
        accImportTarget.appendChild(auto);
        workers.forEach(function (w) {
          var o = document.createElement('option');
          o.value = w.agent;
          o.textContent = agentLabel(w.agent) + ' · ' + w.agent;
          accImportTarget.appendChild(o);
        });
        accImportTarget.value = keep && workers.some(function (w) { return w.agent === keep; }) ? keep : '';
      }
      document.getElementById('acc-import-btn').addEventListener('click', function () { accImportFile.value = ''; accImportFile.click(); });
      async function previewImport() {
        try {
          // Chấp nhận dấu phẩy thừa trước ] hoặc } (file Antigravity sửa tay hay có).
          try { accImportData = JSON.parse(rawText); } catch (e1) { accImportData = JSON.parse(rawText.replace(/,\s*([\]}])/g, '$1')); }
        } catch (e) {
          showFeedback(topFeedback, tx('acc.badJson'), true);
          return;
        }
        try {
          var dry = await postJson('/api/accounts/import', Object.assign({ file: accImportData, dryRun: true }, accImportTarget && accImportTarget.value ? { agent: accImportTarget.value } : {}));
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
      }
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
        fillImportTargets();
        await previewImport();
      });
      if (accImportTarget) accImportTarget.addEventListener('change', function () { if (accImportData) previewImport(); });
      document.getElementById('acc-import-cancel').addEventListener('click', function () { accImportPanel.hidden = true; accImportData = null; });
      document.getElementById('acc-import-confirm').addEventListener('click', async function () {
        if (!accImportData) return;
        var overwrite = Array.from(accImportPanel.querySelectorAll('.acc-overwrite')).filter(function (c) { return c.checked; }).map(function (c) { return c.value; });
        try {
          var res = await postJson('/api/accounts/import', Object.assign({ file: accImportData, overwrite: overwrite }, accImportTarget && accImportTarget.value ? { agent: accImportTarget.value } : {}));
          var msg = tx('acc.imported', { n: res.imported.length });
          res.failed.forEach(function (x) { msg += ' · ' + x.entry + ': ' + x.reason; });
          showFeedback(topFeedback, msg, res.failed.length > 0);
          accImportPanel.hidden = true;
          accImportData = null;
        } catch (err) {
          showFeedback(topFeedback, err.message, true);
        }
      });

      // renderSnapshot ghi lại bản mới nhất để nút thu gọn / form Add vẽ lại không cần snapshot.
      function rememberAccounts(state) {
        lastAccounts = Array.isArray(state.accounts) ? state.accounts : [];
        lastSshHint = state.sshHint;
      }

      return { renderAccounts: renderAccounts, rememberAccounts: rememberAccounts };
    }
