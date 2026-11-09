import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

describe('Web Dashboard (web/index.html)', () => {
  const htmlPath = resolve(process.cwd(), 'web/index.html');
  const html = readFileSync(htmlPath, 'utf-8');

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

  it('theme toggle uses aria-label, SVG icon, and no emoji', () => {
    expect(html).toContain('aria-label="Chuyển sáng/tối"');
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
      running: 'Đang chạy',
      awaiting_approval: 'Chờ duyệt',
      done: 'Hoàn tất',
      needs_owner: 'Cần anh xem',
      out_of_turns: 'Hết lượt',
      stopped: 'Đã dừng',
      refused: 'Bị từ chối',
      error: 'Lỗi',
      pending: 'Chờ',
      in_dev: 'Đang làm',
      awaiting_qc: 'Chờ test',
      passed: 'Đạt',
      returned: 'Trả về',
      failed: 'Thất bại',
      blocked: 'Bị chặn',
      queued: 'Xếp hàng',
      cancelled: 'Đã hủy',
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
    expect(html).toContain('Mất kết nối, đang thử lại…');
  });

  it('handles state event from SSE', () => {
    expect(html).toContain("'state'");
  });

  it('interacts with API endpoints (/api/stop, /api/approve, /api/command)', () => {
    expect(html).toContain('/api/stop');
    expect(html).toContain('/api/approve');
    expect(html).toContain('/api/command');
  });

  it('renders required layout components and Vietnamese texts', () => {
    expect(html).toContain('Bot Task Manager');
    expect(html).toContain('Dừng khẩn cấp');
    expect(html).toContain('Duyệt thẻ');
    expect(html).toContain('Mục tiêu phiên');
    expect(html).toContain('Energy: —');
    expect(html).toContain('Đăng nhập: —');
    expect(html).toContain('Chờ');
    expect(html).toContain('Đang làm');
    expect(html).toContain('Chờ test');
    expect(html).toContain('Đạt');
    expect(html).toContain('Trả về');
    expect(html).toContain('Nhật ký');
    expect(html).toContain('Gửi lệnh');
    expect(html).toContain('Lệnh cho PM = mở phiên với mục tiêu này; lệnh cho Dev/QC xếp hàng sau lượt đang chạy');
    expect(html).toContain('Hàng đợi');
  });

  it('requires confirmation before stop command', () => {
    expect(html).toContain('confirm(');
  });

  it('has radio inputs for recipient with team (Cả team) as default', () => {
    expect(html).toMatch(/<input[^>]*type=["']radio["'][^>]*value=["']team["'][^>]*checked/);
    expect(html).toMatch(/Cả team/);
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
    const formatAgent = new Function(
      'formatSeatLabel',
      `return ${agentFnMatch![0]};`
    )((s: string) => parsedSeatMap[s.toLowerCase()] || s);

    expect(formatAgent('elon', 'pm')).toBe('Elon-PM');
    expect(formatAgent('jacky', 'dev')).toBe('Jacky-Dev');
    expect(formatAgent('jenny', 'qc')).toBe('Jenny-QC');

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
      expect(sessionBarHtml).toMatch(/<label[^>]*>[\s\S]*?Auto duyệt thẻ[\s\S]*?<\/label>/);
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
      expect(html).toContain('aria-label="Đang chạy"');
      expect(html).toContain('role="img"');
      expect(html).toContain('18px');
      expect(html).toContain('currentColor');

      // Các thẻ ghế (pm, dev, qc) đều có icon vòng xoay đặt cạnh tên agent
      const pmCardMatch = html.match(/id=["']seat-card-pm["'][\s\S]*?(?=id=["']seat-card-dev["'])/);
      expect(pmCardMatch).not.toBeNull();
      const pmHtml = pmCardMatch![0];
      expect(pmHtml).toContain('id="pm-title">Elon-PM');
      expect(pmHtml).toMatch(/<svg[^>]*\bid=["']pm-spinner["'][^>]*role=["']img["'][^>]*aria-label=["']Đang chạy["']/);

      const devCardMatch = html.match(/id=["']seat-card-dev["'][\s\S]*?(?=id=["']seat-card-qc["'])/);
      expect(devCardMatch).not.toBeNull();
      const devHtml = devCardMatch![0];
      expect(devHtml).toContain('id="dev-title">Jacky-Dev');
      expect(devHtml).toMatch(/<svg[^>]*\bid=["']dev-spinner["'][^>]*role=["']img["'][^>]*aria-label=["']Đang chạy["']/);

      const qcCardMatch = html.match(/id=["']seat-card-qc["'][\s\S]*?(?=<\/section>)/);
      expect(qcCardMatch).not.toBeNull();
      const qcHtml = qcCardMatch![0];
      expect(qcHtml).toContain('id="qc-title">Jenny-QC');
      expect(qcHtml).toMatch(/<svg[^>]*\bid=["']qc-spinner["'][^>]*role=["']img["'][^>]*aria-label=["']Đang chạy["']/);
    });

    it('chip Đang giữ lượt trên thanh trên dùng cùng icon vòng xoay thay chấm nhấp nháy', () => {
      const holderBoxMatch = html.match(/<span[^>]*id=["']holder-box["'][^>]*>([\s\S]*?)<\/span>/);
      expect(holderBoxMatch).not.toBeNull();
      const holderBoxHtml = holderBoxMatch![0];

      // Dùng SVG inline thay cho blink-dot
      expect(holderBoxHtml).not.toContain('blink-dot');
      expect(holderBoxHtml).toMatch(/<svg[^>]*role=["']img["'][^>]*aria-label=["']Đang chạy["']/);
      expect(holderBoxHtml).toContain('currentColor');
    });

    it('không còn chuỗi hiển thị "Đang chạy" dạng chip; nhãn Chờ/Rảnh giữ dạng chip xám nhỏ', () => {
      // HTML tĩnh không có chip nào hiển thị chữ 'Đang chạy'
      expect(html).not.toMatch(/<span[^>]*class=["'][^"']*seat-status-badge[^"']*["'][^>]*>\s*Đang chạy\s*<\/span>/);

      // Nhãn Chờ / Rảnh giữ dạng chip xám nhỏ trong CSS
      expect(html).toMatch(/\.status-waiting\b/);
      expect(html).toMatch(/\.status-idle\b/);

      // Trong renderSeat: khi status === 'running', không gán text 'Đang chạy' vào statusBadge dạng chip
      expect(html).not.toMatch(/statusBadge\.textContent\s*=\s*['"]Đang chạy['"]/);
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
      expect(approveBtnHtml).toContain('title="Không có thẻ chờ duyệt"');

      // 2. Kiểm tra logic trong renderSnapshot không ẩn nút mà chuyển disabled/title
      expect(html).not.toMatch(/setDisplay\s*\(\s*approveBtn\s*,\s*state\.session\.status\s*===\s*['"]awaiting_approval['"]/);
      expect(html).toMatch(/approveBtn\.disabled\s*=/);
      expect(html).toMatch(/Không có thẻ chờ duyệt/);
    });

    it('có khu vực Hộp thư team hiển thị note, ảnh qua /api/notes/<id>/image và báo cáo ngắn', () => {
      // 1. Tiêu đề Hộp thư team
      expect(html).toContain('Hộp thư team');
      expect(html).toContain('id="notes-list"');

      // 2. Logic renderNotes hiển thị trạng thái Mở / Xong, ảnh alt="Ảnh đính kèm N-<id>" và endpoint /api/notes/
      expect(html).toMatch(/\/api\/notes\//);
      expect(html).toMatch(/Ảnh đính kèm N-/);
      expect(html).toMatch(/['"]Mở['"]/);
      expect(html).toMatch(/['"]Xong['"]/);
    });

    it('người nhận có Cả team mặc định và sinh từ snapshot.seats', () => {
      // Có input radio Cả team mặc định
      expect(html).toMatch(/<input[^>]*type=["']radio["'][^>]*value=["']team["'][^>]*checked/);
      expect(html).toMatch(/Cả team/);

      // Render danh sách người nhận từ snapshot.seats
      expect(html).toMatch(/state\.seats/);
      expect(html).toMatch(/cmd-to/);
    });

    it('hỗ trợ đính kèm ảnh khi chọn Cả team với input file accept png/jpeg/webp và dán ảnh Ctrl+V', () => {
      // Input file với accept đúng và label có text Đính kèm ảnh
      expect(html).toMatch(/<input[^>]*type=["']file["'][^>]*accept=["'][^"']*image\/png[^"']*image\/jpeg[^"']*image\/webp[^"']*["']/);
      expect(html).toMatch(/<label[^>]*for=["'][^"']*["'][^>]*>[\s\S]*?Đính kèm ảnh[\s\S]*?<\/label>/);

      // Khung xem trước thumbnail và nút Bỏ ảnh
      expect(html).toContain('Bỏ ảnh');
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

  describe('P2-T11: Bảng task dạng tab thẻ hồ sơ', () => {
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

    it('có cấu trúc ARIA tablist/tab/tabpanel và đầy đủ 5 tab kèm số đếm', () => {
      // 1. role="tablist" và role="tabpanel"
      expect(html).toContain('role="tablist"');
      expect(html).toContain('role="tabpanel"');

      // 2. 5 tabs với role="tab", aria-selected, aria-controls
      const tabMatches = [...html.matchAll(/role=["']tab["'][^>]*>/g)];
      expect(tabMatches.length).toBeGreaterThanOrEqual(5);
      expect(html).toContain('aria-selected');
      expect(html).toContain('aria-controls');

      // 3. 5 nhãn tab và 5 ID số đếm
      expect(html).toContain('Chờ');
      expect(html).toContain('Đang làm');
      expect(html).toContain('Chờ test');
      expect(html).toContain('Đạt');
      expect(html).toContain('Trả về');

      expect(html).toContain('id="count-pending"');
      expect(html).toContain('id="count-in_dev"');
      expect(html).toContain('id="count-awaiting_qc"');
      expect(html).toContain('id="count-passed"');
      expect(html).toContain('id="count-returned"');
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
      expect(html).toMatch(/\[role=["']tablist["']\]|\.task-tabs[^{]*\{[^}]*overflow-x:\s*auto/);
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

      // B.1: Số đếm trên tab active ở theme sáng tương phản >= 4.5:1, không dùng nền pha alpha (dùng màu đặc)
      const activeCountMatch = html.match(/\.task-tab\[aria-selected=["']true["']\]\s+\.task-tab-count\s*\{([^}]+)\}/);
      expect(activeCountMatch).not.toBeNull();
      const activeCountCss = activeCountMatch![1];
      expect(activeCountCss).not.toMatch(/rgba|hsla/i);
      // Nền #1e3f99, chữ #ffffff -> tương phản >= 4.5:1
      const lightActiveCountContrast = getContrastRatio('#FFFFFF', '#1E3F99');
      expect(lightActiveCountContrast).toBeGreaterThanOrEqual(4.5);
    });

    it('panel bên dưới là bảng chữ ID · Mục tiêu · Vòng sửa · Cập nhật, mục tiêu xuống dòng, trống ghi "Không có thẻ"', () => {
      // 1. Tiêu đề bảng: ID, Mục tiêu, Vòng sửa, Cập nhật
      expect(html).toMatch(/<th[^>]*>ID<\/th>/);
      expect(html).toMatch(/<th[^>]*>Mục tiêu<\/th>/);
      expect(html).toMatch(/<th[^>]*>Vòng sửa<\/th>/);
      expect(html).toMatch(/<th[^>]*>Cập nhật<\/th>/);

      // 2. Mục tiêu dài thì xuống dòng (word-break và white-space: normal, bỏ nowrap ở cột Mục tiêu)
      expect(html).toMatch(/(word-break:\s*break-word|overflow-wrap:\s*break-word)/);
      expect(html).toMatch(/white-space:\s*normal/);
      expect(html).not.toMatch(/\.col-goal[^{]*\{[^}]*white-space:\s*nowrap/);

      // 3. Trống ghi "Không có thẻ"
      expect(html).toContain('Không có thẻ');

      // 4. B.2: table-layout fixed + word-break, các cột khác ngắn để không bao giờ làm trang cuộn ngang ở 375px
      expect(html).toMatch(/\.task-table\s*\{[^}]*table-layout:\s*fixed/);
      expect(html).toMatch(/\.task-table\s*\{[^}]*(word-break:\s*break-word|overflow-wrap:\s*break-word)/);
      expect(html).toMatch(/\.col-id\s*\{[^}]*width:\s*(5[0-9]|6[0-5]|7[0-5])px/);
      expect(html).toMatch(/\.col-fixes\s*\{[^}]*width:\s*(5[0-9]|6[0-5]|7[0-9]|8[0-5])px/);
      expect(html).toMatch(/\.col-updated\s*\{[^}]*width:\s*(6[0-9]|7[0-5]|9[0-6])px/);
    });

    it('mặc định tab active theo thẻ đang chạy, fallback tab đầu tiên có thẻ, giữ lựa chọn người dùng cho đến khi trạng thái thay đổi', () => {
      // Trích xuất hàm resolveActiveTab hoặc computeActiveTab
      const tabFnMatch = html.match(/function\s+(resolveActiveTab|computeActiveTab|getActiveTab)\s*\([^)]*\)\s*\{[\s\S]*?(?=\n\s*function\s+updateTabUI)/);
      expect(tabFnMatch).not.toBeNull();
      const fnCode = tabFnMatch![0];

      // Hàm trích xuất vân tay hoặc kiểm tra thay đổi trạng thái thẻ
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

    it('hỗ trợ điều hướng phím ← → đổi tab với vòng lặp tuần hoàn', () => {
      // Phím ArrowLeft và ArrowRight được lắng nghe
      expect(html).toMatch(/ArrowRight|ArrowLeft/);
      expect(html).toMatch(/addEventListener\s*\(\s*['"]keydown['"]/);

      const keyFnMatch = html.match(/function\s+handleTabKeydown\s*\([^)]*\)\s*\{[\s\S]*?(?=\n\s*if\s*\(taskTablist\))/);
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
        handleTabKeydown(e);
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

    it('renderTaskTable hiển thị đúng các cột ID, Mục tiêu, Vòng sửa, Cập nhật và trạng thái trống "Không có thẻ"', () => {
      const renderFnMatch = html.match(/function\s+renderTaskTable\s*\([^)]*\)\s*\{[\s\S]*?(?=\n\s*function\s+selectTab)/);
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
        createElement: (tag: string) => {
          return {
            tagName: tag,
            className: '',
            textContent: '',
            children: [] as any[],
            appendChild(child: any) {
              this.children.push(child);
            },
          };
        },
      };

      const runRender = new Function(
        'document',
        'taskTableBody',
        'clearChildren',
        'formatTime',
        'tasks',
        'activeKey',
        `
        ${fnCode}
        renderTaskTable(tasks, activeKey);
        `
      );

      // 1. Khi tab rỗng -> hiển thị "Không có thẻ"
      runRender(mockDocument, mockTbody, () => {}, (t: string) => t, [], 'pending');
      expect(createdRows.length).toBe(1);
      const emptyRow = createdRows[0];
      expect(emptyRow.children[0].textContent).toBe('Không có thẻ');
      expect(emptyRow.children[0].className).toContain('empty-placeholder');

      // 2. Khi tab có thẻ -> hiển thị đủ các cột
      createdRows.length = 0;
      const testTasks = [
        { id: 'T-001', goal: 'Xây dựng giao diện tab cho bảng task', state: 'in_dev', fixRounds: 2, updatedAt: '2026-11-08T13:00:00Z' },
        { id: 'T-002', goal: 'Task khác', state: 'pending', fixRounds: 0 },
      ];
      runRender(mockDocument, mockTbody, () => {}, (t: string) => t.slice(11, 19), testTasks, 'in_dev');
      expect(createdRows.length).toBe(1);
      const row = createdRows[0];
      expect(row.children[0].textContent).toBe('T-001');
      expect(row.children[1].textContent).toBe('Xây dựng giao diện tab cho bảng task');
      expect(row.children[2].textContent).toBe('2');
      expect(row.children[3].textContent).toBe('13:00:00');
    });
  });

  describe('P2-T12: Khung Bảng task cao bằng cả hàng và panel min-height 360px', () => {
    it('hàng chứa 2 khung dùng align-items: stretch', () => {
      const layoutMatch = html.match(/\.board-and-log-layout\s*\{([^}]+)\}/);
      expect(layoutMatch).not.toBeNull();
      const css = layoutMatch![1];
      expect(css).toMatch(/align-items:\s*stretch/);
      expect(css).not.toMatch(/align-items:\s*start/);
    });

    it('khung Bảng task là flex column', () => {
      const taskBoardMatch = html.match(/\.task-board-section\s*\{([^}]+)\}/);
      expect(taskBoardMatch).not.toBeNull();
      const css = taskBoardMatch![1];
      expect(css).toMatch(/display:\s*flex/);
      expect(css).toMatch(/flex-direction:\s*column/);
    });

    it('panel bên dưới tab có flex: 1 và min-height 360px để luôn kéo dài xuống đáy khung', () => {
      const panelMatch = html.match(/\.task-tabpanel\s*\{([^}]+)\}/);
      expect(panelMatch).not.toBeNull();
      const css = panelMatch![1];
      expect(css).toMatch(/flex:\s*1(\s+1\s+(0|0%|auto))?/);
      expect(css).toMatch(/min-height:\s*360px/);
    });

    it('khi xếp dọc ở màn hẹp vẫn giữ min-height 360px', () => {
      expect(html).not.toMatch(/@media[^{]*\{[^}]*\.task-tabpanel\s*\{[^}]*min-height:\s*(0|none|[1-2][0-9]{2}px|3[0-5][0-9]px)/);
    });

    it('bảng trong panel giữ nguyên và dòng Không có thẻ nằm trên cùng panel', () => {
      const panelHtmlMatch = html.match(/<div[^>]*id=["']task-tabpanel["'][^>]*>([\s\S]*?)<\/div>/);
      expect(panelHtmlMatch).not.toBeNull();
      const panelInner = panelHtmlMatch![1];
      expect(panelInner).toContain('class="task-table"');
      expect(panelInner).toMatch(/<tbody[^>]*id=["']task-table-body["'][^>]*>[\s\S]*?Không có thẻ[\s\S]*?<\/tbody>/);

      const tdMatch = html.match(/\.task-table\s+td\s*\{([^}]+)\}/);
      expect(tdMatch).not.toBeNull();
      expect(tdMatch![1]).toMatch(/vertical-align:\s*top/);

      const tableMatch = html.match(/\.task-table\s*\{([^}]+)\}/);
      expect(tableMatch).not.toBeNull();
      expect(tableMatch![1]).not.toMatch(/height:\s*(100%|inherit)/);

      expect(html).toMatch(/td\.textContent\s*=\s*['"]Không có thẻ['"]/);
    });
  });

  describe('P2-T13: Mỗi tab một màu theo trạng thái và căn chỉnh độ rộng cột bảng task', () => {
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

    it('cả 5 tab đều mang thuộc tính data-state tương ứng với trạng thái', () => {
      expect(html).toMatch(/<button[^>]*id=["']tab-pending["'][^>]*data-state=["']pending["']/);
      expect(html).toMatch(/<button[^>]*id=["']tab-in_dev["'][^>]*data-state=["']in_dev["']/);
      expect(html).toMatch(/<button[^>]*id=["']tab-awaiting_qc["'][^>]*data-state=["']awaiting_qc["']/);
      expect(html).toMatch(/<button[^>]*id=["']tab-passed["'][^>]*data-state=["']passed["']/);
      expect(html).toMatch(/<button[^>]*id=["']tab-returned["'][^>]*data-state=["']returned["']/);
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

      // 3. updateTabUI cập nhật data-active-state hoặc màu viền nối
      expect(html).toMatch(/data-active-state|borderBottomColor|--tab-active/);
    });

    it('bảng trong panel: table width 100%, table-layout fixed, có colgroup và đặt đúng độ rộng các cột', () => {
      // 1. Bảng có <colgroup> và 4 <col>
      expect(html).toMatch(/<colgroup>[\s\S]*?<col[\s\S]*?<\/colgroup>/);

      // 2. table width 100% và table-layout fixed
      expect(html).toMatch(/\.task-table\s*\{[^}]*width:\s*100%/);
      expect(html).toMatch(/\.task-table\s*\{[^}]*table-layout:\s*fixed/);

      // 3. Đặt độ rộng cột ID ~72px, Vòng sửa ~80px, Cập nhật ~96px, Mục tiêu phần còn lại
      expect(html).toMatch(/(\.col-id|col\.col-id|style=["'][^"']*width:\s*72px)[^{;]*\{?[^}]*width:\s*72px/);
      expect(html).toMatch(/(\.col-fixes|col\.col-fixes|style=["'][^"']*width:\s*80px)[^{;]*\{?[^}]*width:\s*80px/);
      expect(html).toMatch(/(\.col-updated|col\.col-updated|style=["'][^"']*width:\s*96px)[^{;]*\{?[^}]*width:\s*96px/);

      // 4. Cột Mục tiêu tự co giãn phần còn lại (width auto hoặc word-break)
      expect(html).toMatch(/\.col-goal\s*\{[^}]*(width:\s*auto|word-break:\s*break-word|overflow-wrap:\s*break-word)/);

      // 5. Không tràn khung ở mobile 375px: không có min-width lớn hơn 320px trên bảng/panel
      expect(html).not.toMatch(/\.task-table\s*\{[^}]*min-width:\s*(3[3-9][0-9]|[4-9][0-9]{2})/);
    });
  });

  describe('P3-T4: Energy, đèn đăng nhập và trang Tài khoản', () => {
    it('thanh trên có nút "Làm mới Energy"', () => {
      expect(html).toContain('id="refresh-energy-btn"');
      expect(html).toMatch(/Làm mới Energy/);
    });

    it('thẻ ghế hỗ trợ thanh energy với role="meter" và aria-valuenow', () => {
      expect(html).toContain('role="meter"');
      expect(html).toContain('aria-valuenow');
    });

    it('có khu Tài khoản ở cuối trang với danh sách agent và nút Sao chép có aria-label', () => {
      expect(html).toContain('id="accounts-container"');
      expect(html).toMatch(/aria-label=["']Sao chép/);
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
      expect(formatEnergy({ remainingPercent: 19.9 })).toBe('còn 20%');
      expect(formatEnergy({ remainingPercent: 49.9 })).toBe('còn 50%');
      expect(formatEnergy({ remainingPercent: 50 })).toBe('còn 50%');
      expect(formatEnergy({ remainingPercent: 49.9, resetsAt: '2026-11-09T13:45:00Z' })).toBe('còn 50% · hồi 13:45');
      expect(formatEnergy(null)).toBe('');
    });

    it('nút Sao chép có nhánh navigator.clipboard và fallback bôi đen + execCommand kèm phản hồi', async () => {
      const match = html.match(/async\s+function\s+copyLoginCommand\s*\([^)]*\)\s*\{[\s\S]*?\n\s{6}\}/);
      expect(match).not.toBeNull();

      // Kiểm tra trong HTML có dùng input/textarea readonly cho ô mã và gọi select() + execCommand
      expect(html).toMatch(/<input[^>]*readonly[^>]*account-cmd-code|document\.createElement\(['"]input['"]\)[\s\S]*?readOnly\s*=\s*true/);
      expect(html).toMatch(/\.select\s*\(\s*\)/);
      expect(html).toMatch(/execCommand\s*\(\s*['"]copy['"]\s*\)/);
      expect(html).toContain('Đã sao chép');
      expect(html).toContain('Hãy bôi đen và Ctrl+C');

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
        expect(feedback).toBe('Đã sao chép');
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
        expect(feedback).toBe('Đã sao chép');
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
        expect(feedback).toBe('Hãy bôi đen và Ctrl+C');
      }
    });
  });

});
