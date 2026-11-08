import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Web Dashboard (web/index.html)', () => {
  const htmlPath = resolve(process.cwd(), 'web/index.html');
  const html = readFileSync(htmlPath, 'utf-8');

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

  it('has radio inputs for recipient with pm as default', () => {
    expect(html).toMatch(/<input[^>]*type=["']radio["'][^>]*value=["']pm["'][^>]*checked/);
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
    it('định nghĩa animation quay và dừng quay khi prefers-reduced-motion: reduce', () => {
      // Có @keyframes quay (hoặc rotate)
      expect(html).toMatch(/@keyframes\s+(quay|rotate|spin)\b/);
      // Animation CSS rotate 0.9s linear infinite
      expect(html).toMatch(/0\.9s\s+linear\s+infinite/);
      // Hỗ trợ @media (prefers-reduced-motion: reduce) -> animation: none
      expect(html).toMatch(/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)[\s\S]*?animation\s*:\s*none/);
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
});
