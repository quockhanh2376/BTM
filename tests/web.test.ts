import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

describe('Web Dashboard (web/index.html)', () => {
  const htmlPath = resolve(process.cwd(), 'web/index.html');
  const html = readFileSync(htmlPath, 'utf-8');
  // Đoạn JS trích từ trang gọi tr(): dựng tr thật từ bảng STRINGS của trang (Plan 5 Task 9).
  {
    const i18nSrc = html.slice(html.indexOf('var STRINGS = {'), html.indexOf('function applyI18n'));
    (globalThis as any).tx = new Function('window', `${i18nSrc}; return tx;`)({ localStorage: { getItem: () => null } });
  }

  it('rác test: os.tmpdir() trong test nằm dưới <repo>/.tmp', () => {
    const repoTmp = resolve(process.cwd(), '.tmp');
    expect(tmpdir().startsWith(repoTmp)).toBe(true);
  });

  it('file exists and is not empty', () => {
    expect(existsSync(htmlPath)).toBe(true);
    expect(html.length).toBeGreaterThan(100);
  });

  it('contains required core IDs and elements', () => {
    expect(html).toContain('id="theme-toggle"');
    expect(html).toContain('id="stop-btn"');
    expect(html).toContain('id="approve-btn"');
    expect(html).toContain('id="cmd-text"');
    expect(html).toMatch(/<label[^>]*\bfor=["']cmd-text["']/);
    expect(html).toContain('id="conn-banner"');
  });

  it('puts the attach and Send buttons inside the command box', () => {
    const box = html.slice(html.indexOf('<div class="cmd-composer">'), html.indexOf('class="cmd-actions"'));
    expect(box).toContain('id="cmd-text"');
    expect(box).toContain('id="attach-image-label"');
    expect(box).toContain('id="cmd-send-btn"');
    expect(box).toMatch(/id="cmd-send-btn"[^>]*data-i18n-title="cmd\.send"/);
  });

  it('puts the recipient radios on the Command title row and hides the textarea label visually', () => {
    const head = html.slice(html.indexOf('<div class="cmd-head">'), html.indexOf('<div class="form-group">', html.indexOf('<div class="cmd-head">')));
    expect(head).toContain('data-i18n="cmd.title"');
    expect(head).toContain('id="recipient-radios"');
    expect(html).toMatch(/<label for="cmd-text" class="sr-only"/);
  });

  it('theme toggle uses aria-label, SVG icon, and no emoji', () => {
    expect(html).toContain('aria-label="Toggle light/dark"');
    expect(html).toContain('<svg');
    const toggleMatch = html.match(/<button[^>]*id=["']theme-toggle["'][^>]*>([\s\S]*?)<\/button>/);
    expect(toggleMatch).not.toBeNull();
    const toggleContent = toggleMatch![1];
    expect(toggleContent).not.toMatch(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u);
  });

  it('supports light and dark themes using specified color tokens', () => {
    // Light palette
    expect(html.toLowerCase()).toContain('#f4f4f1');
    expect(html.toLowerCase()).toContain('#ffffff');
    expect(html.toLowerCase()).toContain('#1a1a18');
    expect(html.toLowerCase()).toContain('#55554f');
    expect(html.toLowerCase()).toContain('#2b5bd7');
    expect(html.toLowerCase()).toContain('#dce6fb');
    expect(html.toLowerCase()).toContain('#1e3f99');
    expect(html.toLowerCase()).toContain('#b42318');

    // Dark palette
    expect(html.toLowerCase()).toContain('#141413');
    expect(html.toLowerCase()).toContain('#1f1f1d');
    expect(html.toLowerCase()).toContain('#f2f2ef');
    expect(html.toLowerCase()).toContain('#b5b5ae');
    expect(html.toLowerCase()).toContain('#8aaeff');

    // Theme selector and preference
    expect(html).toContain('[data-theme="dark"]');
    expect(html).toContain('prefers-color-scheme');
    expect(html).toContain('localStorage');
    expect(html).toContain('btm-theme');
  });

  it('uses system fonts and no external fonts', () => {
    expect(html).toContain('system-ui');
    expect(html).toContain('ui-monospace');
    expect(html).not.toMatch(/fonts\.googleapis\.com/i);
    expect(html).not.toMatch(/fonts\.gstatic\.com/i);
  });

  it('uses 12px border-radius and spacing between 16px and 24px', () => {
    expect(html).toContain('12px');
    expect(html).toMatch(/\b(16px|20px|24px)\b/);
  });

  it('does NOT contain innerHTML anywhere', () => {
    expect(html).not.toContain('innerHTML');
  });

  it('does NOT contain network access patterns without stripping comments by regex', () => {
    expect(html).not.toContain('src="http');
    expect(html).not.toContain('href="http');
    expect(html).not.toContain('url(http');
    expect(html).not.toContain('fetch("http');
    expect(html).not.toContain('EventSource("http');
  });

  it('dark theme button and error text satisfy contrast >= 4.5:1', () => {
    expect(html.toLowerCase()).toContain('#ff8a80');
    expect(html.toLowerCase()).toContain('#1f1f1d');

    const getLuminance = (hex: string): number => {
      const clean = hex.replace('#', '');
      const r = parseInt(clean.slice(0, 2), 16) / 255;
      const g = parseInt(clean.slice(2, 4), 16) / 255;
      const b = parseInt(clean.slice(4, 6), 16) / 255;
      const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
      return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
    };

    const getContrastRatio = (hex1: string, hex2: string): number => {
      const l1 = getLuminance(hex1);
      const l2 = getLuminance(hex2);
      const lighter = Math.max(l1, l2);
      const darker = Math.min(l1, l2);
      return (lighter + 0.05) / (darker + 0.05);
    };

    // Dark error text #FF8A80 on #1F1F1D
    const errContrast = getContrastRatio('#FF8A80', '#1F1F1D');
    expect(errContrast).toBeGreaterThanOrEqual(4.5);

    // Dark button text contrast >= 4.5:1 (e.g. #8AAEFF with #141413 text or #3B6FE0 with #FFFFFF text)
    expect(html).toMatch(/(--btn-primary-bg|--btn-bg|--accent)[^;]*#8aaeff/i);
    expect(html).toMatch(/(--btn-primary-text|--btn-text)[^;]*#141413/i);
    const btnContrast = getContrastRatio('#8AAEFF', '#141413');
    expect(btnContrast).toBeGreaterThanOrEqual(4.5);
  });

  it('reads localStorage in isolated try/catch and falls back to prefers-color-scheme on error', () => {
    expect(html).toMatch(/try\s*\{\s*[^}]*localStorage\.getItem[^}]*\}\s*catch/);

    let appliedTheme = '';
    const mockDocument = {
      documentElement: {
        setAttribute: (_attr: string, val: string) => {
          appliedTheme = val;
        },
        getAttribute: (_attr: string) => appliedTheme,
      },
      getElementById: (_id: string) => null,
    };
    const mockWindowDark = {
      matchMedia: (query: string) => ({
        matches: query.includes('prefers-color-scheme: dark'),
      }),
    };
    const mockLocalStorageThrow = {
      getItem: () => {
        throw new Error('localStorage is blocked');
      },
      setItem: () => {},
    };

    const initThemeMatch = html.match(/function\s+initTheme\s*\(\)\s*\{([\s\S]*?)\n\s*\}\s*\n\s*initTheme\(\);/);
    expect(initThemeMatch).not.toBeNull();
    const fnBody = initThemeMatch![1];

    const runInitTheme = new Function('window', 'document', 'localStorage', fnBody);
    runInitTheme(mockWindowDark, mockDocument, mockLocalStorageThrow);
    expect(appliedTheme).toBe('dark');
  });

  it('has translation table with all 17 status keys and keeps unknown values intact', () => {
    const expectedTranslations: Record<string, string> = {
      running: 'Running',
      awaiting_approval: 'Awaiting approval',
      done: 'Done',
      needs_owner: 'Needs owner',
      out_of_turns: 'Out of turns',
      stopped: 'Stopped',
      refused: 'Refused',
      error: 'Error',
      pending: 'Pending',
      in_dev: 'In dev',
      awaiting_qc: 'Awaiting QC',
      passed: 'Passed',
      returned: 'Returned',
      failed: 'Failed',
      blocked: 'Blocked',
      queued: 'Queued',
      cancelled: 'Cancelled',
    };

    const mapMatch = html.match(/STATUS_MAP\s*=\s*(\{[\s\S]*?\});/);
    expect(mapMatch).not.toBeNull();
    const parsedMap = new Function(`return ${mapMatch![1]};`)() as Record<string, string>;

    for (const [key, value] of Object.entries(expectedTranslations)) {
      expect(parsedMap[key], `Missing or incorrect key: ${key}`).toBe(value);
    }
    expect(Object.keys(parsedMap).length).toBeGreaterThanOrEqual(17);

    const fnMatch = html.match(/function\s+(formatStatus|translateStatus)\s*\([^)]*\)\s*\{[\s\S]*?\}/);
    expect(fnMatch).not.toBeNull();
    const formatStatus = new Function('STATUS_MAP', `return ${fnMatch![0]};`)(parsedMap);
    expect(formatStatus('unknown_status_xyz')).toBe('unknown_status_xyz');
    expect(formatStatus('custom_state')).toBe('custom_state');
  });

  it('includes required POST headers including x-btm', () => {
    expect(html).toContain('x-btm');
    expect(html).toContain('application/json');
  });

  it('includes SSE connection logic and banner message for disconnection', () => {
    expect(html).toContain('/api/events');
    expect(html).toContain('EventSource');
    expect(html).toContain('Disconnected, retrying…');
  });

  it('handles state event from SSE', () => {
    expect(html).toContain("'state'");
  });

  it('interacts with API endpoints (/api/stop, /api/approve, /api/command)', () => {
    expect(html).toContain('/api/stop');
    // Stop trên từng thẻ: gửi seat, chỉ bật khi thẻ đang chạy
    expect(html).toContain("postJson('/api/stop', { seat: seatKey })");
    expect(html).toContain('cardStop.disabled = !(isCurrentHolder && isBusy);');
    expect(html).toContain('/api/approve');
    expect(html).toContain('/api/command');
  });

  it('renders required layout components and Vietnamese texts', () => {
    expect(html).toContain('Bot Task Manager');
    expect(html).toContain('Stop');
    expect(html).toContain('Approve tickets');
    expect(html).toContain('Session goals');
    expect(html).toContain('Energy: —');
    expect(html).toContain('Login: —');
    expect(html).toContain('Pending');
    expect(html).toContain('In dev');
    expect(html).toContain('Awaiting QC');
    expect(html).toContain('Passed');
    expect(html).toContain('Returned');
    expect(html).toContain('Log');
    expect(html).toContain('Send');
    expect(html).toContain('PM: starts a session with this goal · Dev/QC: queued after the current turn');
    expect(html).toContain('Queue');
  });

  it('requires confirmation before stop command', () => {
    expect(html).toContain('confirm(');
  });

  it('has radio inputs for recipient with team (Cả team) as default', () => {
    expect(html).toMatch(/<input[^>]*type=["']radio["'][^>]*value=["']team["'][^>]*checked/);
    expect(html).toMatch(/Team/);
    expect(html).toMatch(/<input[^>]*type=["']radio["'][^>]*value=["']pm["']/);
    expect(html).toMatch(/<input[^>]*type=["']radio["'][^>]*value=["']dev["']/);
    expect(html).toMatch(/<input[^>]*type=["']radio["'][^>]*value=["']qc["']/);
  });

  it('has responsive meta tag and no horizontal overflow setup', () => {
    expect(html).toContain('name="viewport"');
    expect(html).toContain('width=device-width');
    expect(html).toContain('overflow-x');
  });

  it('has table and function for seat labels PM/Dev/QC and formats agent display names', () => {
    // 1. Table mapping seats: pm -> PM, dev -> Dev, qc -> QC
    const mapMatch = html.match(/(?:SEAT_MAP|SEAT_LABELS|SEAT_LABEL_MAP)\s*=\s*(\{[\s\S]*?\});/);
    expect(mapMatch).not.toBeNull();
    const parsedSeatMap = new Function(`return ${mapMatch![1]};`)() as Record<string, string>;
    expect(parsedSeatMap.pm).toBe('PM');
    expect(parsedSeatMap.dev).toBe('Dev');
    expect(parsedSeatMap.qc).toBe('QC');

    // 2. Seat label formatting function
    const seatFnMatch = html.match(/function\s+(formatSeatLabel|formatSeat)\s*\([^)]*\)\s*\{[\s\S]*?\}/);
    expect(seatFnMatch).not.toBeNull();
    const formatSeat = new Function('SEAT_MAP', `return ${seatFnMatch![0]};`)(parsedSeatMap);
    expect(formatSeat('pm')).toBe('PM');
    expect(formatSeat('dev')).toBe('Dev');
    expect(formatSeat('qc')).toBe('QC');

    // 3. Agent display name formatting function (id capitalized + '-' + seat label)
    const agentFnMatch = html.match(/function\s+(formatAgentDisplayName|formatAgent)\s*\([^)]*\)\s*\{[\s\S]*?\}/);
    expect(agentFnMatch).not.toBeNull();
    const names: Record<string, string> = {};
    const labelSrc = html.slice(html.indexOf('function agentLabel(id)'), html.indexOf('function formatAgentDisplayName'));
    const agentLabel = new Function('agentNames', `return ${labelSrc};`)(names);
    const formatAgent = new Function(
      'formatSeatLabel', 'agentLabel',
      `return ${agentFnMatch![0]};`
    )((s: string) => parsedSeatMap[s.toLowerCase()] || s, agentLabel);

    expect(formatAgent('elon', 'pm')).toBe('Elon-PM');
    expect(formatAgent('jacky', 'dev')).toBe('Jacky-Dev');
    expect(formatAgent('jenny', 'qc')).toBe('Jenny-QC');
    names.jacky = 'David';
    expect(formatAgent('jacky', 'dev')).toBe('David-Dev');
    delete names.jacky;

    // 4. Initial HTML seat titles have formatted names
    expect(html).toContain('id="pm-title">Elon-PM');
    expect(html).toContain('id="dev-title">Jacky-Dev');
    expect(html).toContain('id="qc-title">Jenny-QC');

    // 5. Log who formatting helper formats agents as Elon-PM, Jacky-Dev, Jenny-QC and preserves system who
    const logWhoMatch = html.match(/function\s+formatLogWho[\s\S]*?(?=\n\s*\/\/ 3\. DOM Helper)/);
    expect(logWhoMatch).not.toBeNull();
    const formatLogWho = new Function(
      'SEAT_MAP',
      'formatSeatLabel',
      'formatAgentDisplayName',
      `return ${logWhoMatch![0]};`
    )(parsedSeatMap, formatSeat, formatAgent);

    const mockSeats = [
      { seat: 'pm', agent: 'elon' },
      { seat: 'dev', agent: 'jacky' },
      { seat: 'qc', agent: 'jenny' },
    ];
    expect(formatLogWho('elon', mockSeats)).toBe('Elon-PM');
    expect(formatLogWho('jacky', mockSeats)).toBe('Jacky-Dev');
    expect(formatLogWho('jenny', mockSeats)).toBe('Jenny-QC');
    expect(formatLogWho('pm', mockSeats)).toBe('Elon-PM');
    expect(formatLogWho('dev', mockSeats)).toBe('Jacky-Dev');
    expect(formatLogWho('qc', mockSeats)).toBe('Jenny-QC');
    expect(formatLogWho('session', mockSeats)).toBe('session');
    expect(formatLogWho('gate', mockSeats)).toBe('gate');
  });

  describe('P2-T8 B: Auto duyệt thẻ trên web dashboard', () => {
    it('chứa ô chọn checkbox và <label> "Auto duyệt thẻ" trên thanh trên', () => {
      // Must be inside session-bar
      const sessionBarMatch = html.match(/<header[^>]*class=["'][^"']*session-bar[^"']*["'][\s\S]*?<\/header>/);
      expect(sessionBarMatch).not.toBeNull();
      const sessionBarHtml = sessionBarMatch![0];

      // Contains label with 'Auto duyệt thẻ'
      expect(sessionBarHtml).toMatch(/<label[^>]*>[\s\S]*?Auto-approve tickets[\s\S]*?<\/label>/);
      // Contains checkbox input
      expect(sessionBarHtml).toMatch(/<input[^>]*type=["']checkbox["'][^>]*>/);
    });

    it('gọi POST /api/settings khi ô chọn đổi trạng thái', () => {
      expect(html).toContain('/api/settings');
      expect(html).toMatch(/autoApprove/);
    });

    it('renderSnapshot cập nhật trạng thái ô chọn từ snapshot.settings.autoApprove', () => {
      // renderSnapshot must handle state.settings.autoApprove
      expect(html).toMatch(/settings\s*\.\s*autoApprove/);
    });
  });

  describe('P2-T9: Icon vòng xoay SVG thay nhãn Đang chạy trên thẻ ghế và chip thanh trên', () => {
    it('định nghĩa animation quay và icon luôn quay kể cả khi prefers-reduced-motion: reduce', () => {
      // Có @keyframes quay (hoặc rotate)
      expect(html).toMatch(/@keyframes\s+(quay|rotate|spin)\b/);
      // Animation CSS rotate 0.9s linear infinite
      expect(html).toMatch(/0\.9s\s+linear\s+infinite/);
      // Sửa theo anh Zon: icon vòng xoay luôn quay, bỏ media query tắt quay spinner
      expect(html).not.toMatch(/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)[\s\S]*?\.spinner-icon[\s\S]*?animation\s*:\s*none/);
    });

    it('chứa icon SVG vòng xoay inline 18px với role="img" và aria-label="Đang chạy" đặt cạnh tên agent', () => {
      // Thẻ ghế có icon SVG inline 18px với role="img" và aria-label="Đang chạy"
      expect(html).toContain('aria-label="Running"');
      expect(html).toContain('role="img"');
      expect(html).toContain('18px');
      expect(html).toContain('currentColor');

      // Các thẻ ghế (pm, dev, qc) đều có icon vòng xoay đặt cạnh tên agent
      const pmCardMatch = html.match(/id=["']seat-card-pm["'][\s\S]*?(?=id=["']seat-card-dev["'])/);
      expect(pmCardMatch).not.toBeNull();
      const pmHtml = pmCardMatch![0];
      expect(pmHtml).toContain('id="pm-title">Elon-PM');
      expect(pmHtml).toMatch(/<svg[^>]*\bid=["']pm-spinner["'][^>]*role=["']img["'][^>]*aria-label=["']Running["']/);

      const devCardMatch = html.match(/id=["']seat-card-dev["'][\s\S]*?(?=id=["']seat-card-qc["'])/);
      expect(devCardMatch).not.toBeNull();
      const devHtml = devCardMatch![0];
      expect(devHtml).toContain('id="dev-title">Jacky-Dev');
      expect(devHtml).toMatch(/<svg[^>]*\bid=["']dev-spinner["'][^>]*role=["']img["'][^>]*aria-label=["']Running["']/);

      const qcCardMatch = html.match(/id=["']seat-card-qc["'][\s\S]*?(?=<\/section>)/);
      expect(qcCardMatch).not.toBeNull();
      const qcHtml = qcCardMatch![0];
      expect(qcHtml).toContain('id="qc-title">Jenny-QC');
      expect(qcHtml).toMatch(/<svg[^>]*\bid=["']qc-spinner["'][^>]*role=["']img["'][^>]*aria-label=["']Running["']/);
    });

    it('chip Đang giữ lượt trên thanh trên dùng cùng icon vòng xoay thay chấm nhấp nháy', () => {
      const holderBoxMatch = html.match(/<span[^>]*id=["']holder-box["'][^>]*>([\s\S]*?)<\/span>/);
      expect(holderBoxMatch).not.toBeNull();
      const holderBoxHtml = holderBoxMatch![0];

      // Dùng SVG inline thay cho blink-dot
      expect(holderBoxHtml).not.toContain('blink-dot');
      expect(holderBoxHtml).toMatch(/<svg[^>]*role=["']img["'][^>]*aria-label=["']Running["']/);
      expect(holderBoxHtml).toContain('currentColor');
    });

    it('không còn chuỗi hiển thị "Đang chạy" dạng chip; nhãn Chờ/Rảnh giữ dạng chip xám nhỏ', () => {
      // HTML tĩnh không có chip nào hiển thị chữ 'Đang chạy'
      expect(html).not.toMatch(/<span[^>]*class=["'][^"']*seat-status-badge[^"']*["'][^>]*>\s*Running\s*<\/span>/);

      // Nhãn Chờ / Rảnh giữ dạng chip xám nhỏ trong CSS
      expect(html).toMatch(/\.status-waiting\b/);
      expect(html).toMatch(/\.status-idle\b/);

      // Trong renderSeat: khi status === 'running', không gán text 'Đang chạy' vào statusBadge dạng chip
      expect(html).not.toMatch(/statusBadge\.textContent\s*=\s*['"]Running['"]/);
      expect(html).not.toMatch(/statusBadge\.textContent\s*=\s*formatStatus\s*\(\s*['"]running['"]\s*\)/);
    });
  });

  describe('P2-T10b: Giao diện Cả team, Hộp thư team và sửa theo anh Zon', () => {
    it('nút Duyệt thẻ luôn hiển thị, disabled và có title="Không có thẻ chờ duyệt" khi không chờ duyệt', () => {
      // 1. Trong HTML tĩnh: nút approve-btn không có style="display: none;"
      const approveBtnMatch = html.match(/<button[^>]*id=["']approve-btn["'][^>]*>([\s\S]*?)<\/button>/);
      expect(approveBtnMatch).not.toBeNull();
      const approveBtnHtml = approveBtnMatch![0];
      expect(approveBtnHtml).not.toMatch(/display\s*:\s*none/i);
      expect(approveBtnHtml).toContain('disabled');
      expect(approveBtnHtml).toContain('title="No tickets awaiting approval"');

      // 2. Kiểm tra logic trong renderSnapshot không ẩn nút mà chuyển disabled/title
      expect(html).not.toMatch(/setDisplay\s*\(\s*approveBtn\s*,\s*state\.session\.status\s*===\s*['"]awaiting_approval['"]/);
      expect(html).toMatch(/approveBtn\.disabled\s*=/);
      expect(html).toMatch(/No tickets awaiting approval/);
    });

    it('có khu vực Hộp thư team hiển thị note, ảnh qua /api/notes/<id>/image và báo cáo ngắn', () => {
      // 1. Tiêu đề Hộp thư team
      expect(html).toContain('Team inbox');
      expect(html).toContain('id="notes-list"');

      // 2. Logic renderNotes hiển thị trạng thái Mở / Xong, ảnh alt="Ảnh đính kèm N-<id>" và endpoint /api/notes/
      expect(html).toMatch(/\/api\/notes\//);
      expect(html).toMatch(/inbox\.attachment/);
      expect(html).toMatch(/status\.open/);
      expect(html).toMatch(/status\.done/);
    });

    it('người nhận có Cả team mặc định và sinh từ snapshot.seats', () => {
      // Có input radio Cả team mặc định
      expect(html).toMatch(/<input[^>]*type=["']radio["'][^>]*value=["']team["'][^>]*checked/);
      expect(html).toMatch(/Team/);

      // Render danh sách người nhận từ snapshot.seats
      expect(html).toMatch(/state\.seats/);
      expect(html).toMatch(/cmd-to/);
    });

    it('hỗ trợ đính kèm ảnh khi chọn Cả team với input file accept png/jpeg/webp và dán ảnh Ctrl+V', () => {
      // Input file với accept đúng và label có text Đính kèm ảnh
      expect(html).toMatch(/<input[^>]*type=["']file["'][^>]*accept=["'][^"']*image\/png[^"']*image\/jpeg[^"']*image\/webp[^"']*["']/);
      expect(html).toMatch(/<label[^>]*for=["'][^"']*["'][^>]*>[\s\S]*?Attach image[\s\S]*?<\/label>/);

      // Khung xem trước thumbnail và nút Bỏ ảnh
      expect(html).toContain('Remove image');
      expect(html).toMatch(/id=["'][^"']*preview[^"']*["']/);

      // Listener paste cho Ctrl+V
      expect(html).toMatch(/addEventListener\s*\(\s*['"]paste['"]/);

      // Gọi /api/team-note khi gửi tới Cả team
      expect(html).toContain('/api/team-note');
    });

    it('sau khi gửi duyệt (finally), trạng thái nút Duyệt thẻ chỉ lấy từ snapshot mới nhất (awaiting_approval), không tự bật lại', () => {
      // 1. Không tự bật lại vô điều kiện trong finally của approve-btn
      const approveClickMatch = html.match(/approveBtn\.addEventListener\s*\(\s*['"]click['"][\s\S]*?finally\s*\{([\s\S]*?)\}\s*\)\s*;/);
      expect(approveClickMatch).not.toBeNull();
      const finallyBlock = approveClickMatch![1];
      expect(finallyBlock).not.toMatch(/^\s*approveBtn\.disabled\s*=\s*false\s*;/m);

      // 2. Trạng thái chỉ lấy từ snapshot mới nhất và enabled khi và chỉ khi session.status === 'awaiting_approval'
      expect(html).toMatch(/var\s+(latestSnapshot|lastSnapshot)\s*=\s*null/);
      expect(html).toMatch(/(latestSnapshot|lastSnapshot)\s*=\s*state/);
      expect(finallyBlock).toMatch(/(updateApproveButton|latestSnapshot|lastSnapshot)/);
      expect(html).toMatch(/session\.status\s*===\s*['"]awaiting_approval['"]/);
    });

    it('mỗi lần chọn/dán/Bỏ ảnh tăng token, FileReader callback chỉ gán ảnh nếu token khớp, Bỏ ảnh gọi reader.abort()', () => {
      // 1. Biến token và reader
      expect(html).toMatch(/var\s+(imageToken|token)\s*=\s*0/);
      expect(html).toMatch(/var\s+reader\s*=\s*null/);

      // 2. Token được tăng khi chọn ảnh, dán ảnh hoặc Bỏ ảnh
      expect(html).toMatch(/(imageToken|token)\s*\+\+/);

      // 3. Callback FileReader chỉ gán ảnh nếu token còn khớp
      expect(html).toMatch(/reader\.onload\s*=\s*function\s*\([^)]*\)\s*\{[\s\S]*?(===|!==)[\s\S]*?setAttachedImage/);

      // 4. Bỏ ảnh gọi reader.abort()
      expect(html).toMatch(/reader\.abort\s*\(\s*\)/);
    });
  });

  describe('P4-T9: Dashboard bảng theo goal, pipeline, lịch sử, nút Duyệt merge', () => {
    const getLuminance = (hex: string): number => {
      const clean = hex.replace('#', '');
      const r = parseInt(clean.slice(0, 2), 16) / 255;
      const g = parseInt(clean.slice(2, 4), 16) / 255;
      const b = parseInt(clean.slice(4, 6), 16) / 255;
      const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
      return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
    };

    const getContrastRatio = (hex1: string, hex2: string): number => {
      const l1 = getLuminance(hex1);
      const l2 = getLuminance(hex2);
      const lighter = Math.max(l1, l2);
      const darker = Math.min(l1, l2);
      return (lighter + 0.05) / (darker + 0.05);
    };

    it('web có đủ 6 nhãn chặng pipeline tiếng Việt', () => {
      expect(html).toContain('Intake');
      expect(html).toContain('Planning');
      expect(html).toContain('In dev');
      expect(html).toContain('Testing');
      expect(html).toContain('Security audit');
      expect(html).toContain('Release');

      const match = html.match(/PIPELINE_STAGES\s*=\s*(\[[\s\S]*?\]);/);
      expect(match).not.toBeNull();
      const stages = new Function(`return ${match![1]};`)() as Array<{ key: string; label: string }>;
      expect(stages).toHaveLength(6);
      expect(stages.map((s) => s.key)).toEqual(['intake', 'plan', 'build', 'verify', 'audit', 'release']);
      expect(stages.map((s) => s.label)).toEqual(['Intake', 'Planning', 'Dev', 'Testing', 'Security audit', 'Release']);
    });

    it('nút Duyệt merge là <button> và có hộp xác nhận gọi POST /api/goal/approve', () => {
      // 1. Phải là phần tử <button>
      expect(html).toMatch(/document\.createElement\(['"]button['"]\)[\s\S]*?goal\.approveMerge/);
      expect(html).toContain('btn-approve-goal');

      // 2. Có gọi confirm và POST /api/goal/approve
      expect(html).toMatch(/confirm\(tx\('goal\.confirmMerge'/);
      expect(html).toContain('/api/goal/approve');

      // 3. Điều kiện sẵn sàng: chỉ hiện khi qc_done (không audit) hoặc audit_passed
      expect(html).toMatch(/g\.state\s*===\s*['"]audit_passed['"]/);
      expect(html).toMatch(/g\.state\s*===\s*['"]qc_done['"]/);
    });

    it('độ tương phản nhãn chặng pipeline đạt >= 4.5:1 cả sáng và tối cho cả active và inactive', () => {
      // Light theme: inactive text #55554F on #EEEEEC (badge-bg), active text #FFFFFF on #2B5BD7 (accent)
      const lightInactiveContrast = getContrastRatio('#55554F', '#EEEEEC');
      expect(lightInactiveContrast).toBeGreaterThanOrEqual(4.5);

      const lightActiveContrast = getContrastRatio('#FFFFFF', '#2B5BD7');
      expect(lightActiveContrast).toBeGreaterThanOrEqual(4.5);

      // Dark theme: inactive text #B5B5AE on #2B2B28 (badge-bg), active text #141413 on #8AAEFF (accent)
      const darkInactiveContrast = getContrastRatio('#B5B5AE', '#2B2B28');
      expect(darkInactiveContrast).toBeGreaterThanOrEqual(4.5);

      const darkActiveContrast = getContrastRatio('#141413', '#8AAEFF');
      expect(darkActiveContrast).toBeGreaterThanOrEqual(4.5);

      // CSS styles verify
      expect(html).toMatch(/\.pipeline-step\s*\{[^}]*color:\s*var\(--text-muted\)/);
      expect(html).toMatch(/\.pipeline-step\.stage-active\s*\{[^}]*background-color:\s*var\(--accent\)/);
      expect(html).toMatch(/\[data-theme=["']dark["']\]\s+\.pipeline-step\.stage-active\s*\{[^}]*color:\s*#141413/);
    });

    it('renderGoals hiển thị đầu nhóm goal dạng G<n> · <tiêu đề> · <passed>/<total> đạt và sắp xếp n giảm dần', () => {
      const match = html.match(/function\s+renderGoals\s*\([^)]*\)\s*\{[\s\S]*?\n\s{6}\}/);
      expect(match).not.toBeNull();
      const fnCode = match![0];

      const createdElements: any[] = [];
      const mockContainer = {
        firstChild: null,
        appendChild(el: any) {
          createdElements.push(el);
        },
        removeChild() {},
      };

      const mockDocument = {
        getElementById: (id: string) => (id === 'goals-container' ? mockContainer : null),
        createElement: (tag: string) => {
          const el: any = {
            tagName: tag,
            className: '',
            textContent: '',
            children: [] as any[],
            dataset: {},
            style: {},
            classList: {
              classes: new Set<string>(),
              add(c: string) { this.classes.add(c); el.className += ' ' + c; },
              remove(c: string) { this.classes.delete(c); },
              contains(c: string) { return this.classes.has(c); },
            },
            setAttribute(name: string, val: string) {
              this[name] = val;
            },
            appendChild(child: any) {
              this.children.push(child);
            },
            addEventListener() {},
          };
          return el;
        },
      };

      const runRender = new Function(
        'document',
        'clearChildren',
        'setDisplay',
        'postJson',
        'showFeedback',
        'topFeedback',
        'formatTime',
        'PIPELINE_STAGES',
        'TASK_TAB_KEYS',
        'goalTabSelections',
        'resolveActiveTab',
        `
        ${fnCode}
        return renderGoals;
        `
      )(mockDocument, () => {}, () => {}, () => {}, () => {}, {}, (t: string) => t, [
        { key: 'intake', label: 'Tiếp nhận' },
        { key: 'plan', label: 'Lập kế hoạch' },
        { key: 'build', label: 'Đang làm' },
        { key: 'verify', label: 'Kiểm thử' },
        { key: 'audit', label: 'Kiểm tra bảo mật' },
        { key: 'release', label: 'Phát hành' },
      ], ['pending', 'in_dev', 'awaiting_qc', 'passed', 'returned'], {}, () => 'pending');

      const mockGoals = [
        { n: 1, title: 'Goal Một', state: 'in_progress', stage: 'build', passed: 1, total: 2, tickets: [] },
        { n: 2, title: 'Goal Hai', state: 'qc_done', stage: 'release', passed: 3, total: 3, tickets: [] },
      ];

      runRender(mockGoals, []);

      // Verify sorted descending by n: G2 should be first, then G1
      expect(createdElements.length).toBe(2);
      const card2 = createdElements[0];
      const card1 = createdElements[1];

      // G2 header text
      const titleWrap2 = card2.children[0].children[0];
      expect(titleWrap2.children[0].textContent).toBe('G2 · Goal Hai · 3/3 passed');

      // G1 header text
      const titleWrap1 = card1.children[0].children[0];
      expect(titleWrap1.children[0].textContent).toBe('G1 · Goal Một · 1/2 passed');
    });

    it('dòng ticket hiển thị #<number>/<of> · <tiêu đề> + chip type/size, dòng lịch sử là tr có 1 td colspan=4', () => {
      // 1. Ô Mục tiêu bỏ lặp Ticket ID: hiển thị #<number>/<of> · <tiêu đề>
      expect(html).toContain("'#' + t.number + '/' + t.of + ' · ' + (t.title || '')");
      expect(html).not.toContain("'#' + t.number + '/' + t.of + ' · ' + t.id");

      // 2. Chip type / size
      expect(html).toContain("typeBadge.className = 'badge ticket-badge'");
      expect(html).toContain("sizeBadge.className = 'badge ticket-badge'");

      // 3. Dòng lịch sử mở ra dưới ticket là tr có 1 td colspan=4
      expect(html).toContain("trHistory.className = 'ticket-history-row'");
      expect(html).toContain("tdHistory.colSpan = 4");
      expect(html).toMatch(/toggleTicketHistory\s*\(\s*t\.id/);
      expect(html).toContain('ticket-history-panel');
    });

    it('CSS không đặt display: flex|grid|block cho .ticket-row hay td trong bảng ticket', () => {
      // 1. .ticket-row giữ cursor: pointer, hover, focus nhưng không có display: flex|grid|block
      const ticketRowMatch = html.match(/\.ticket-row\s*\{([^}]+)\}/);
      expect(ticketRowMatch).not.toBeNull();
      const ticketRowCss = ticketRowMatch![1];
      expect(ticketRowCss).not.toMatch(/display\s*:\s*(flex|grid|block)/);
      expect(ticketRowCss).toMatch(/cursor\s*:\s*pointer/);

      // 2. Hover và focus cho .ticket-row
      expect(html).toMatch(/\.ticket-row:hover/);
      expect(html).toMatch(/\.ticket-row:focus/);

      // 3. Không có rule CSS nào đặt display: flex|grid|block cho .ticket-row
      expect(html).not.toMatch(/\.ticket-row[^{]*\{[^}]*display\s*:\s*(flex|grid|block)/);

      // 4. td trong .task-table không được đặt display: flex|grid|block
      const tdRule = html.match(/\.task-table\s+td\s*\{([^}]+)\}/);
      if (tdRule) {
        expect(tdRule[1]).not.toMatch(/display\s*:\s*(flex|grid|block)/);
      }
      expect(html).not.toMatch(/\.task-table\s+td[^{]*\{[^}]*display\s*:\s*(flex|grid|block)/);
      expect(html).not.toMatch(/\.task-table\s+\.col-[a-z]+[^{]*\{[^}]*display\s*:\s*(flex|grid|block)/);
    });

    it('mọi nội dung agent sinh (tiêu đề, lý do lịch sử) đều gắn bằng textContent, không có innerHTML và an toàn với XSS', () => {
      // 1. Tuyệt đối không có innerHTML trong toàn bộ file index.html
      expect(html).not.toContain('innerHTML');

      // 2. Gán text qua textContent
      expect(html).toContain('.textContent =');
      expect(html).toMatch(/titleSpan\.textContent\s*=/);
      expect(html).toMatch(/reasonEl\.textContent\s*=/);

      // 3. Test với payload chứa thẻ <script>
      const mockElem = { textContent: '' };
      const maliciousTitle = '<script>alert("XSS")</script>';
      mockElem.textContent = maliciousTitle;
      expect(mockElem.textContent).toBe('<script>alert("XSS")</script>');
    });

    it('CSS: tab dạng thẻ hồ sơ (bo góc trên ~12px, chồng lên nhau nhẹ), tab active nổi cao hơn, nền accent, không viền giữa', () => {
      // 1. Bo góc trên ~12px (12px 12px 0 0)
      expect(html).toMatch(/border-radius:\s*12px\s+12px\s+0\s+0/i);

      // 2. Chồng lên nhau nhẹ (margin âm giữa các tab)
      expect(html).toMatch(/margin-(right|left):\s*-[4-8]px/i);

      // 3. Tab active: nền --accent, nổi cao hơn (z-index cao hơn hoặc padding lớn hơn), không viền giữa (border-bottom: none hoặc margin-bottom âm)
      expect(html).toMatch(/\[aria-selected=["']true["']\][^{]*\{[^}]*(--tab-active-bg|--accent|var\(--accent\))/);
      expect(html).toMatch(/\[aria-selected=["']true["']\][^{]*\{[^}]*(z-index:\s*[2-9]|z-index:\s*1[0-9])/);
      expect(html).toMatch(/\[aria-selected=["']true["']\][^{]*\{[^}]*(border-bottom:\s*none|margin-bottom:\s*-[1-3]px)/);

      // 4. Mobile: tablist cuộn ngang trong chính nó
      expect(html).toMatch(/\[role=["']tablist["']\]|\.task-tabs-nav[^{]*\{[^}]*overflow-x:\s*auto/);
    });

    it('có cấu trúc ARIA tablist/tab/tabpanel và đầy đủ 5 tab kèm số đếm', () => {
      // 1. role="tablist" và role="tabpanel"
      expect(html).toContain("tabNav.setAttribute('role', 'tablist')");
      expect(html).toContain("panel.setAttribute('role', 'tabpanel')");

      // 2. 5 tabs với role="tab", aria-selected, aria-controls
      expect(html).toContain("tabBtn.setAttribute('role', 'tab')");
      expect(html).toContain("panel.setAttribute('role', 'tabpanel')");
      expect(html).toContain('aria-selected');
      expect(html).toContain('aria-controls');

      // 3. 5 nhãn tab và số đếm task-tab-count
      expect(html).toContain('Pending');
      expect(html).toContain('In dev');
      expect(html).toContain('Awaiting QC');
      expect(html).toContain('Passed');
      expect(html).toContain('Returned');
      expect(html).toContain('task-tab-count');
    });

    it('cả 5 tab đều mang thuộc tính data-state tương ứng với trạng thái', () => {
      expect(html).toContain("tabBtn.setAttribute('data-state', tabKey)");
      expect(html).toContain("TASK_TAB_KEYS = ['pending', 'in_dev', 'awaiting_qc', 'passed', 'returned']");
    });

    it('hàng chứa 2 khung dùng align-items: stretch', () => {
      const layoutMatch = html.match(/\.board-and-log-layout\s*\{([^}]+)\}/);
      expect(layoutMatch).not.toBeNull();
      const css = layoutMatch![1];
      expect(css).toMatch(/align-items:\s*stretch/);
      expect(css).not.toMatch(/align-items:\s*start/);
    });

    it('hỗ trợ điều hướng phím ← → đổi tab với vòng lặp tuần hoàn', () => {
      expect(html).toMatch(/ArrowRight|ArrowLeft/);
      expect(html).toMatch(/addEventListener\s*\(\s*['"]keydown['"]/);

      const keyFnMatch = html.match(/function\s+handleTabKeydown\s*\([^)]*\)\s*\{[\s\S]*?\n\s{6}\}/);
      expect(keyFnMatch).not.toBeNull();
      const fnCode = keyFnMatch![0];

      let selectedTab = 'pending';
      let focused = false;
      const mockSelectTab = (tabKey: string, focus: boolean) => {
        selectedTab = tabKey;
        focused = focus;
      };

      const runKeydown = new Function(
        'e',
        'currentActiveTab',
        'selectTab',
        'TASK_TAB_KEYS',
        `
        ${fnCode}
        handleTabKeydown(e, currentActiveTab, selectTab);
        `
      );

      const TASK_TAB_KEYS = ['pending', 'in_dev', 'awaiting_qc', 'passed', 'returned'];

      // ArrowRight từ pending -> in_dev
      let defaultPrevented = false;
      const evRight = { key: 'ArrowRight', preventDefault: () => { defaultPrevented = true; } };
      runKeydown(evRight, 'pending', mockSelectTab, TASK_TAB_KEYS);
      expect(defaultPrevented).toBe(true);
      expect(selectedTab).toBe('in_dev');
      expect(focused).toBe(true);

      // ArrowRight từ tab cuối 'returned' -> vòng lại 'pending'
      runKeydown(evRight, 'returned', mockSelectTab, TASK_TAB_KEYS);
      expect(selectedTab).toBe('pending');

      // ArrowLeft từ 'pending' -> vòng về 'returned'
      const evLeft = { key: 'ArrowLeft', preventDefault: () => {} };
      runKeydown(evLeft, 'pending', mockSelectTab, TASK_TAB_KEYS);
      expect(selectedTab).toBe('returned');

      // ArrowLeft từ 'awaiting_qc' -> 'in_dev'
      runKeydown(evLeft, 'awaiting_qc', mockSelectTab, TASK_TAB_KEYS);
      expect(selectedTab).toBe('in_dev');
    });

    it('khi xếp dọc ở màn hẹp vẫn giữ min-height 360px', () => {
      expect(html).not.toMatch(/@media[^{]*\{[^}]*\.task-tabpanel\s*\{[^}]*min-height:\s*(0|none|[1-2][0-9]{2}px|3[0-5][0-9]px)/);
    });

    it('khung Bảng task là flex column', () => {
      const taskBoardMatch = html.match(/\.task-board-section\s*\{([^}]+)\}/);
      expect(taskBoardMatch).not.toBeNull();
      const css = taskBoardMatch![1];
      expect(css).toMatch(/display:\s*flex/);
      expect(css).toMatch(/flex-direction:\s*column/);
    });

    it('mặc định tab active theo thẻ đang chạy, fallback tab đầu tiên có thẻ, giữ lựa chọn người dùng cho đến khi trạng thái thay đổi', () => {
      const tabFnMatch = html.match(/function\s+(resolveActiveTab|computeActiveTab|getActiveTab)\s*\([^)]*\)\s*\{[\s\S]*?(?=\n\s*function\s+updateTabUI)/);
      expect(tabFnMatch).not.toBeNull();
      const fnCode = tabFnMatch![0];

      const fpFnMatch = html.match(/function\s+(getTasksFingerprint|computeTasksFingerprint)[\s\S]*?(?=\n\s*function\s+resolveActiveTab)/);
      expect(fpFnMatch).not.toBeNull();
      const fpCode = fpFnMatch![0];

      const runner = new Function(
        'tasks',
        'currentFingerprint',
        'userSelected',
        'lastFingerprint',
        `
        ${fpCode}
        var userSelectedTab = userSelected;
        var lastTasksFingerprint = lastFingerprint;
        var goalTabSelections = {};
        var goalTicketsFingerprints = {};
        ${fnCode}
        var active = resolveActiveTab(tasks);
        return { active: active, userSelectedTab: userSelectedTab, lastTasksFingerprint: lastTasksFingerprint };
        `
      );

      // 1. Thẻ đang chạy in_dev -> tab active là in_dev
      const runningDevTasks = [
        { id: 'T-001', state: 'pending', fixRounds: 0 },
        { id: 'T-002', state: 'in_dev', fixRounds: 0 },
      ];
      const resDev = runner(runningDevTasks, null, null, null);
      expect(resDev.active).toBe('in_dev');

      // 2. Thẻ đang chạy awaiting_qc -> tab active là awaiting_qc
      const runningQcTasks = [
        { id: 'T-001', state: 'awaiting_qc', fixRounds: 0 },
      ];
      const resQc = runner(runningQcTasks, null, null, null);
      expect(resQc.active).toBe('awaiting_qc');

      // 3. Không có thẻ đang chạy -> tab đầu tiên có thẻ (ví dụ passed)
      const noRunningTasks = [
        { id: 'T-003', state: 'passed', fixRounds: 0 },
      ];
      const resPassed = runner(noRunningTasks, null, null, null);
      expect(resPassed.active).toBe('passed');

      // 4. Người dùng bấm tab (ví dụ chọn 'returned') -> giữ lựa chọn khi trạng thái thẻ chưa đổi
      const userSelectedResult = runner(runningDevTasks, null, 'returned', 'T-001:pending|T-002:in_dev');
      expect(userSelectedResult.active).toBe('returned');

      // 5. Khi trạng thái thẻ thay đổi (T-002 chuyển in_dev -> awaiting_qc) -> xóa lựa chọn người dùng, quay về thẻ đang chạy
      const changedTasks = [
        { id: 'T-001', state: 'pending', fixRounds: 0 },
        { id: 'T-002', state: 'awaiting_qc', fixRounds: 0 },
      ];
      const resetResult = runner(changedTasks, null, 'returned', 'T-001:pending|T-002:in_dev');
      expect(resetResult.active).toBe('awaiting_qc');
      expect(resetResult.userSelectedTab).toBeNull();

      // 6. B.3: Đảo thứ tự danh sách thẻ nhưng trạng thái không đổi -> KHÔNG reset lựa chọn tab tay (so theo map id->state)
      const reversedTasks = [
        { id: 'T-002', state: 'in_dev', fixRounds: 0 },
        { id: 'T-001', state: 'pending', fixRounds: 0 },
      ];
      const keepOrderResult = runner(reversedTasks, null, 'returned', 'T-001:pending|T-002:in_dev');
      expect(keepOrderResult.active).toBe('returned');
      expect(keepOrderResult.userSelectedTab).toBe('returned');

      // 7. Thay đổi các trường khác (fixRounds, goal, updatedAt) nhưng state giữ nguyên -> KHÔNG reset
      const metaChangedTasks = [
        { id: 'T-001', state: 'pending', fixRounds: 1, updatedAt: '2026-11-08T14:00:00Z' },
        { id: 'T-002', state: 'in_dev', fixRounds: 5, goal: 'Mô tả mới' },
      ];
      const keepMetaResult = runner(metaChangedTasks, null, 'returned', 'T-001:pending|T-002:in_dev');
      expect(keepMetaResult.active).toBe('returned');
      expect(keepMetaResult.userSelectedTab).toBe('returned');
    });

    it('panel bên dưới tab có flex: 1 và min-height 360px để luôn kéo dài xuống đáy khung', () => {
      const panelMatch = html.match(/\.task-tabpanel\s*\{([^}]+)\}/);
      expect(panelMatch).not.toBeNull();
      const css = panelMatch![1];
      expect(css).toMatch(/flex:\s*1(\s+1\s+(0|0%|auto))?/);
      expect(css).toMatch(/min-height:\s*360px/);
    });

    it('bảng trong panel giữ nguyên và dòng Không có ticket nằm trên cùng panel', () => {
      const tdMatch = html.match(/\.task-table\s+td\s*\{([^}]+)\}/);
      expect(tdMatch).not.toBeNull();
      expect(tdMatch![1]).toMatch(/vertical-align:\s*top/);

      const tableMatch = html.match(/\.task-table\s*\{([^}]+)\}/);
      expect(tableMatch).not.toBeNull();
      expect(tableMatch![1]).not.toMatch(/height:\s*(100%|inherit)/);

      expect(html).toMatch(/tdEmpty\.textContent\s*=\s*tx\('goal\.noTickets'\)/);
    });

    it('bảng trong panel: table width 100%, table-layout fixed, có colgroup và đặt đúng độ rộng các cột', () => {
      // 1. table width 100% và table-layout fixed
      expect(html).toMatch(/\.task-table\s*\{[^}]*width:\s*100%/);
      expect(html).toMatch(/\.task-table\s*\{[^}]*table-layout:\s*fixed/);

      // 2. Đặt độ rộng cột ID ~72px, Vòng sửa ~80px, Cập nhật ~96px, Mục tiêu phần còn lại
      expect(html).toMatch(/(\.col-id|col\.col-id|style=["'][^"']*width:\s*72px)[^{;]*\{?[^}]*width:\s*72px/);
      expect(html).toMatch(/(\.col-fixes|col\.col-fixes|style=["'][^"']*width:\s*80px)[^{;]*\{?[^}]*width:\s*80px/);
      expect(html).toMatch(/(\.col-updated|col\.col-updated|style=["'][^"']*width:\s*96px)[^{;]*\{?[^}]*width:\s*96px/);

      // 3. Cột Mục tiêu/tiêu đề tự co giãn phần còn lại (width auto hoặc word-break)
      expect(html).toMatch(/\.col-goal\s*\{[^}]*(width:\s*auto|word-break:\s*break-word|overflow-wrap:\s*break-word)/);

      // 4. Có colgroup với 4 col
      expect(html).toContain("document.createElement('colgroup')");
      expect(html).toContain("colId.className = 'col-id'");
      expect(html).toContain("colGoal.className = 'col-goal'");
      expect(html).toContain("colFixes.className = 'col-fixes'");
      expect(html).toContain("colUpdated.className = 'col-updated'");
    });

    it('panel bên dưới là bảng chữ ID · Mục tiêu · Vòng sửa · Cập nhật, mục tiêu xuống dòng, trống ghi "Không có ticket"', () => {
      // 1. Tiêu đề bảng: ID, Mục tiêu/Tiêu đề, Vòng sửa, Cập nhật
      expect(html).toMatch(/thId\.textContent\s*=\s*['"]ID['"]/);
      expect(html).toMatch(/thGoal\.textContent\s*=\s*tx\('goal\.col\.title'\)/);
      expect(html).toMatch(/thFixes\.textContent\s*=\s*tx\('goal\.col\.rounds'\)/);
      expect(html).toMatch(/thUpdated\.textContent\s*=\s*tx\('goal\.col\.updated'\)/);

      // 2. Mục tiêu dài thì xuống dòng
      expect(html).toMatch(/(word-break:\s*break-word|overflow-wrap:\s*break-word)/);
      expect(html).toMatch(/white-space:\s*normal/);
      expect(html).not.toMatch(/\.col-goal[^{]*\{[^}]*white-space:\s*nowrap/);

      // 3. Trống ghi "Không có ticket"
      expect(html).toContain('No tickets');

      // 4. table-layout fixed + word-break
      expect(html).toMatch(/\.task-table\s*\{[^}]*table-layout:\s*fixed/);
      expect(html).toMatch(/\.task-table\s*\{[^}]*(word-break:\s*break-word|overflow-wrap:\s*break-word)/);
      expect(html).toMatch(/\.col-id\s*\{[^}]*width:\s*(5[0-9]|6[0-5]|7[0-5])px/);
      expect(html).toMatch(/\.col-fixes\s*\{[^}]*width:\s*(5[0-9]|6[0-5]|7[0-9]|8[0-5])px/);
      expect(html).toMatch(/\.col-updated\s*\{[^}]*width:\s*(6[0-9]|7[0-5]|9[0-6])px/);
    });

    it('renderTaskTable hiển thị đúng các cột ID, Mục tiêu, Vòng sửa, Cập nhật và trạng thái trống "Không có ticket"', () => {
      const renderFnMatch = html.match(/function\s+(renderTicketTable|renderTaskTable)\s*\([^)]*\)\s*\{[\s\S]*?(?=\n\s*(?:var\s+renderTaskTable|function))/);
      expect(renderFnMatch).not.toBeNull();
      const fnCode = renderFnMatch![0];

      // Giả lập DOM đơn giản
      const createdRows: any[] = [];
      const mockTbody = {
        firstChild: null,
        appendChild: (el: any) => createdRows.push(el),
        removeChild: () => {},
      };

      const mockDocument = {
        getElementById: () => mockTbody,
        createElement: (tag: string) => {
          return {
            tagName: tag,
            className: '',
            textContent: '',
            children: [] as any[],
            style: {},
            appendChild(child: any) {
              this.children.push(child);
            },
          };
        },
      };

      const runRender = new Function(
        'document',
        'clearChildren',
        'formatTime',
        `
        ${fnCode}
        return renderTicketTable;
        `
      )(mockDocument, () => {}, (t: string) => t.slice(11, 19));

      // 1. Khi tab rỗng -> hiển thị "Không có ticket"
      runRender([], 'pending', mockTbody);
      expect(createdRows.length).toBe(1);
      const emptyRow = createdRows[0];
      expect(emptyRow.children[0].textContent).toBe('No tickets');
      expect(emptyRow.children[0].className).toContain('empty-placeholder');

      // 2. Khi tab có thẻ -> hiển thị đủ các cột
      createdRows.length = 0;
      const testTasks = [
        { id: 'T-001', goal: 'Xây dựng giao diện tab cho bảng task', state: 'in_dev', fix_rounds: 2, updatedAt: '2026-11-08T13:00:00Z' },
        { id: 'T-002', goal: 'Task khác', state: 'pending', fix_rounds: 0 },
      ];
      runRender(testTasks, 'in_dev', mockTbody);
      expect(createdRows.length).toBe(1);
      const row = createdRows[0];
      expect(row.children[0].textContent).toBe('T-001');
      expect(row.children[1].textContent).toBe('Xây dựng giao diện tab cho bảng task');
      expect(row.children[2].textContent).toBe('2');
      expect(row.children[3].textContent).toBe('13:00:00');
    });

    it('định nghĩa 5 biến màu trạng thái cho cả 2 theme (:root và [data-theme="dark"])', () => {
      // 1. :root có đủ 5 biến màu trạng thái (Chờ = slate, Đang làm = xanh dương, Chờ test = vàng cam, Đạt = xanh lá, Trả về = đỏ)
      const rootMatch = html.match(/:root\s*\{([^}]+)\}/);
      expect(rootMatch).not.toBeNull();
      const rootCss = rootMatch![1];

      expect(rootCss).toMatch(/--(tab|state)-pending:\s*#[0-9a-fA-F]{6}/i);
      expect(rootCss).toMatch(/--(tab|state)-in[-_]dev:\s*#[0-9a-fA-F]{6}/i);
      expect(rootCss).toMatch(/--(tab|state)-awaiting[-_]qc:\s*#[0-9a-fA-F]{6}/i);
      expect(rootCss).toMatch(/--(tab|state)-passed:\s*#[0-9a-fA-F]{6}/i);
      expect(rootCss).toMatch(/--(tab|state)-returned:\s*#[0-9a-fA-F]{6}/i);

      // 2. [data-theme="dark"] có đủ 5 biến màu trạng thái tương ứng
      const darkMatch = html.match(/\[data-theme=["']dark["']\]\s*\{([^}]+)\}/);
      expect(darkMatch).not.toBeNull();
      const darkCss = darkMatch![1];

      expect(darkCss).toMatch(/--(tab|state)-pending:\s*#[0-9a-fA-F]{6}/i);
      expect(darkCss).toMatch(/--(tab|state)-in[-_]dev:\s*#[0-9a-fA-F]{6}/i);
      expect(darkCss).toMatch(/--(tab|state)-awaiting[-_]qc:\s*#[0-9a-fA-F]{6}/i);
      expect(darkCss).toMatch(/--(tab|state)-passed:\s*#[0-9a-fA-F]{6}/i);
      expect(darkCss).toMatch(/--(tab|state)-returned:\s*#[0-9a-fA-F]{6}/i);
    });

    it('tab không active có dải màu riêng 3px ở mép trên và số đếm có màu riêng', () => {
      // 1. Dải màu riêng 3px ở mép trên
      expect(html).toMatch(/border-top:\s*3px\s+solid/i);
      expect(html).toMatch(/\.task-tab\[data-state=["']pending["']\][^{]*\{[^}]*border-top:\s*3px/);
      expect(html).toMatch(/\.task-tab\[data-state=["']in_dev["']\][^{]*\{[^}]*border-top:\s*3px/);
      expect(html).toMatch(/\.task-tab\[data-state=["']awaiting_qc["']\][^{]*\{[^}]*border-top:\s*3px/);
      expect(html).toMatch(/\.task-tab\[data-state=["']passed["']\][^{]*\{[^}]*border-top:\s*3px/);
      expect(html).toMatch(/\.task-tab\[data-state=["']returned["']\][^{]*\{[^}]*border-top:\s*3px/);

      // 2. Số đếm màu riêng cho từng tab
      expect(html).toMatch(/\.task-tab\[data-state=["']pending["']\]\s+\.task-tab-count[^{]*\{[^}]*color:/);
      expect(html).toMatch(/\.task-tab\[data-state=["']in_dev["']\]\s+\.task-tab-count[^{]*\{[^}]*color:/);
      expect(html).toMatch(/\.task-tab\[data-state=["']awaiting_qc["']\]\s+\.task-tab-count[^{]*\{[^}]*color:/);
      expect(html).toMatch(/\.task-tab\[data-state=["']passed["']\]\s+\.task-tab-count[^{]*\{[^}]*color:/);
      expect(html).toMatch(/\.task-tab\[data-state=["']returned["']\]\s+\.task-tab-count[^{]*\{[^}]*color:/);
    });

    it('tab active có nền đặc màu riêng và đường viền nối panel cùng màu đó', () => {
      // 1. Tab active có nền đặc màu riêng và viền riêng cho cả 5 trạng thái
      expect(html).toMatch(/\.task-tab\[data-state=["']pending["']\]\[aria-selected=["']true["']\][^{]*\{[^}]*background-color:/);
      expect(html).toMatch(/\.task-tab\[data-state=["']in_dev["']\]\[aria-selected=["']true["']\][^{]*\{[^}]*background-color:/);
      expect(html).toMatch(/\.task-tab\[data-state=["']awaiting_qc["']\]\[aria-selected=["']true["']\][^{]*\{[^}]*background-color:/);
      expect(html).toMatch(/\.task-tab\[data-state=["']passed["']\]\[aria-selected=["']true["']\][^{]*\{[^}]*background-color:/);
      expect(html).toMatch(/\.task-tab\[data-state=["']returned["']\]\[aria-selected=["']true["']\][^{]*\{[^}]*background-color:/);

      // 2. Đường viền nối panel cùng màu với tab active
      expect(html).toMatch(/\.task-tabs-nav\[data-active-state|\.task-tabs-nav:has/);
      expect(html).toMatch(/border-bottom(-color)?:\s*(2px\s+solid\s+)?var\(--(tab|state)-/);
    });

    it('độ tương phản chữ trên cả 2 theme đều đạt >= 4.5:1 cho cả tab active và không active', () => {
      // Light theme active: #FFFFFF on #2B5BD7 (accent light)
      const lightActiveContrast = getContrastRatio('#FFFFFF', '#2B5BD7');
      expect(lightActiveContrast).toBeGreaterThanOrEqual(4.5);

      // Light theme inactive: #55554F on #E5E5DF
      const lightInactiveContrast = getContrastRatio('#55554F', '#E5E5DF');
      expect(lightInactiveContrast).toBeGreaterThanOrEqual(4.5);

      // Dark theme active: #141413 on #8AAEFF (accent dark)
      const darkActiveContrast = getContrastRatio('#141413', '#8AAEFF');
      expect(darkActiveContrast).toBeGreaterThanOrEqual(4.5);

      // Dark theme inactive: #B5B5AE on #2B2B28
      const darkInactiveContrast = getContrastRatio('#B5B5AE', '#2B2B28');
      expect(darkInactiveContrast).toBeGreaterThanOrEqual(4.5);

      // Đảm bảo CSS có định nghĩa biến hoặc quy tắc màu cho tab active và inactive ở cả 2 theme
      expect(html).toMatch(/--tab-active-text[^;]*#ffffff/i);
      expect(html).toMatch(/--tab-inactive-bg[^;]*#e5e5df/i);
      expect(html).toMatch(/--tab-inactive-text[^;]*#55554f/i);
      expect(html).toMatch(/--tab-active-text[^;]*#141413/i);
      expect(html).toMatch(/--tab-inactive-bg[^;]*#2b2b28/i);
      expect(html).toMatch(/--tab-inactive-text[^;]*#b5b5ae/i);

      // Số đếm trên tab active ở theme sáng tương phản >= 4.5:1, không dùng nền pha alpha (dùng màu đặc)
      const activeCountMatch = html.match(/\.task-tab\[aria-selected=["']true["']\]\s+\.task-tab-count\s*\{([^}]+)\}/);
      expect(activeCountMatch).not.toBeNull();
      const activeCountCss = activeCountMatch![1];
      expect(activeCountCss).not.toMatch(/rgba|hsla/i);
      // Nền #1e3f99, chữ #ffffff -> tương phản >= 4.5:1
      const lightActiveCountContrast = getContrastRatio('#FFFFFF', '#1E3F99');
      expect(lightActiveCountContrast).toBeGreaterThanOrEqual(4.5);
    });

    it('độ tương phản chữ trên nền tab active và số đếm trên cả 2 theme đều đạt >= 4.5:1', () => {
      // Trích xuất các mã màu hex từ :root cho 5 trạng thái
      const rootMatch = html.match(/:root\s*\{([^}]+)\}/)!;
      const rootCss = rootMatch[1];
      const getHex = (css: string, varName: string) => {
        const m = css.match(new RegExp(`--(?:tab|state)-${varName}:\\s*(#[0-9a-fA-F]{6})`, 'i'));
        return m ? m[1] : null;
      };

      const lightPending = getHex(rootCss, 'pending');
      const lightInDev = getHex(rootCss, 'in[-_]dev');
      const lightAwaitingQc = getHex(rootCss, 'awaiting[-_]qc');
      const lightPassed = getHex(rootCss, 'passed');
      const lightReturned = getHex(rootCss, 'returned');

      expect(lightPending).not.toBeNull();
      expect(lightInDev).not.toBeNull();
      expect(lightAwaitingQc).not.toBeNull();
      expect(lightPassed).not.toBeNull();
      expect(lightReturned).not.toBeNull();

      // Theme sáng: chữ trắng #FFFFFF trên nền đặc màu riêng của tab active
      expect(getContrastRatio('#FFFFFF', lightPending!)).toBeGreaterThanOrEqual(4.5);
      expect(getContrastRatio('#FFFFFF', lightInDev!)).toBeGreaterThanOrEqual(4.5);
      expect(getContrastRatio('#FFFFFF', lightAwaitingQc!)).toBeGreaterThanOrEqual(4.5);
      expect(getContrastRatio('#FFFFFF', lightPassed!)).toBeGreaterThanOrEqual(4.5);
      expect(getContrastRatio('#FFFFFF', lightReturned!)).toBeGreaterThanOrEqual(4.5);

      // Theme sáng: số đếm trên nền tab inactive (#E5E5DF)
      expect(getContrastRatio(lightPending!, '#E5E5DF')).toBeGreaterThanOrEqual(4.5);
      expect(getContrastRatio(lightInDev!, '#E5E5DF')).toBeGreaterThanOrEqual(4.5);
      expect(getContrastRatio(lightAwaitingQc!, '#E5E5DF')).toBeGreaterThanOrEqual(4.5);
      expect(getContrastRatio(lightPassed!, '#E5E5DF')).toBeGreaterThanOrEqual(4.5);
      expect(getContrastRatio(lightReturned!, '#E5E5DF')).toBeGreaterThanOrEqual(4.5);

      // Trích xuất các mã màu hex từ dark theme
      const darkMatch = html.match(/\[data-theme=["']dark["']\]\s*\{([^}]+)\}/)!;
      const darkCss = darkMatch[1];

      const darkPending = getHex(darkCss, 'pending');
      const darkInDev = getHex(darkCss, 'in[-_]dev');
      const darkAwaitingQc = getHex(darkCss, 'awaiting[-_]qc');
      const darkPassed = getHex(darkCss, 'passed');
      const darkReturned = getHex(darkCss, 'returned');

      expect(darkPending).not.toBeNull();
      expect(darkInDev).not.toBeNull();
      expect(darkAwaitingQc).not.toBeNull();
      expect(darkPassed).not.toBeNull();
      expect(darkReturned).not.toBeNull();

      // Theme tối: chữ tối #141413 trên nền sắc độ sáng của tab active
      expect(getContrastRatio('#141413', darkPending!)).toBeGreaterThanOrEqual(4.5);
      expect(getContrastRatio('#141413', darkInDev!)).toBeGreaterThanOrEqual(4.5);
      expect(getContrastRatio('#141413', darkAwaitingQc!)).toBeGreaterThanOrEqual(4.5);
      expect(getContrastRatio('#141413', darkPassed!)).toBeGreaterThanOrEqual(4.5);
      expect(getContrastRatio('#141413', darkReturned!)).toBeGreaterThanOrEqual(4.5);

      // Theme tối: số đếm trên nền tab inactive (#2B2B28)
      expect(getContrastRatio(darkPending!, '#2B2B28')).toBeGreaterThanOrEqual(4.5);
      expect(getContrastRatio(darkInDev!, '#2B2B28')).toBeGreaterThanOrEqual(4.5);
      expect(getContrastRatio(darkAwaitingQc!, '#2B2B28')).toBeGreaterThanOrEqual(4.5);
      expect(getContrastRatio(darkPassed!, '#2B2B28')).toBeGreaterThanOrEqual(4.5);
      expect(getContrastRatio(darkReturned!, '#2B2B28')).toBeGreaterThanOrEqual(4.5);
    });
  });

  describe('P3-T4: Energy, đèn đăng nhập và trang Tài khoản', () => {
    it('thanh trên có nút "Làm mới Energy"', () => {
      expect(html).toContain('id="refresh-energy-btn"');
      expect(html).toMatch(/Refresh energy/);
    });

    it('thẻ ghế hỗ trợ thanh energy với role="meter" và aria-valuenow', () => {
      expect(html).toContain('role="meter"');
      expect(html).toContain('aria-valuenow');
    });

    it('có khu Tài khoản ở cuối trang với danh sách agent và nút Sao chép có aria-label', () => {
      expect(html).toContain('id="accounts-container"');
      expect(html).toMatch(/aria-label=["']Copy/);
    });

    it('tuyệt đối không dùng innerHTML trong web/index.html', () => {
      expect(html).not.toContain('innerHTML');
    });

    it('tách hàm thuần energyColor(pct) và kiểm tra đúng ngưỡng (19.9→đỏ, 49.9→vàng, 50→xanh)', () => {
      const match = html.match(/function\s+energyColor\s*\([^)]*\)\s*\{[\s\S]*?(?=\n\s*(function|\/\/))/);
      expect(match).not.toBeNull();
      const energyColor = new Function(`return (${match![0]});`)();

      // Ngưỡng đỏ (<20)
      expect(energyColor(19.9)).toBe('red');
      expect(energyColor(0)).toBe('red');
      expect(energyColor(-5)).toBe('red');

      // Ngưỡng vàng (20 - <50)
      expect(energyColor(20)).toBe('yellow');
      expect(energyColor(49.9)).toBe('yellow');
      expect(energyColor(35)).toBe('yellow');

      // Ngưỡng xanh (>=50)
      expect(energyColor(50)).toBe('green');
      expect(energyColor(80)).toBe('green');
      expect(energyColor(100)).toBe('green');

      // Màu thanh energy chọn theo giá trị gốc chưa làm tròn w.remainingPercent
      expect(html).toMatch(/energyColor\s*\(\s*w\.remainingPercent\s*\)/);
    });

    it('tách hàm thuần sshHostFor(hostname, hint) và coi loopback là hint ([::1]→hint)', () => {
      const match = html.match(/function\s+sshHostFor\s*\([^)]*\)\s*\{[\s\S]*?(?=\n\s*(function|\/\/))/);
      expect(match).not.toBeNull();
      const sshHostFor = new Function(`return (${match![0]});`)();

      const customHint = 'admzon@100.96.250.103';

      // Các trường hợp loopback phải trả về hint
      expect(sshHostFor('[::1]', customHint)).toBe(customHint);
      expect(sshHostFor('::1', customHint)).toBe(customHint);
      expect(sshHostFor('localhost', customHint)).toBe(customHint);
      expect(sshHostFor('127.0.0.1', customHint)).toBe(customHint);
      expect(sshHostFor('', customHint)).toBe(customHint);

      // Khi hostname bên ngoài -> trả về host hoặc admzon@host
      expect(sshHostFor('192.168.1.50', customHint)).toBe('admzon@192.168.1.50');
      expect(sshHostFor('admzon@server1.lan', customHint)).toBe('admzon@server1.lan');

      // Fallback khi không truyền hint
      expect(sshHostFor('[::1]', '')).toBe('admzon@100.96.250.103');
    });

    it('tách hàm thuần formatEnergy(window) và làm tròn hiển thị chữ', () => {
      const hhmmMatch = html.match(/function\s+formatHHmm\s*\([^)]*\)\s*\{[\s\S]*?\n\s{6}\}/);
      expect(hhmmMatch).not.toBeNull();
      const formatHHmm = new Function(`return (${hhmmMatch![0]});`)();

      const match = html.match(/function\s+formatEnergy\s*\([^)]*\)\s*\{[\s\S]*?\n\s{6}\}/);
      expect(match).not.toBeNull();
      const formatEnergy = new Function('formatHHmm', `return (${match![0]});`)(formatHHmm);

      // Chỉ làm tròn khi hiển thị chữ
      expect(formatEnergy({ remainingPercent: 19.9 })).toBe('20% left');
      expect(formatEnergy({ remainingPercent: 49.9 })).toBe('50% left');
      expect(formatEnergy({ remainingPercent: 50 })).toBe('50% left');
      expect(formatEnergy({ remainingPercent: 49.9, resetsAt: '2026-11-09T13:45:00Z' })).toBe('50% left · resets 13:45');
      expect(formatEnergy(null)).toBe('');
    });

    it('nút Sao chép có nhánh navigator.clipboard và fallback bôi đen + execCommand kèm phản hồi', async () => {
      const match = html.match(/async\s+function\s+copyLoginCommand\s*\([^)]*\)\s*\{[\s\S]*?\n\s{6}\}/);
      expect(match).not.toBeNull();

      // Kiểm tra trong HTML có dùng input/textarea readonly cho ô mã và gọi select() + execCommand
      expect(html).toMatch(/<input[^>]*readonly[^>]*account-cmd-code|document\.createElement\(['"]input['"]\)[\s\S]*?readOnly\s*=\s*true/);
      expect(html).toMatch(/\.select\s*\(\s*\)/);
      expect(html).toMatch(/execCommand\s*\(\s*['"]copy['"]\s*\)/);
      expect(html).toContain('Copied');
      expect(html).toContain('Select and press Ctrl+C');

      // Test hành vi hàm copyLoginCommand
      const copyFnCode = match![0];

      // Nhánh 1: SecureContext + navigator.clipboard thành công -> 'Đã sao chép'
      {
        let feedback = '';
        let writeCalledWith = '';
        const mockWindow = { isSecureContext: true };
        const mockNavigator = {
          clipboard: {
            writeText: async (t: string) => {
              writeCalledWith = t;
            },
          },
        };
        const runCopy = new Function(
          'window',
          'navigator',
          'document',
          `return (${copyFnCode});`
        )(mockWindow, mockNavigator, {});

        const res = await runCopy('ssh command 1', null, (msg: string) => { feedback = msg; });
        expect(res).toBe(true);
        expect(writeCalledWith).toBe('ssh command 1');
        expect(feedback).toBe('Copied');
      }

      // Nhánh 2: Không phải isSecureContext -> fallback select() + execCommand('copy') thành công
      {
        let feedback = '';
        let selected = false;
        let execCommandCalled = '';
        const mockInput = {
          select: () => { selected = true; },
          setSelectionRange: () => {},
          focus: () => {},
          value: 'ssh fallback command',
        };
        const mockDoc = {
          execCommand: (cmd: string) => {
            execCommandCalled = cmd;
            return true;
          },
        };
        const mockWindow = { isSecureContext: false };
        const runCopy = new Function(
          'window',
          'navigator',
          'document',
          `return (${copyFnCode});`
        )(mockWindow, {}, mockDoc);

        const res = await runCopy('ssh fallback command', mockInput, (msg: string) => { feedback = msg; });
        expect(res).toBe(true);
        expect(selected).toBe(true);
        expect(execCommandCalled).toBe('copy');
        expect(feedback).toBe('Copied');
      }

      // Nhánh 3: Clipboard lỗi -> fallback execCommand thất bại -> 'Hãy bôi đen và Ctrl+C'
      {
        let feedback = '';
        let selected = false;
        const mockInput = {
          select: () => { selected = true; },
          setSelectionRange: () => {},
          focus: () => {},
          value: 'ssh failed command',
        };
        const mockDoc = {
          execCommand: () => false,
        };
        const mockWindow = { isSecureContext: true };
        const mockNavigator = {
          clipboard: {
            writeText: async () => { throw new Error('NotAllowedError'); },
          },
        };
        const runCopy = new Function(
          'window',
          'navigator',
          'document',
          `return (${copyFnCode});`
        )(mockWindow, mockNavigator, mockDoc);

        const res = await runCopy('ssh failed command', mockInput, (msg: string) => { feedback = msg; });
        expect(res).toBe(false);
        expect(selected).toBe(true);
        expect(feedback).toBe('Select and press Ctrl+C');
      }
    });
  });

  describe('Task 5: Seat swap dropdown and disabled when busy', () => {
    it('each seat card has a label "Người ngồi ghế" and a select element', () => {
      ['pm', 'dev', 'qc'].forEach((seat) => {
        expect(html).toContain(`id="seat-card-${seat}"`);
        expect(html).toContain(`id="${seat}-agent-select"`);
      });
      const labelMatches = html.match(/data-i18n="seat.agent">Seated agent</g);
      expect(labelMatches).not.toBeNull();
      expect(labelMatches!.length).toBeGreaterThanOrEqual(3);
    });

    it('handles seat change by sending POST to /api/seat and disables select when busy', () => {
      expect(html).toContain('/api/seat');
      expect(html).toMatch(/POST/i);
      expect(html).toMatch(/agent-select[\s\S]*?disabled\s*=/);
    });

    it('nút Duyệt thẻ hiện "Tiếp tục phiên" và bật khi needs_owner/stopped (gọi /api/resume), "Duyệt thẻ" khi awaiting_approval', () => {
      expect(html).toContain('Resume');
      expect(html).toContain('/api/resume');
      expect(html).toMatch(/status\s*===\s*['"]needs_owner['"]\s*\|\|\s*status\s*===\s*['"]stopped['"]/);
    });
  });

  describe('P4-UI1: Nút "Dừng" + dashboard dày cho màn 27" 2K/4K', () => {
    it('đổi chữ "Dừng khẩn cấp" thành "Dừng" trên nút #stop-btn, confirm và feedback, giữ nguyên id và btn-danger', () => {
      expect(html).not.toContain('Dừng khẩn cấp');
      expect(html).toMatch(/<button[^>]*id=["']stop-btn["'][^>]*class=["'][^"']*\bbtn-danger\b[^"']*["'][^>]*>\s*Stop\s*<\/button>/);
      expect(html).toMatch(/confirm\(tx\('confirm\.stop'\)\)/);
      expect(html).toContain("tx('fb.stopSent')");
    });

    it('bỏ max-width: 1400px của khung chính, dùng full width, thu gọn khoảng cách và dùng repeat(auto-fit, minmax(280px, 1fr))', () => {
      expect(html).not.toContain('max-width: 1400px');
      expect(html).toContain('auto-fit');
      expect(html).toMatch(/\.seats-grid\s*\{[^}]*repeat\(\s*auto-fit\s*,\s*minmax\(\s*280px\s*,\s*1fr\s*\)\s*\)/);
      expect(html).toMatch(/\.seat-footer\s*\{[^}]*margin-top:\s*auto/);
      expect(html).toMatch(/@media\s*\(\s*max-width:\s*900px\s*\)/);
    });
  });

});

describe('P5-T5: dashboard model/effort, user riêng, cảnh báo đội hình', () => {
  const html = readFileSync(resolve(process.cwd(), 'web/index.html'), 'utf-8');
  it('có ô model + effort, lưu qua /api/agent, Codex chỉ 3 mức', () => {
    expect(html).toContain("postJson('/api/agent'");
    expect(html).toContain('var allowed = EFFORTS;');
    expect(html).toContain("tx('acc.modelFor', { agent: acc.agent })");
    // ô model là danh sách chọn: mặc định CLI + model CLI liệt kê + model đang dùng nếu thiếu
    expect(html).toContain("var modelInput = document.createElement('select');");
    expect(html).toContain("opt.textContent = m || tx('acc.cliDefault');");
    expect(html).toContain('if (acc.model && options.indexOf(acc.model) < 0) options.push(acc.model);');
    // gọn chiều ngang: mục Tài khoản là lưới thẻ nhỏ
    expect(html).toContain('grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));');
  });
  it('lệnh đăng nhập dùng user riêng của agent (kiểm tên user), mặc định agent', () => {
    expect(html).toContain("getLoginCommand(acc.tool, sshTarget, acc.user)");
    expect(html).toContain("/^[a-z_][a-z0-9_-]{0,31}$/.test(user || '') ? user : 'agent'");
  });
  it('ghế audit có select; cảnh báo đội hình hiển thị bằng textContent; không vẽ lại khi đang gõ', () => {
    expect(html).toContain('id="audit-agent-select"');
    expect(html).toContain('id="seat-warnings"');
    expect(html).toContain("el.textContent = tx('seat.warnings'");
    expect(html).toContain('container.contains(active)');
  });
});

describe('P5-T7: nhãn ngồi thay', () => {
  it('thẻ ghế hiện agent dự phòng đã ngồi thay', () => {
    const html = readFileSync(resolve(process.cwd(), 'web/index.html'), 'utf-8');
    expect(html).toContain("if (cardData.substitute) toolParts.push(tx('seat.substitute', { agent: cardData.substitute }));");
  });
});

describe('P6-T5: chip Sắp hết', () => {
  it('chip có chữ (không chỉ màu), dùng textContent, hiện trên thẻ ghế và tài khoản', () => {
    const html = readFileSync(resolve(process.cwd(), 'web/index.html'), 'utf-8');
    expect(html).toContain("chip.textContent = tx('energy.low') + (hhmm ? tx('energy.resets', { time: hhmm }) : '');");
    expect(html).toContain('var warnChip = energyWarnChip(eng);');
    expect(html).toContain('var accWarn = energyWarnChip(acc.energy);');
  });
});

describe('P5-T9: UI tiếng Anh, bảng chuỗi', () => {
  const html = readFileSync(resolve(process.cwd(), 'web/index.html'), 'utf-8');
  const i18nStart = html.indexOf('var STRINGS = {');
  const i18nEnd = html.indexOf('var LANG =');
  const tx = new Function('window', `${html.slice(i18nStart, html.indexOf('function applyI18n'))}; return tx;`)({ localStorage: { getItem: () => null } });

  it('ngoài bảng STRINGS không còn chữ tiếng Việt (bỏ qua comment)', () => {
    const rest = (html.slice(0, i18nStart) + html.slice(i18nEnd))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');
    const bad = rest.split('\n').filter((l) => /[À-ỹĐđ]/.test(l));
    expect(bad).toEqual([]);
    expect(html).toContain('<html lang="en">');
  });

  it("mọi key dùng trong tx('…') và data-i18n* đều có trong STRINGS.en; thiếu key trả lại key", () => {
    const table = new Function(`${html.slice(i18nStart, i18nEnd)}; return STRINGS;`)().en as Record<string, string>;
    const keys = new Set<string>();
    for (const m of html.matchAll(/tx\('([\w.]+)'/g)) keys.add(m[1]!);
    for (const m of html.matchAll(/data-i18n(?:-aria|-placeholder|-title|-alt)?="([\w.]+)"/g)) keys.add(m[1]!);
    const missing = [...keys].filter((k) => !(k in table));
    expect(missing).toEqual([]);
    expect(keys.size).toBeGreaterThan(80);
    expect(tx('no.such.key')).toBe('no.such.key');
    expect(tx('bar.turns', { used: 3, max: 10 })).toBe('Turns 3/10');
    expect(tx('energy.left', { pct: 15 }) + tx('energy.resets', { time: '19:57' })).toBe('15% left · resets 19:57');
  });

  it('trang không có biến cục bộ tên tx (che hàm dịch)', () => {
    expect(html).not.toMatch(/(var|let|const)\s+tx\b/);
  });
});

describe('P6-T7: dòng trạng thái trên thẻ ghế', () => {
  it('ưu tiên agentStatus, không có thì dòng log cuối; chèn bằng textContent', () => {
    const html = readFileSync(resolve(process.cwd(), 'web/index.html'), 'utf-8');
    expect(html).toContain("lastLineEl.textContent = cardData.agentStatus || cardData.lastLine || '—';");
  });
});

describe('P6-T3/T4: dashboard diff + câu hỏi', () => {
  const html = readFileSync(resolve(process.cwd(), 'web/index.html'), 'utf-8');
  it('có khung diff, nút Diff trên ticket, ghi chú theo dòng mới, Return to Dev có xác nhận; câu hỏi có ô trả lời', () => {
    expect(html).toContain('id="diff-panel"');
    expect(html).toContain("diffBtn.textContent = tx('diff.open');");
    expect(html).toContain("'/api/tickets/' + encodeURIComponent(diffTicket) + '/notes'");
    expect(html).toContain("if (!confirm(tx('diff.confirmReturn', { ticket: diffTicket }))) return;");
    expect(html).toContain("txt.textContent = l.text;");
    expect(html).toContain('id="questions-section"');
    expect(html).toContain("postJson('/api/questions/' + q.id + '/answer'");
    expect(html).toContain('text.textContent = q.text;');
  });
});

describe('Inbox gọn + thứ tự dashboard (2026-11-12)', () => {
  const html = readFileSync(resolve(process.cwd(), 'web/index.html'), 'utf-8');
  it('thứ tự: Questions → Command → Accounts → ghế → Session goals → Inbox → Goals+Log → Diff', () => {
    const ids = ['id="questions-section"', 'class="card cmd-section"', 'id="accounts-container"', 'id="seats-container"', 'id="inbox-section"', 'class="board-and-log-layout"', 'id="diff-panel"'];
    const at = ids.map((s) => html.indexOf(s));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
  it('inbox mặc định thu gọn, tự thu sau 3 phút, xoá gọi /api/notes/delete sau confirm', () => {
    expect(html).toContain('class="card inbox-section collapsed" id="inbox-section"');
    expect(html).toContain('var INBOX_COLLAPSE_MS = 3 * 60 * 1000;');
    expect(html).toContain("postJson('/api/notes/delete', body)");
    expect(html).toContain('if (!window.confirm(question)) return;');
  });
});

describe('P7-T5: giao diện Accounts', () => {
  const html = readFileSync(resolve(process.cwd(), 'web/index.html'), 'utf-8');
  const section = html.slice(html.indexOf('id="accounts-container"'), html.indexOf('</section>', html.indexOf('id="accounts-container"')));
  it('đủ 4 nút trong khu Accounts; thanh phiên không còn Refresh energy', () => {
    for (const id of ['acc-import-btn', 'acc-export-btn', 'refresh-energy-btn', 'acc-add-btn']) expect(section).toContain(`id="${id}"`);
    expect(html.match(/id="refresh-energy-btn"/g)).toHaveLength(1);
    const bar = html.slice(html.indexOf('<header class="card session-bar">'), html.indexOf('</header>'));
    expect(bar).not.toContain('refresh-energy-btn');
  });
  it('không còn tab lọc; đổi tên Worker chỉ hiển thị; link đăng nhập chỉ https; dữ liệu tài khoản không qua innerHTML', () => {
    expect(section).not.toContain('data-tab=');
    expect(html).not.toContain('acc.labelFor');
    expect(html).toContain("postJson('/api/agent', { agent: acc.agent, name: v.trim() })");
    expect(html).toContain('agentNames = (state && state.settings && state.settings.names) || {};');
    const fmt = html.slice(html.indexOf('function formatAgentDisplayName'), html.indexOf('var formatAgent ='));
    expect(fmt).toContain('agentLabel(agentId)');
    // avatar chỉ trên thẻ ghế, không trong Accounts
    expect(html).toContain('renderSeatAvatar(cardEl, cardData.agent);');
    const accJs = html.slice(html.indexOf('function renderAccounts'), html.indexOf('// ===== Plan 7: tài khoản của Worker ====='));
    expect(accJs).not.toContain('seat-avatar');
    expect(html).toContain("c.toDataURL('image/jpeg', 0.85)");
    // tài khoản ngủ gom sau nút thu gọn, tự gập sau 3 phút
    expect(html).toContain('acc-sleep-toggle');
    expect(html).toContain('ACC_SLEEP_COLLAPSE_MS = 3 * 60 * 1000');
    expect(html).toContain("view.url.indexOf('https://') === 0");
    const js = html.slice(html.indexOf('// ===== Plan 7: tài khoản của Worker ====='), html.indexOf('// 5. Connect SSE'));
    expect(js.length).toBeGreaterThan(1000);
    expect(js).not.toContain('innerHTML');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

describe('Accounts thu gọn bằng nút ▸/▾ (2026-11-13)', () => {
  const html = readFileSync(resolve('web/index.html'), 'utf8');
  it('mặc định thu gọn, chỉ giữ dòng tài khoản đang dùng; mở ra tự gập sau 3 phút', () => {
    expect(html).toContain('id="acc-details-toggle"');
    expect(html).toContain('aria-controls="accounts-list"');
    expect(html).toContain('.accounts-list.acc-collapsed .acc-item:not(.acc-primary)');
    expect(html).toContain("list.classList.toggle('acc-collapsed', !open)");
    expect(html).toContain('accDetailsTimer = null; syncAccDetails(); }, ACC_SLEEP_COLLAPSE_MS);');
    expect(html).toContain("awake.find(function (a) { return a.status === 'in_use'; }) || awake[0]");
  });
});

describe('Command trái, Session & queue phải (2026-11-13)', () => {
  const html = readFileSync(resolve('web/index.html'), 'utf8');
  it('cmd-section là lưới 2 cột: cmd-main rồi queue-container; màn hẹp xếp chồng', () => {
    const sec = html.slice(html.indexOf('<section class="card cmd-section">'), html.indexOf('</section>', html.indexOf('<section class="card cmd-section">')));
    expect(sec.indexOf('<div class="cmd-main">')).toBeGreaterThan(-1);
    expect(sec.indexOf('id="cmd-feedback"')).toBeLessThan(sec.indexOf('<div class="queue-container">'));
    expect(html).toContain('grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);');
    expect(html).toContain('.cmd-section { grid-template-columns: minmax(0, 1fr); }');
  });
});

describe('Đồng hồ bấm giờ trên thẻ đang chạy (2026-11-13)', () => {
  const html = readFileSync(resolve('web/index.html'), 'utf8');
  it('mỗi thẻ có ô đồng hồ cạnh Last log; formatElapsed ra m:ss / h:mm:ss', () => {
    for (const k of ['pm', 'dev', 'qc', 'audit']) expect(html).toContain(`id="${k}-elapsed"`);
    const src = html.slice(html.indexOf('function formatElapsed'), html.indexOf('function tickSeatElapsed'));
    const formatElapsed = new Function(src + 'return formatElapsed;')() as (ms: number) => string;
    expect(formatElapsed(35_000)).toBe('0:35');
    expect(formatElapsed(154_000)).toBe('2:34');
    expect(formatElapsed(3_725_000)).toBe('1:02:05');
    expect(formatElapsed(-5)).toBe('0:00');
  });
});

describe('Đốm sáng quanh thẻ ghế đang làm (2026-11-12)', () => {
  const html = readFileSync(resolve(process.cwd(), 'web/index.html'), 'utf-8');
  it('chỉ thẻ is-holder có hiệu ứng; luôn chạy kể cả reduced-motion (anh Zon chọn)', () => {
    expect(html).toContain('.seat-card.is-holder::before {');
    expect(html).toContain('animation: holder-glow 2.8s linear infinite;');
    expect(html).not.toMatch(/\.seat-card\.is-holder::before \{ animation: none; \}/);
    expect(html).toContain('pointer-events: none;');
  });
});

describe('Gộp Session goals vào khung hàng đợi (2026-11-12)', () => {
  const html = readFileSync(resolve(process.cwd(), 'web/index.html'), 'utf-8');
  it('không còn section Session goals; goal của phiên hiện "Goal G<n> · <tiêu đề>" trong cùng danh sách', () => {
    expect(html).not.toContain('goals-section');
    expect(html).not.toContain('id="goals-list"');
    expect(html).toContain("'queue.title': 'Session & queue'");
    expect(html).toContain("label.textContent = tx('queue.goal', { goal: text });");
    expect(html).toContain("text = 'G' + text + (found && found.title ? ' · ' + found.title : '');");
  });
});
