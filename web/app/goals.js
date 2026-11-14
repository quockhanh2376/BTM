/* BTM dashboard – khu Goals (thẻ goal, tab ticket) + khung chat History. Tách từ app.js 2026-11-14, không đổi hành vi.
   app.js là một IIFE nên hàm dùng chung (clearChildren, postJson, agentLabel…) truyền vào qua d; thân hàm giữ nguyên thụt lề cũ. */
    function btmGoals(d) {
      var formatStatus = d.formatStatus, SEAT_LABELS = d.SEAT_LABELS, agentLabel = d.agentLabel, clearChildren = d.clearChildren,
        formatHHmm = d.formatHHmm, askAsSeat = d.askAsSeat, showFeedback = d.showFeedback, openDiff = d.openDiff, postJson = d.postJson,
        topFeedback = d.topFeedback, TASK_TAB_KEYS = d.TASK_TAB_KEYS, goalTabSelections = d.goalTabSelections,
        PIPELINE_STAGES = d.PIPELINE_STAGES, resolveActiveTab = d.resolveActiveTab, handleTabKeydown = d.handleTabKeydown,
        toggleTicketHistory = d.toggleTicketHistory, formatTime = d.formatTime;

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
          // Bài học sau goal (2026-11-14): việc của PM, không phải câu anh hỏi.
          if (q.to === 'ask-lessons') {
            var la = answers[q.id];
            if (la) out.push({ kind: 'reply', id: q.id, seat: la.seat, asked: la.asked, agent: la.agent, text: tx('lessons.title', { goal: raw }) + '\n' + la.answer, at: la.at });
            return;
          }
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
          if (text === 'Direct command' || text === 'Ask' || text === 'Lessons' || text === 'Meeting') return;
          if (/^\d+$/.test(text)) {
            var found = goalsAll.filter(function (x) { return String(x.n) === text; })[0];
            text = 'G' + text + (found && found.title ? ' · ' + found.title : '');
          }
          out.push({ kind: 'goal', text: text, status: s.status });
        });
        // Họp tranh luận (2026-11-14): cuộc đang mở / gần nhất nằm cuối khung.
        (typeof meetItems === 'function' ? meetItems(state && state.meeting) : []).forEach(function (x) { out.push(x); });
        return roomFilter(out, state);
      }
      // Dọn Meeting room (anh Zon 2026-11-14): ẩn tin trước mốc anh bấm dọn; cuộc họp đang chạy / tạm dừng và phiên đang chạy vẫn hiện.
      function roomFilter(items, state) {
        var cut = state && state.settings && state.settings.roomClearedAt;
        if (!cut) return items;
        var t = Date.parse(cut);
        var m = state.meeting;
        var meetLive = m && (m.status === 'running' || m.status === 'paused');
        var sessionLive = state.session && state.session.status === 'running';
        var hidden = 0;
        var kept = items.filter(function (it) {
          var keep;
          if (String(it.kind).indexOf('meet-') === 0) keep = meetLive || Date.parse(it.at || (m && m.createdAt) || 0) >= t || (m && Date.parse(m.createdAt) >= t);
          else if (it.kind === 'goal') keep = sessionLive;
          else keep = Date.parse(it.at || 0) >= t;
          if (!keep) hidden++;
          return keep;
        });
        if (hidden) kept.unshift({ kind: 'room-cleared', id: 'room-cleared', status: 'ok', at: cut, n: hidden });
        return kept;
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
          if (it.kind === 'room-cleared') {
            li.className = 'msg-divider room-cleared';
            li.textContent = tx('room.hidden', { n: it.n }) + ' ';
            var showBtn = document.createElement('button');
            showBtn.type = 'button';
            showBtn.className = 'room-show-btn';
            showBtn.textContent = tx('room.show');
            showBtn.addEventListener('click', function () { postJson('/api/meeting-room', { action: 'show' }).catch(function (e) { showFeedback(topFeedback, e.message, true); }); });
            li.appendChild(showBtn);
            el.appendChild(li);
            return;
          }
          if (String(it.kind).indexOf('meet-') === 0) {
            d.renderMeetItem(li, it, state);
            el.appendChild(li);
            return;
          }
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
          // Avatar nhỏ đầu tin (anh Zon 2026-11-14): anh Zon cho câu hỏi, agent trả lời cho câu đáp.
          if (typeof withAvatar === 'function') {
            var av = (state && state.settings && state.settings.avatars) || {};
            var avAgent = it.kind === 'ask' ? 'owner' : (it.agent || seatAgent[it.seat]);
            withAvatar(head, avAgent, it.kind === 'ask' ? 'Zon' : who(it.seat, it.agent), av);
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

      // 3725000 ms → "1h 02m"; dưới 1 giờ → "37m"; dưới 1 phút → "<1m".
      function formatDuration(ms) {
        var m = Math.round((ms || 0) / 60000);
        if (m < 1) return '<1m';
        var h = Math.floor(m / 60);
        var mm = m % 60;
        return h ? h + 'h ' + (mm < 10 ? '0' : '') + mm + 'm' : mm + 'm';
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
          // Bản đồ project (2026-11-14): module có sẵn + ticket đã sửa file nào.
          var mapLink = document.createElement('a');
          mapLink.className = 'goal-kb-link goal-map-link';
          mapLink.href = '/api/project/map';
          mapLink.target = '_blank';
          mapLink.rel = 'noopener';
          mapLink.textContent = tx('goal.map');
          mapLink.title = tx('goal.mapTip');
          header.appendChild(mapLink);

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

          // Nút X (vào thùng rác) luôn ở cuối hàng, bên phải link GitHub (anh Zon 2026-11-14).
          header.appendChild(archiveBtn);
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
            var agentParts = Object.keys(g.time.byAgent || {}).map(function (k) { return agentLabel(k) + ' ' + formatDuration(g.time.byAgent[k]); });
            if (agentParts.length) {
              var ta = document.createElement('div');
              ta.className = 'goal-time';
              ta.textContent = '👥 ' + tx('goal.byAgent', { list: agentParts.join(' · ') });
              card.appendChild(ta);
            }
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

      return { formatDuration: formatDuration, renderHistory: renderHistory, renderGoals: renderGoals };
    }
