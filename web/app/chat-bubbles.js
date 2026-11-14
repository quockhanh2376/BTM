/* BTM dashboard – bong bóng thoại trên avatar (DOM, hẹn giờ, công tắc Chat). Tách từ app.js 2026-11-14, không đổi hành vi.
   Hàm thuần của chat ở chat-lib.js; agentLabel/formatHHmm của app.js truyền vào qua d. */
    function btmChat(d) {
      var agentLabel = d.agentLabel, formatHHmm = d.formatHHmm;

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

      return { chatRun: chatRun, chatOwnerSays: chatOwnerSays, chatOnSnapshot: chatOnSnapshot };
    }
