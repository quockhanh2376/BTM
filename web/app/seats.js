/* BTM dashboard – thẻ ghế (thời gian lượt, đồng hồ bấm giờ, đầu khu Agents, thẻ Boss, nút Stop theo ghế, đổi agent ngồi ghế).
   Tách từ app.js 2026-11-14, không đổi hành vi. Hàm dùng chung của app.js truyền vào qua d; snapshot mới nhất đọc qua d.getSnapshot();
   thân hàm giữ nguyên thụt lề cũ. Avatar ghế vẫn ở app.js (chung agentAvatars / renameAgent). */
    function btmSeats(d) {
      var setDisplay = d.setDisplay, agentLabel = d.agentLabel, askOwner = d.askOwner, SEAT_LABELS = d.SEAT_LABELS, postJson = d.postJson,
        showFeedback = d.showFeedback, topFeedback = d.topFeedback, clearChildren = d.clearChildren,
        formatAgentDisplayName = d.formatAgentDisplayName, renderSeatAvatar = d.renderSeatAvatar, formatTime = d.formatTime,
        getLoginDisplay = d.getLoginDisplay, energyWarnChip = d.energyWarnChip, formatEnergy = d.formatEnergy, energyColor = d.energyColor,
        getSnapshot = d.getSnapshot;

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

      // Đầu khu Agents: tổng số ghế + số Live / Waiting (chip Idle đã thay bằng nút không khí team, 2026-11-14).
      function renderAgentCounts(seats) {
        var list = Array.isArray(seats) ? seats : [];
        var n = { running: 0, waiting: 0, idle: 0 };
        list.forEach(function (x) { n[x.status === 'running' ? 'running' : (x.status === 'waiting' ? 'waiting' : 'idle')]++; });
        var t = document.getElementById('agents-count');
        if (t) t.textContent = tx('agents.title', { n: list.length });
        [['agents-live', n.running], ['agents-waiting', n.waiting]].forEach(function (p) {
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

          if (spinnerEl) setDisplay(spinnerEl, cardData.status === 'running', 'inline-block');
          // Vòng quanh avatar (anh Zon 2026-11-14) thay chip Idle/Live/Waiting: đang làm → sáng + xoay; chờ anh → vòng vàng đứng yên.
          var avatarEl = cardEl.querySelector('.seat-avatar');
          if (avatarEl) {
            avatarEl.classList.toggle('is-active', cardData.status === 'running');
            avatarEl.classList.toggle('is-waiting', cardData.status === 'waiting');
            var stateText = tx(cardData.status === 'running' ? 'seat.live' : cardData.status === 'waiting' ? 'seat.waiting' : 'seat.idle');
            avatarEl.setAttribute('aria-label', tx('seat.avatarFor', { agent: agentLabel(cardData.agent) }) + ' · ' + stateText);
            avatarEl.title = avatarEl.getAttribute('aria-label');
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
              var latestSnapshot = getSnapshot();
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

      return { renderAgentCounts: renderAgentCounts, renderBossCard: renderBossCard, renderSeat: renderSeat };
    }
