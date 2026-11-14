/* BTM dashboard – hàm thuần của bong bóng thoại + chat Auto (không đụng DOM, test nạp thẳng file này).
   Tách từ app.js 2026-11-14 (docs/engineering-rules.md). Tiếng Việt chỉ nằm trong CHAT_LINES. */
var CHAT_SHOW_MS = 7000; // anh Zon: hiện lâu hơn 5 s để kịp đọc
var chatLastIdx = {};
function pickChatLine(kind, vars, lang) {
  var table = CHAT_LINES[lang] || CHAT_LINES.en;
  var pool = table[kind] || CHAT_LINES.en[kind] || [''];
  var key = (lang || 'en') + ':' + kind;
  var i = Math.floor(Math.random() * pool.length);
  if (pool.length > 1 && i === chatLastIdx[key]) i = (i + 1) % pool.length;
  chatLastIdx[key] = i;
  var out = pool[i].replace(/\{(\w+)\}/g, function (m, k) {
    return vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m;
  });
  return out.charAt(0).toUpperCase() + out.slice(1); // "{to} ơi…" → "Anh Zon ơi…"
}
// Chat Auto (anh Zon 2026-11-14): đoán loại tin nhắn bằng luật, không gọi AI. Không rõ → hỏi lại anh.
// kind: plan | project | ask | goal | unknown; seat = ghế được nhắc tên (vai hoặc tên hiển thị) nếu có.
function classifyMessage(text, names) {
  var t = ' ' + String(text || '').toLowerCase().replace(/\s+/g, ' ').trim() + ' ';
  var has = function (list) {
    return list.some(function (w) { return new RegExp('(^|[^\\p{L}])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^\\p{L}])', 'u').test(t); });
  };
  var words = function (k) { return CHAT_LINES.en[k].concat(CHAT_LINES.vi[k]); };
  var seat = null;
  Object.keys(names || {}).forEach(function (sk) {
    if (!seat && (names[sk] || []).some(function (n) { return n && has([String(n).toLowerCase()]); })) seat = sk;
  });
  if (has(words('intentProject'))) return { kind: 'project', seat: seat };
  // Anh Zon 2026-11-14: câu dạng "có nên…", "A hay B", "tranh luận…" → mời mở Meeting (nhiều agent phản biện).
  if (has(words('intentDebate'))) return { kind: 'debate', seat: seat };
  // "Chủ đề: …" / "Topic: …" ở đầu câu luôn là tranh luận; câu hỏi dạng "A hay B?" / "A or B?" cũng vậy (anh Zon 2026-11-14).
  var lead = t.replace(/^[\s"“'«]+/, '');
  if (words('intentTopic').some(function (w) { return lead.indexOf(w + ':') === 0 || lead.indexOf(w + ' :') === 0; })) return { kind: 'debate', seat: seat };
  if (t.indexOf('?') >= 0 && /\s(hay|or)\s/.test(t)) return { kind: 'debate', seat: seat };
  if (has(words('intentPlan'))) return { kind: 'plan', seat: seat };
  var ask = t.indexOf('?') >= 0 || has(words('intentAsk'));
  var stripped = t.replace(/^\s*[^,:]{1,20}[,:]\s*/, ' ');
  var goal = words('intentGoal').some(function (w) { return stripped.trim().indexOf(w + ' ') === 0; });
  if (ask && !goal) return { kind: 'ask', seat: seat };
  if (goal && !ask) return { kind: 'goal', seat: seat };
  return { kind: 'unknown', seat: seat };
}

// Anh Zon gõ đúng "go ahead" / "tiếp e"… (cả câu, không thêm gì) trong Command = bấm Resume.
// Câu "dạ" khi nhận câu hỏi (anh Zon 2026-11-14): cố định theo id (không nhảy khi vẽ lại); câu hỏi tiếng Việt → dạ tiếng Việt.
function ackLine(id, text) {
  var lang = Array.prototype.some.call(String(text || ''), function (ch) { var c = ch.charCodeAt(0); return c >= 0xC0 && c <= 0x1EF9; }) ? 'vi' : 'en';
  var pool = CHAT_LINES[lang].askAck;
  return pool[Math.abs(Number(id) || 0) % pool.length];
}

function isResumeWord(text) {
  var t = String(text || '').toLowerCase().replace(/[\s.!,]+$/g, '').replace(/\s+/g, ' ').trim();
  return CHAT_LINES.en.resumeWords.concat(CHAT_LINES.vi.resumeWords).indexOf(t) >= 0;
}
// 💭 Dòng Last log của agent đang chạy → câu "nghĩ thành tiếng". Bỏ dòng trống, dòng [btm], dòng toàn đường dẫn/mã.
function chatThoughtLine(line) {
  var t = String(line || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[`*_#>]+/g, '').replace(/\s+/g, ' ').trim();
  if (t.length < 4 || /^\[btm\]/i.test(t) || /^[\w\/\\.:=-]+$/.test(t) || !/[A-Za-z\u00C0-\u1EF9]{3}/.test(t)) return '';
  return t.length > 80 ? t.slice(0, 79) + '\u2026' : t;
}
function chatStyleOf(agentId) {
  var h = 0;
  var s = String(agentId || '');
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100003;
  return h % 6;
}
function chatTicketStates(snap) {
  var m = {};
  ((snap && snap.goals) || []).forEach(function (g) {
    (g.tickets || []).forEach(function (t) { m[t.id] = t.state; });
  });
  return m;
}
// Sự kiện mới giữa hai snapshot. prev null (trang vừa mở) → không phát chuyện cũ.
function chatEvents(prev, next) {
  if (!prev || !next) return [];
  var ev = [];
  // Bước 3: câu trả lời mới của team → bong bóng của người trả lời.
  var seenAns = {};
  (prev.answers || []).forEach(function (a) { seenAns[a.id] = true; });
  (next.answers || []).forEach(function (a) { if (!seenAns[a.id]) ev.push({ type: 'answer', seat: a.seat, text: a.answer }); });
  var pt = chatTicketStates(prev);
  var nt = chatTicketStates(next);
  Object.keys(nt).forEach(function (id) {
    var a = pt[id];
    var b = nt[id];
    if (!a || a === b) return;
    if (a === 'pending' && b === 'in_dev') ev.push({ type: 'assign', from: 'pm', to: 'dev', ticket: id });
    else if (b === 'awaiting_qc') ev.push({ type: 'to_qc', from: 'dev', to: 'qc', ticket: id });
    else if (b === 'passed') ev.push({ type: 'passed', from: 'qc', to: 'dev', ticket: id });
    else if (b === 'returned') ev.push({ type: 'returned', from: 'qc', to: 'dev', ticket: id });
  });
  var ps = {};
  (prev.seats || []).forEach(function (s) { ps[s.seat] = s.status; });
  (next.seats || []).forEach(function (s) {
    if (s.status === 'running' && ps[s.seat] !== 'running') ev.push({ type: 'start', seat: s.seat, ticket: s.ticket || '' });
  });
  var pq = {};
  (prev.questions || []).forEach(function (q) { pq[q.id] = q; });
  var nq = {};
  (next.questions || []).forEach(function (q) {
    nq[q.id] = true;
    if (!pq[q.id]) ev.push({ type: 'question', seat: q.seat, ticket: q.ticket, text: q.text });
  });
  Object.keys(pq).forEach(function (id) {
    if (!nq[id]) ev.push({ type: 'answered', seat: pq[id].seat, ticket: pq[id].ticket });
  });
  // Biểu quyết (anh Zon 2026-11-14): anh vừa chốt (hoặc đổi ý) → cả team "dạ".
  var pd = prev.meeting && prev.meeting.decision;
  var nd = next.meeting && next.meeting.decision;
  if (nd && (!pd || pd.at !== nd.at)) ev.push({ type: 'decided', option: nd.option, overrode: !!nd.overrode });
  var seen = {};
  (prev.log || []).forEach(function (l) { seen[l.at + '|' + l.who + '|' + l.text] = true; });
  (next.log || []).forEach(function (l) {
    if (seen[l.at + '|' + l.who + '|' + l.text] || !/^(error|timeout)/i.test(String(l.text || ''))) return;
    var seat = null;
    (next.seats || []).forEach(function (s) { if (s.agent === l.who || s.seat === l.who) seat = s.seat; });
    if (seat) ev.push({ type: 'error', seat: seat });
  });
  return ev;
}
// Ai đáp khi anh gửi Command: ghế đang chạy thì tập trung làm, không đáp.
function chatTargetsFor(to, snap) {
  var seats = ((snap && snap.seats) || []).filter(function (s) { return s.agent && s.status !== 'running'; });
  if (to === 'team') return seats.map(function (s) { return s.seat; });
  return seats.some(function (s) { return s.seat === to; }) ? [to] : [];
}
// Giờ VN (UTC+7) và nhóm câu theo khung giờ cho chuyện phiếm (anh Zon 2026-11-14).
function vnHour(now) {
  return parseInt(new Date(now || Date.now()).toLocaleString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', hourCycle: 'h23' }), 10);
}
function timeKind(hour) {
  if (hour >= 5 && hour <= 10) return 'timeMorning';
  if (hour >= 11 && hour <= 13) return 'timeLunch';
  if (hour >= 14 && hour <= 16) return 'timeAfternoon';
  if (hour >= 17 && hour <= 19) return 'timeDinner';
  if (hour >= 20 && hour <= 23) return 'timeEvening';
  return 'timeLate';
}
// Không khí team (anh Zon 2026-11-14): "lively" nói nhiều, đùa; "normal" ít hơn, chuyên nghiệp, không tán gẫu khi có người đang làm.
// Đơn vị: phút cho chit/check, ms cho thought.
// opt = cài đặt của anh trong Settings (snapshot.settings.chat): { speakers, livelySec: [min, max], normalMin: [min, max] }.
function chatMoodCfg(mood, opt) {
  var cfg = mood === 'lively'
    ? { chit: [0.5, 1], check: [3, 5], thoughtMs: [30000, 15000], chitWhileWork: true, third: 0.9 }
    : { chit: [5, 8], check: [8, 10], thoughtMs: [120000, 60000], chitWhileWork: false, third: 0.3 };
  cfg.speakers = 3;
  if (opt) {
    if (mood === 'lively' && opt.livelySec && opt.livelySec.length === 2) cfg.chit = [opt.livelySec[0] / 60, opt.livelySec[1] / 60];
    if (mood !== 'lively' && opt.normalMin && opt.normalMin.length === 2) cfg.chit = [opt.normalMin[0], opt.normalMin[1]];
    if (opt.speakers >= 1 && opt.speakers <= 5) cfg.speakers = opt.speakers;
  }
  return cfg;
}
// Giữ lại các bước của tối đa `max` agent đầu tiên (anh Zon – 'owner' – không tính).
function capSpeakers(steps, max) {
  var seen = [];
  return (steps || []).filter(function (st) {
    if (!st.target || st.target === 'owner') return true;
    if (seen.indexOf(st.target) < 0) { if (seen.length >= max) return false; seen.push(st.target); }
    return true;
  });
}
// Vui vẻ: 1–3 người (ngẫu nhiên, trong số người rảnh) cùng nói; người đầu gọi tên người thứ hai (hoặc anh Zon).
function livelyTalkPlan(idle, rnd, max) {
  rnd = rnd || Math.random;
  max = max >= 1 && max <= 5 ? max : 3;
  var order = (idle || []).slice().sort(function () { return rnd() - 0.5; });
  var n = Math.min(order.length, 1 + Math.floor(rnd() * max));
  return order.slice(0, n);
}
// Đang bàn kế hoạch / phản biện ([plan] gửi làn hỏi đáp, chưa xong) → tự bật lively.
function chatDiscussing(snap) {
  if (snap && snap.meeting && snap.meeting.status === 'running') return true;
  return ((snap && snap.queue) || []).some(function (q) {
    return String(q.to).indexOf('ask-') === 0 && q.to !== 'ask-lessons' && /^\[plan\]/i.test(String(q.text || '')) &&
      (q.status === 'queued' || q.status === 'running');
  });
}
// end chat-lib
