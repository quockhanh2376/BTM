/* BTM dashboard – hàm thuần của bong bóng thoại + chat Auto (không đụng DOM, test nạp thẳng file này).
   Tách từ app.js 2026-11-14 (docs/engineering-rules.md). Tiếng Việt chỉ nằm trong CHAT_LINES. */
var CHAT_SHOW_MS = 7000; // anh Zon: hiện lâu hơn 5 s để kịp đọc
var CHAT_LINES = {
  en: {
    assign: ['{to}, {ticket} is all yours!', '{to}, here comes {ticket}. Have fun!', 'New ticket for you, {to}: {ticket}.', '{to}, can you take {ticket}?', '{ticket} is ready to build, {to}!'],
    assignAck: ['On it, {from}!', 'Got it {from}, starting now!', 'Thanks {from}, coding away!', 'Sure thing, {from}!', 'Leave it to me, {from}!'],
    to_qc: ['Dev done! {to}, can you test {ticket} for me?', '{to}, {ticket} is ready for testing.', 'Finished {ticket}. Your turn, {to}!', '{to}, please check {ticket} when you can.', 'All coded! {to}, {ticket} is yours to test.'],
    toQcAck: ['Sure {from}, testing now!', 'On it, {from}!', 'Got it {from}, let me take a look.', 'Testing {ticket} right away!', 'Thanks {from}!'],
    passed: ['{ticket} passed. Nice work, {to}!', 'All green on {ticket}, {to}!', '{to}, {ticket} looks great. Passed!', 'Clean job on {ticket}, {to}!', '{ticket} passed QC. Well done, {to}!'],
    passedAck: ['Thanks {from}!', 'Yay! Thanks {from}!', 'Great, thanks for testing, {from}!', 'Teamwork!', 'Thanks {from}, on to the next one!'],
    returned: ['{to}, found an issue in {ticket}. Back to you.', '{ticket} needs a fix, {to}.', '{to}, {ticket} did not pass yet. Notes are in the report.', 'Small bug in {ticket}, {to}. Can you fix it?', 'Sending {ticket} back, {to}. Details in the report.'],
    returnedAck: ['Got it {from}, fixing now!', 'On it, {from}!', 'Thanks for catching that, {from}!', 'Fixing {ticket} right away!', 'My bad, fixing it, {from}!'],
    question: ['Anh Zon, quick question on {ticket}: {text}', 'Anh Zon, I need your call on {ticket}: {text}', 'Anh Zon, can you help? {text}', 'Question for you, anh Zon: {text}', 'Anh Zon, {ticket}: {text}'],
    answered: ['Answered, {to}. Carry on!', 'Done, {to}. Check my answer.', '{to}, I replied. Go ahead!', 'There you go, {to}.', 'Answered. Keep going, {to}!'],
    answeredAck: ['Thanks anh!', 'Thanks anh Zon, continuing!', 'Got it, thanks anh!', 'Perfect, thanks anh!', 'Thank you anh, back to work!'],
    error: ['Oops, my turn hit a snag.', 'Hmm, that turn did not go well.', 'Ugh, something broke. Retrying later.', 'My turn stopped early.', 'Not my best turn...'],
    ownerAck: ['Got it, anh Zon!', 'On it, anh!', 'Sure thing, anh Zon!', 'Ok anh, looking now!', 'Roger that, anh Zon!'],
    checkAskTeam: ['Team, how is it going?', 'Hey team, any progress?', 'How are we doing, team?', 'Status check, team?', 'Team, where are we?'],
    checkAskOne: ['{to}, how is {ticket} going?', '{to}, where are you on {ticket}?', 'Any progress on {ticket}, {to}?', '{to}, how is it going?', 'Quick check, {to}: {ticket}?'],
    checkGiver: ['I handed {ticket} to {to} at {time}.', '{to} has had {ticket} since {time}.', 'Gave {ticket} to {to} at {time}, anh.', '{to} took {ticket} at {time}.', 'Passed {ticket} to {to} at {time}.'],
    checkFinn: ['Let me check on {to}.', 'One sec, checking {to}.', 'I will look at what {to} is doing.', 'Checking {to} now.', 'Let me peek at {to}.'],
    checkReport: ['{to} has been on {ticket} for {mins} min: {status}', '{to}, {mins} min in on {ticket}: {status}', '{ticket}: {to} is {mins} min in. {status}', '{to} is busy, {mins} min so far: {status}', 'Update: {to}, {mins} min on {ticket}. {status}'],
    idleSelf: ['I am free, waiting for work.', 'Nothing on my plate right now.', 'Free here, ready when needed.', 'Idle for now!', 'Waiting for the next ticket.'],
    chit: ['Coffee break, anyone?', 'Anyone else love green tests?', 'Quiet day, huh?', 'Who wants to pair later?', 'Stretch break!', 'Fun fact: tests are my love language.'],
    chitAck: ['Count me in!', 'Haha, same!', 'Always!', 'Sounds good!', 'Sure, why not?', 'Ha, true!'],
    projectChit: ['{goal} is really taking shape!', '{runner} is focused on {ticket}, looks close.', 'Once {goal} is done, demo time for anh Zon!', '{ticket} has more details than it looks.', 'My bet: {ticket} passes this round!', 'This project is fun, cannot wait for release!'],
    projectChitAck: ['Totally!', 'Hope so, go {runner}!', 'Yes, almost there!', 'Same thought here!', 'Cannot wait!', 'Our team rocks!'],
    projectChit3: ['One more ticket and the goal is done!', 'I will review {ticket} carefully later.', 'Bubble tea after release, everyone?', 'Let us keep the tests green!', 'Nice teamwork today!', 'Quiet focus mode, love it.'],
    thoughtLead: ['Working on it: ', 'Update: ', 'Right now: ', 'Hmm, ', 'Almost there: '],
    intentPlan: ['next job', 'next step', 'what next', 'plan', 'roadmap', 'next goal'],
    intentProject: ['new project', 'new app', 'another project', 'new repo', 'separate project'],
    intentAsk: ['what', 'how', 'why', 'when', 'where', 'which', 'who', 'status', 'progress'],
    intentGoal: ['add', 'make', 'build', 'create', 'fix', 'implement', 'change', 'write', 'update', 'remove'],
    askAck: ['Sure, let me check and get back to you.', 'On it, one moment please.', 'Got it, checking now.', 'Let me look into it, back shortly.', 'Sure thing, give me a moment.'],
    resumeWords: ['go ahead', 'continue', 'resume', 'keep going', 'go on', 'carry on'],
    chitOwner: ['Anh Zon, hope your day is going great!', 'Anh Zon, remember to grab some water!', 'Anh Zon, the team is in good shape today!', 'Anh Zon, thanks for the clear tickets!', 'Anh Zon, we got this!', 'Anh Zon, have you had coffee yet?']
  },
  vi: {
    assign: ['{to} ơi, {ticket} giao em nhé!', '{to}, {ticket} sẵn sàng rồi, em làm nhé.', 'Ticket mới cho {to}: {ticket}.', '{to} nhận {ticket} giúp anh nhé!', '{ticket} tới lượt em code đó, {to}!'],
    assignAck: ['Ok anh {from}, em làm ngay!', 'Dạ em nhận rồi anh {from}!', 'Em vào việc liền anh {from}!', 'Để em lo anh {from}!', 'Ok anh, em bắt đầu đây!'],
    to_qc: ['Mình dev xong rồi, {to} test {ticket} giúp mình nhé!', '{to} ơi, {ticket} xong rồi, test giúp mình nha.', 'Xong {ticket} rồi! Tới lượt {to} đó.', '{to} check {ticket} giúp mình với.', 'Code xong rồi, {to} test {ticket} nhé!'],
    toQcAck: ['Ok {from}, mình test liền!', 'Để mình xem nha {from}!', 'Nhận rồi {from}, test ngay!', 'Ok, mình check {ticket} đây!', 'Cảm ơn {from}, mình vào test!'],
    passed: ['{ticket} pass rồi, {to} làm tốt lắm!', '{to} ơi, {ticket} xanh hết rồi!', '{ticket} qua QC rồi nhé {to}!', 'Gọn gàng lắm {to}, {ticket} pass!', 'Chuẩn luôn {to}, {ticket} pass!'],
    passedAck: ['Cảm ơn {from} nha!', 'Yeah! Cảm ơn {from}!', 'Cảm ơn {from} đã test!', 'Teamwork!', 'Cảm ơn {from}, qua ticket tiếp!'],
    returned: ['{to} ơi, {ticket} còn lỗi, trả lại em nhé.', '{ticket} cần sửa chút {to} ơi.', '{to}, {ticket} chưa qua, chi tiết trong báo cáo nha.', 'Có bug nhỏ ở {ticket}, {to} sửa giúp nhé.', 'Mình trả {ticket} về {to}, xem báo cáo nha.'],
    returnedAck: ['Ok {from}, mình sửa liền!', 'Nhận rồi {from}, sửa ngay!', 'Cảm ơn {from} đã bắt lỗi!', 'Để mình sửa {ticket} liền!', 'Oops, mình sửa ngay {from}!'],
    question: ['Anh Zon ơi, em hỏi chút về {ticket}: {text}', 'Anh Zon ơi, {ticket} cần anh quyết: {text}', 'Anh Zon giúp em với: {text}', 'Anh Zon ơi, em có câu hỏi: {text}', 'Anh Zon, {ticket}: {text}'],
    answered: ['Anh trả lời rồi đó {to}, làm tiếp nhé!', 'Xong rồi {to}, em xem câu trả lời nha.', '{to} ơi, anh trả lời rồi.', 'Đây {to}, làm tiếp đi em.', 'Anh trả lời rồi, cố lên {to}!'],
    answeredAck: ['Dạ cảm ơn anh!', 'Cảm ơn anh Zon, em làm tiếp!', 'Dạ em rõ rồi, cảm ơn anh!', 'Ok anh, em làm tiếp ngay!', 'Cảm ơn anh, em vào việc!'],
    error: ['Ui, lượt này của em bị lỗi rồi.', 'Hmm, lượt vừa rồi không ổn lắm.', 'Có gì đó hỏng rồi, em thử lại sau.', 'Lượt của em dừng sớm mất rồi.', 'Lượt này em chưa ổn...'],
    ownerAck: ['Dạ em nhận rồi anh Zon!', 'Ok anh, em làm ngay!', 'Dạ anh Zon!', 'Ok anh, em xem liền!', 'Em rõ rồi anh!'],
    checkAskTeam: ['Cả nhà làm tới đâu rồi?', 'Team ơi, tiến độ sao rồi?', 'Mọi người ổn không, tới đâu rồi?', 'Team, cập nhật chút nào!', 'Tới đâu rồi cả nhà?'],
    checkAskOne: ['{to} ơi, {ticket} tới đâu rồi em?', '{to}, {ticket} sao rồi?', '{ticket} có tiến triển chưa {to}?', '{to} ơi, làm tới đâu rồi?', 'Hỏi nhanh {to}: {ticket} sao rồi?'],
    checkGiver: ['Em giao {ticket} cho {to} lúc {time} rồi anh.', '{to} nhận {ticket} từ lúc {time} anh ạ.', 'Em chuyển {ticket} cho {to} lúc {time}.', '{to} làm {ticket} từ {time} rồi anh.', 'Lúc {time} em giao {ticket} cho {to} rồi.'],
    checkFinn: ['Để em check {to} làm tới đâu nhé.', 'Chờ em xíu, em xem {to}.', 'Để em xem {to} đang làm gì.', 'Em check {to} liền.', 'Để em ngó qua {to} nha.'],
    checkReport: ['{to} làm {ticket} được {mins} phút: {status}', '{to} đang ở phút {mins} của {ticket}: {status}', '{ticket}: {to} làm được {mins} phút. {status}', '{to} đang bận, {mins} phút rồi: {status}', 'Cập nhật: {to}, {mins} phút ở {ticket}. {status}'],
    idleSelf: ['Em đang rảnh, chờ việc ạ.', 'Em chưa có việc anh ạ.', 'Em rảnh, cần gì gọi em nha.', 'Đang rảnh nè!', 'Em chờ ticket tiếp theo ạ.'],
    chit: ['Có ai đi cà phê không?', 'Thấy test xanh là vui ghê!', 'Hôm nay yên ắng ghê ta.', 'Lát ai pair code với mình không?', 'Giải lao vươn vai chút nào!', 'Chuyện vui: test pass là chân ái.'],
    chitAck: ['Cho mình theo với!', 'Haha, đúng vậy!', 'Luôn luôn!', 'Nghe được đó!', 'Ok luôn!', 'Chuẩn!'],
    projectChit: ['{goal} lên hình rõ rồi đó cả nhà!', '{runner} làm {ticket} chăm ghê, chắc sắp xong rồi.', 'Xong {goal} là demo cho anh Zon liền nha!', '{ticket} nhìn vậy mà nhiều chi tiết lắm.', 'Mình đoán {ticket} pass ngay vòng này!', 'Project này vui ghê, mong tới lúc release!'],
    projectChitAck: ['Chuẩn luôn!', 'Hy vọng vậy, {runner} cố lên!', 'Đúng rồi, gần về đích rồi!', 'Mình cũng nghĩ vậy!', 'Hóng ghê!', 'Team mình đỉnh mà!'],
    projectChit3: ['Thêm một ticket nữa là xong goal rồi!', 'Lát mình soi kỹ {ticket} giúp nha!', 'Release xong làm ly trà sữa nha cả nhà!', 'Giữ test xanh nha mọi người!', 'Hôm nay team phối hợp mượt ghê!', 'Chế độ tập trung, thích ghê.'],
    thoughtLead: ['Mình đang… ', 'Update nè: ', 'Đang làm: ', 'Hmm, ', 'Sắp xong: '],
    intentPlan: ['kế tiếp', 'tiếp theo', 'lên plan', 'lên kế hoạch', 'làm gì tiếp', 'job nào'],
    intentProject: ['project mới', 'dự án mới', 'app mới', 'repo mới', 'ứng dụng mới'],
    intentAsk: ['gì', 'sao', 'nào', 'bao giờ', 'khi nào', 'ở đâu', 'tới đâu', 'đến đâu', 'bao nhiêu', 'có phải'],
    intentGoal: ['làm', 'thêm', 'tạo', 'sửa', 'đổi', 'viết', 'xây', 'bỏ', 'cập nhật', 'nâng cấp'],
    askAck: ['Dạ anh, chờ em xem lại rồi báo anh nhé.', 'Dạ, chờ em xíu ạ.', 'Dạ anh, em kiểm tra rồi trả lời anh liền.', 'Dạ em nhận rồi, anh đợi em chút nha.', 'Dạ, để em xem lại và báo anh ngay.'],
    resumeWords: ['tiếp e', 'tiếp em', 'tiếp tục', 'làm tiếp', 'chạy tiếp', 'tiếp đi'],
    chitOwner: ['Anh Zon ơi, chúc anh một ngày thật vui!', 'Anh Zon nhớ uống nước nha!', 'Anh Zon ơi, team hôm nay sung lắm!', 'Cảm ơn anh Zon giao việc rõ ràng nha!', 'Anh Zon yên tâm, tụi em lo được!', 'Anh Zon uống cà phê chưa ạ?']
  }
};
var chatLastIdx = {};
function pickChatLine(kind, vars, lang) {
  var table = CHAT_LINES[lang] || CHAT_LINES.en;
  var pool = table[kind] || CHAT_LINES.en[kind] || [''];
  var key = (lang || 'en') + ':' + kind;
  var i = Math.floor(Math.random() * pool.length);
  if (pool.length > 1 && i === chatLastIdx[key]) i = (i + 1) % pool.length;
  chatLastIdx[key] = i;
  return pool[i].replace(/\{(\w+)\}/g, function (m, k) {
    return vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m;
  });
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
// end chat-lib
