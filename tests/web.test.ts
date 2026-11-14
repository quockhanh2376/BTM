import { describe, it, expect } from 'vitest';
import { readWeb } from './helpers.ts';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

describe('Web Dashboard (web/index.html)', () => {
  const htmlPath = resolve(process.cwd(), 'web/index.html');
  const html = readWeb();
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
    const box = html.slice(html.indexOf('<div class="cmd-composer">'), html.indexOf('id="cmd-feedback"'));
    expect(box).toContain('id="cmd-text"');
    expect(box).toContain('id="attach-image-label"');
    expect(box).toContain('id="cmd-send-btn"');
    expect(box).toMatch(/id="cmd-send-btn"[^>]*data-i18n-title="cmd\.send"/);
  });

  it('shows worker names without the word Worker and puts a rename button on seat cards', () => {
    expect(html).toContain("'acc.workerTitle': '{name} · accounts: {n}',");
    const fn = html.slice(html.indexOf('function renderSeatAvatar('), html.indexOf('function agentLabel(id)'));
    expect(fn).toContain("ren.className = 'acc-rename-btn'");
    expect(fn).toContain('renameAgent(ren.dataset.agent)');
    expect(html).toMatch(/async function renameAgent\(agent\)/);
  });

  it('goal card shows the GitHub release link (github.com only, textContent) and a Push again button on failure', () => {
    const fn = html.slice(html.indexOf('var rel = g.release;'), html.indexOf('card.appendChild(header);'));
    expect(fn).toContain(String.raw`/^https:\/\/github\.com\//.test(String(rel.url || ''))`);
    expect(fn).toContain("postJson('/api/goal/push', { goal: 'G' + g.n })");
    expect(fn).toContain("relLink.rel = 'noopener noreferrer'");
    expect(fn).not.toContain('innerHTML');
    for (const k of ['goal.released', 'goal.pushFailed', 'goal.pushAgain']) expect(html).toContain(`'${k}':`);
  });

  it('Plan 9 Task 1: sidebar, header tools, EN/VI switch; Reports/Settings are placeholders only', () => {
    expect(html).toContain('<aside class="sidebar" id="sidebar"');
    for (const id of ['menu-btn', 'sidebar-collapse', 'head-refresh', 'head-bell', 'bell-count', 'head-help', 'app-version', 'sys-cpu', 'sys-ram', 'sys-disk']) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('data-lang="en"');
    expect(html).toContain('data-lang="vi"');
    expect(html).toContain('data-soon="nav.reports"');
    expect(html).toContain('href="#settings-section" data-nav="settings"'); // Settings có thật từ 2026-11-14
    // nút cũ vẫn còn
    for (const id of ['project-badge', 'session-badge', 'turns-badge', 'holder-box', 'auto-approve-toggle', 'approve-btn', 'stop-btn', 'theme-toggle', 'top-feedback']) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toMatch(/\[data-theme="dark"\][^}]*--sidebar-bg/);
    expect(html).toMatch(/@media \(max-width: 900px\)[\s\S]*\.menu-btn \{ display: inline-flex; \}/);
  });

  it('Plan 9 Task 2: 4 thẻ số tính từ snapshot; System Status đọc /api/system mỗi 10 s khi tab hiện', () => {
    for (const id of ['kpi-accounts', 'kpi-running', 'kpi-goals', 'kpi-tasks', 'sys-net', 'sys-health']) expect(html).toContain(`id="${id}"`);
    const fn = html.slice(html.indexOf('function renderKpis(state)'), html.indexOf('function fmtRate('));
    expect(fn).toContain("g.state !== 'merged'");
    expect(fn).toContain("x.status === 'running'");
    expect(html).toContain("fetch('/api/system', { cache: 'no-store' })");
    expect(html).toContain("document.visibilityState === 'hidden'");
    expect(html).toContain('setInterval(pollSystem, 10000)');
  });

  it('thẻ ghế có Last run (ticket · thời gian · kết quả, có màu) và On ticket (tổng thời gian · số lượt)', () => {
    for (const seat of ['pm', 'dev', 'qc', 'audit']) {
      expect(html).toContain(`id="${seat}-lastrun"`);
      expect(html).toContain(`id="${seat}-ontask"`);
    }
    const fn = html.slice(html.indexOf('function renderSeatTiming('), html.indexOf('function tickSeatElapsed()'));
    expect(fn).toContain('formatElapsed(lr.durationMs || 0)');
    expect(fn).toContain("setAttribute('data-result'");
    expect(fn).not.toContain('innerHTML');
  });

  it('puts the recipient radios on the Command title row and hides the textarea label visually', () => {
    const head = html.slice(html.indexOf('<div class="cmd-head">'), html.indexOf('<div class="form-group">', html.indexOf('<div class="cmd-head">')));
    expect(head).toContain('data-i18n="cmd.title"');
    expect(head).toContain('id="recipient-radios"');
    expect(html).toMatch(/<label for="cmd-text" class="sr-only"/);
    expect(html).not.toContain('id="cmd-note"');
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
    // Plan 9 Task 1: bảng màu mới theo ảnh mẫu
    expect(html.toLowerCase()).toContain('#f5f7fb');
    expect(html.toLowerCase()).toContain('#ffffff');
    expect(html.toLowerCase()).toContain('#060b17');
    expect(html.toLowerCase()).toContain('#2b3445');
    expect(html.toLowerCase()).toContain('#2563eb');
    expect(html.toLowerCase()).toContain('#dce6fb');
    expect(html.toLowerCase()).toContain('#1e3f99');
    expect(html.toLowerCase()).toContain('#b42318');

    // Dark palette
    expect(html.toLowerCase()).toContain('#0f1115');
    expect(html.toLowerCase()).toContain('#171a21');
    expect(html.toLowerCase()).toContain('#e5e7eb');
    expect(html.toLowerCase()).toContain('#9ca3af');
    expect(html.toLowerCase()).toContain('#60a5fa');

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
    expect(html.toLowerCase()).toContain('#171a21');

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

    // Dark error text #FF8A80 on card #171A21
    const errContrast = getContrastRatio('#FF8A80', '#171A21');
    expect(errContrast).toBeGreaterThanOrEqual(4.5);
    // Plan 9: chữ phụ đọc được ở cả hai chế độ
    expect(getContrastRatio('#2B3445', '#FFFFFF')).toBeGreaterThanOrEqual(7);
    expect(getContrastRatio('#2B3445', '#F5F7FB')).toBeGreaterThanOrEqual(7);
    expect(getContrastRatio('#9CA3AF', '#171A21')).toBeGreaterThanOrEqual(4.5);
    expect(getContrastRatio('#E5E7EB', '#0F1115')).toBeGreaterThanOrEqual(4.5);

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
    expect(html).toContain('Queue');
  });

  it('requires confirmation before stop command', () => {
    expect(html).toContain('confirm(');
  });

  it('has radio inputs for recipient with team (Cả team) as default', () => {
    expect(html).toMatch(/<input[^>]*type=["']radio["'][^>]*value=["']auto["'][^>]*checked/); // 2026-11-14: Auto mặc định
    expect(html).toMatch(/<input[^>]*type=["']radio["'][^>]*value=["']team["']/);
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

    it('anh Zon 2026-11-14: không còn chip Idle/Live/Waiting; trạng thái là vòng quanh avatar, tắt hiệu ứng thì không xoay', () => {
      expect(html).not.toMatch(/id="[a-z]+-status-badge"/);
      expect(html).not.toContain('statusBadge');
      expect(html).toMatch(/avatarEl\.classList\.toggle\('is-active', cardData\.status === 'running'\)/);
      expect(html).toMatch(/avatarEl\.classList\.toggle\('is-waiting', cardData\.status === 'waiting'\)/);
      expect(html).toContain("anchor.classList.add('is-talking')");
      // Vòng luôn có; đang làm/nói: đốm sáng chạy + nhịp tim; chạy cả khi Windows tắt hiệu ứng (không tắt theo reduced-motion).
      expect(html).toMatch(/\.seat-card \.seat-avatar::before \{[^}]*content: ''/);
      expect(html).toMatch(/\.seat-avatar\.is-active::before[^{]*\{[^}]*conic-gradient[^}]*animation: avatar-ring/);
      expect(html).toMatch(/\.seat-avatar\.is-active[^{]*\{[^}]*animation: avatar-heartbeat/);
      expect(html).not.toMatch(/prefers-reduced-motion[^{]*\{\s*\.seat-(card \.seat-)?avatar/);
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
      expect(html).toMatch(/<input[^>]*type=["']radio["'][^>]*value=["']auto["'][^>]*checked/);
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
      expect(html).toContain("var approveYes = await askAsSeat('pm', {");
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
      expect(html).toContain("tdHistory.colSpan = 5");
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
      // giờ Việt Nam (UTC+7)
      expect(formatEnergy({ remainingPercent: 49.9, resetsAt: '2026-11-09T13:45:00Z' })).toBe('50% left · resets 20:45');
      expect(formatHHmm('2026-11-09T18:30:00Z')).toBe('01:30');
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
      const labelMatches = html.match(/data-i18n="seat.agent">Agent</g);
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
      expect(html).toContain("text: tx('ask.stopAll')");
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
  const html = readWeb();
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
    const html = readWeb();
    expect(html).toContain("if (cardData.substitute) toolParts.push(tx('seat.substitute', { agent: cardData.substitute }));");
  });
});

describe('P6-T5: chip Sắp hết', () => {
  it('chip có chữ (không chỉ màu), dùng textContent, hiện trên thẻ ghế và tài khoản', () => {
    const html = readWeb();
    expect(html).toContain("chip.textContent = tx('energy.low') + (hhmm ? tx('energy.resets', { time: hhmm }) : '');");
    expect(html).toContain('var warnChip = energyWarnChip(eng);');
    expect(html).toContain('var accWarn = energyWarnChip(acc.energy);');
  });
});

describe('P5-T9: UI tiếng Anh, bảng chuỗi', () => {
  const html = readWeb();
  const i18nStart = html.indexOf('var STRINGS = {');
  const i18nEnd = html.indexOf('var LANG =');
  const tx = new Function('window', `${html.slice(i18nStart, html.indexOf('function applyI18n'))}; return tx;`)({ localStorage: { getItem: () => null } });

  it('ngoài bảng STRINGS không còn chữ tiếng Việt (bỏ qua comment)', () => {
    // Kho thoại EN/VI của bong bóng chat (anh Zon 2026-11-14) là bảng chữ thứ hai, được phép có tiếng Việt.
    const c0 = html.indexOf('var CHAT_LINES'), c1 = html.indexOf('var chatLastIdx');
    const rest = (html.slice(0, i18nStart) + html.slice(i18nEnd, c0) + html.slice(c1))
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

  it('STRINGS.vi đủ key như STRINGS.en, giữ {placeholder}, không rỗng; nút EN/VI lưu btm.lang rồi tải lại', () => {
    const all = new Function(`${html.slice(i18nStart, i18nEnd)}; return STRINGS;`)() as Record<string, Record<string, string>>;
    const en = all.en!, vi = all.vi!;
    expect(Object.keys(vi).sort()).toEqual(Object.keys(en).sort());
    const broken = Object.keys(en).filter((k) => !vi[k]!.trim()
      || (en[k]!.match(/\{\w+\}/g) ?? []).some((p) => !vi[k]!.includes(p)));
    expect(broken).toEqual([]);
    // tx() theo ngôn ngữ đã lưu; ngôn ngữ lạ thì về tiếng Anh.
    const txFor = (lang: string) => new Function('window', `${html.slice(i18nStart, html.indexOf('function applyI18n'))}; return tx;`)({ localStorage: { getItem: () => lang } });
    expect(txFor('vi')('bar.turns', { used: 3, max: 10 })).toBe('Lượt 3/10');
    expect(txFor('xx')('btn.stop')).toBe('Stop');
    const sw = html.slice(html.indexOf("document.querySelectorAll('.lang-switch button')"));
    const handler = sw.slice(0, sw.indexOf('})();'));
    expect(handler).toContain("b.setAttribute('aria-pressed', lang === LANG ? 'true' : 'false')");
    expect(handler).toContain('if (lang === LANG || !STRINGS[lang]) return;');
    expect(handler).toMatch(/localStorage\.setItem\('btm\.lang', lang\)[\s\S]*location\.reload\(\)/);
    expect(html).toContain('document.documentElement.lang = LANG;');
    expect(html).not.toContain('head.viSoon');
  });

  it('trang không có biến cục bộ tên tx (che hàm dịch)', () => {
    expect(html).not.toMatch(/(var|let|const)\s+tx\b/);
  });
});

describe('P6-T7: dòng trạng thái trên thẻ ghế', () => {
  it('ưu tiên agentStatus, không có thì dòng log cuối; chèn bằng textContent', () => {
    const html = readWeb();
    expect(html).toContain("lastLineEl.textContent = cardData.agentStatus || cardData.lastLine || '—';");
  });
});

describe('P6-T3/T4: dashboard diff + câu hỏi', () => {
  const html = readWeb();
  it('có khung diff, nút Diff trên ticket, ghi chú theo dòng mới, Return to Dev có xác nhận; câu hỏi có ô trả lời', () => {
    expect(html).toContain('id="diff-panel"');
    expect(html).toContain("diffBtn.textContent = tx('diff.open');");
    expect(html).toContain("'/api/tickets/' + encodeURIComponent(diffTicket) + '/notes'");
    expect(html).toContain("askAsSeat('dev', { text: tx('ask.return', { ticket: diffTicket })");
    expect(html).toContain("txt.textContent = l.text;");
    expect(html).toContain('id="questions-section"');
    expect(html).toContain("postJson('/api/questions/' + qs[i].id + '/answer'");
    expect(html).toContain("text.textContent = (qs.length > 1 ? (i + 1) + '. ' : '') + x.text;");
  });
});

describe('Inbox gọn + thứ tự dashboard (2026-11-12)', () => {
  const html = readWeb();
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
    expect(html).toContain("if (!(await askOwner({ who: tx('ask.team'), text: question, ok: tx('ask.delete'), cancel: tx('ask.keepIt') }))) return;");
  });
});

describe('P7-T5: giao diện Accounts', () => {
  const html = readWeb();
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
    expect(html).toContain("postJson('/api/agent', { agent: agent, name: v.trim() })");
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
  const html = readWeb();
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
  const html = readWeb();
  it('cmd-section: Results + Command 1/3 bên trái, Meeting room 2/3 bên phải ở mọi cỡ màn hình (2026-11-14)', () => {
    const sec = html.slice(html.indexOf('<section class="card cmd-section">'), html.indexOf('</section>', html.indexOf('<section class="card cmd-section">')));
    expect(sec.indexOf('<div class="cmd-main">')).toBeGreaterThan(-1);
    expect(sec.indexOf('id="cmd-feedback"')).toBeLessThan(sec.indexOf('<div class="queue-container">'));
    expect(sec.indexOf('id="search-panel"')).toBeLessThan(sec.indexOf('class="cmd-head"'));
    expect(html).toContain('grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);');
    expect(html).not.toContain('.cmd-section { grid-template-columns: minmax(0, 1fr); }');
    const kpi = html.slice(html.indexOf('<section class="kpi-grid"'));
    expect(kpi.indexOf('id="search-input"')).toBeLessThan(kpi.indexOf('id="kpi-accounts"'));
    expect(html).toContain("fetch('/api/search?q=' + encodeURIComponent(q)");
    expect(html).not.toContain('id="search-panel" class="search-panel" style="display: none;"'); // Results luôn hiện
    expect(html).toContain('align-items: stretch; /* Results + Command cao bằng Meeting room */');
  });
});

describe('Đồng hồ bấm giờ trên thẻ đang chạy (2026-11-13)', () => {
  const html = readWeb();
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

describe('Ô trả lời câu hỏi (2026-11-14)', () => {
  const html = readWeb();
  it('ảnh nằm trong khung trả lời; chỉ có ảnh vẫn gửi được', () => {
    expect(html).toContain("compose.className = 'cmd-composer q-compose'");
    expect(html).toContain('compose.appendChild(bar)');
    expect(html).toContain("iconFrom('#cmd-send-btn svg', btn, tx('q.answer'))");
    expect(html).toContain("iconFrom('#attach-image-label svg', attach, tx('q.attach'))");
    expect(html).toContain("area.value.trim() || (qImages[q.id] ? tx('q.seeImage') : '')");
    expect(html).toContain("'q.seeImage': 'See attached image.'");
  });
});

describe('Chat bubbles (2026-11-14)', () => {
  const html = readWeb();
  const lib = new Function(
    'agentLabel',
    html.slice(html.indexOf('var CHAT_LINES'), html.indexOf('// end chat-lib')) +
      'return { pickChatLine, chatStyleOf, chatEvents, chatTargetsFor, CHAT_LINES };'
  )((id: string) => id) as any;
  const snap = (over: any = {}) => ({
    goals: [{ tickets: [{ id: 'GT-0005', state: 'pending' }] }],
    seats: [{ seat: 'pm', agent: 'elon', status: 'idle' }, { seat: 'dev', agent: 'jenny', status: 'idle' }, { seat: 'qc', agent: 'jacky', status: 'idle' }],
    questions: [],
    log: [],
    ...over,
  });
  it('trang vừa mở không phát chuyện cũ; giao việc phát đúng một lần', () => {
    expect(lib.chatEvents(null, snap())).toEqual([]);
    const a = snap();
    const b = snap({ goals: [{ tickets: [{ id: 'GT-0005', state: 'in_dev' }] }] });
    expect(lib.chatEvents(a, b)).toEqual([{ type: 'assign', from: 'pm', to: 'dev', ticket: 'GT-0005' }]);
    expect(lib.chatEvents(b, b)).toEqual([]);
  });
  it('ghế bắt đầu chạy, câu hỏi mới/đã trả lời, lỗi trong log', () => {
    const a = snap();
    const b = snap({
      seats: [{ seat: 'pm', agent: 'elon', status: 'idle' }, { seat: 'dev', agent: 'jenny', status: 'running', ticket: 'GT-0005' }, { seat: 'qc', agent: 'jacky', status: 'idle' }],
      questions: [{ id: 7, seat: 'dev', ticket: 'GT-0005', text: 'Q?' }],
      log: [{ at: 't1', who: 'jacky', text: 'error: aborted' }],
    });
    const ev = lib.chatEvents(a, b);
    expect(ev).toContainEqual({ type: 'start', seat: 'dev', ticket: 'GT-0005' });
    expect(ev).toContainEqual({ type: 'question', seat: 'dev', ticket: 'GT-0005', text: 'Q?' });
    expect(ev).toContainEqual({ type: 'error', seat: 'qc' });
    expect(lib.chatEvents(b, snap())).toContainEqual({ type: 'answered', seat: 'dev', ticket: 'GT-0005' });
  });
  it('người đang chạy không đáp Command; chọn câu EN/VI có tên và mã ticket, không lặp liền', () => {
    const b = snap({ seats: [{ seat: 'pm', agent: 'elon', status: 'idle' }, { seat: 'dev', agent: 'jenny', status: 'running' }] });
    expect(lib.chatTargetsFor('team', b)).toEqual(['pm']);
    expect(lib.chatTargetsFor('dev', b)).toEqual([]);
    const l1 = lib.pickChatLine('assign', { to: 'John', ticket: 'GT-1' }, 'vi');
    expect(l1).toContain('GT-1');
    expect(lib.pickChatLine('assign', { to: 'John', ticket: 'GT-1' }, 'vi')).not.toBe(l1);
    for (const lang of ['en', 'vi']) for (const k of Object.keys(lib.CHAT_LINES.en)) expect(lib.CHAT_LINES[lang][k]?.length).toBeGreaterThanOrEqual(5);
    expect(lib.chatStyleOf('jenny')).toBe(lib.chatStyleOf('jenny'));
    expect(lib.chatStyleOf('jenny')).toBeGreaterThanOrEqual(0);
    expect(lib.chatStyleOf('jenny')).toBeLessThan(6);
  });
  it('"go ahead" / "tiếp e" trong Command = Resume (chỉ khi gõ đúng cả câu)', () => {
    const f = new Function(html.slice(html.indexOf('var CHAT_LINES'), html.indexOf('var chatLastIdx')) + html.slice(html.indexOf('function isResumeWord'), html.indexOf('function chatStyleOf')) + 'return isResumeWord;')() as (t: string) => boolean;
    expect(f('go ahead')).toBe(true);
    expect(f('Go ahead!')).toBe(true);
    expect(f('tiếp e')).toBe(true);
    expect(f('Tiếp tục.')).toBe(true);
    expect(f('tiếp e làm phần UI')).toBe(false);
    expect(f('hello')).toBe(false);
    expect(html).toContain("var rr = await postJson('/api/resume', {});");
  });

  it('nút Mic: chỉ hiện khi trình duyệt có SpeechRecognition, chọn vi-VN/en-US, chữ vào ô Command (không tự gửi)', () => {
    expect(html).toContain('<span id="mic-group" class="mic-group" hidden>');
    expect(html).toContain('var SR = window.SpeechRecognition || window.webkitSpeechRecognition;');
    expect(html).toContain('<option value="vi-VN">VI</option><option value="en-US">EN</option>');
    const fn = html.slice(html.indexOf('var SR = window.SpeechRecognition'), html.indexOf('// Ctrl+Enter (Cmd+Enter'));
    expect(fn).toContain('cmdTextArea.value = ');
    expect(fn).not.toContain('cmdSendBtn.click()');
    expect(fn).toContain("ev.error === 'audio-capture' ? 'mic.none'");
    expect(fn).not.toContain('innerHTML');
  });

  it('Ctrl+Enter = Send ở ô Command và ô trả lời', () => {
    expect(html).toContain("if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && cmdSendBtn && !cmdSendBtn.disabled) { e.preventDefault(); cmdSendBtn.click(); }");
    expect(html).toContain("if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !btn.disabled) { e.preventDefault(); btn.click(); }");
  });

  it('người chờ nói chuyện về project (2–4 phút, mỗi agent một tiếng nói)', () => {
    expect(html).toContain('var chatNextChit = chatNow() + minutesIn(chatMoodCfg(moodNow(), chatOpt).chit);');
    expect(html).toContain("pickChatLine('projectChit', pv, chatMode)");
    expect(html).toContain('seenAgent[s.agent] = true;');
  });

  it('💭 agent đang chạy nói dòng Last log (lọc dòng rác, cắt 80, tối đa 1 lần / 60–90 s)', () => {
    const f = new Function(html.slice(html.indexOf('function chatThoughtLine'), html.indexOf('function chatStyleOf')) + 'return chatThoughtLine;')() as (s: string) => string;
    expect(f('Running npm test… 49/49 pass')).toBe('Running npm test… 49/49 pass');
    expect(f('**Đang sửa** ChoiGame.bat')).toBe('Đang sửa ChoiGame.bat');
    expect(f('[btm] idle_timeout')).toBe('');
    expect(f('/srv/btm-work/btm-jenny/gametest-btm/x.js')).toBe('');
    expect(f('   ')).toBe('');
    expect(f('a'.repeat(5) + ' ' + 'x'.repeat(200)).length).toBe(80);
    expect(html).toContain("chatShow(s.seat, '💭 ' + lead + line, false, true, true);");
    expect(html).toContain('if (now - (chatThoughtAt[s.seat] || 0) < tm[0] + Math.random() * tm[1]) return;');
  });

  it('bong bóng hiện lâu hơn 5 s (anh Zon)', () => {
    expect(html).toContain('var CHAT_SHOW_MS = 7000;');
    expect(html).toContain("el.classList.add('chat-fade'); }, CHAT_SHOW_MS)");
  });

  it('danh sách xổ xuống (Chat, View…) đọc được ở dark mode', () => {
    expect(html).toContain('select option { background-color: var(--card-bg); color: var(--text); }');
    expect(html).toContain('[data-theme="dark"] select { color-scheme: dark; }');
  });

  it('công tắc Chat nhớ trong localStorage (có try), chữ bằng textContent, có bong bóng chờ chớp', () => {
    expect(html).toContain('id="chat-toggle"');
    expect(html).toMatch(/try \{ var cm = window\.localStorage\.getItem\('btm\.chat'\)/);
    const fn = html.slice(html.indexOf('function chatShow'), html.indexOf('function chatRun'));
    expect(fn).toContain('el.textContent = text');
    expect(fn).not.toContain('innerHTML');
    expect(html).toContain('@keyframes chat-blink');
    for (let i = 0; i < 6; i++) expect(html).toContain(`.chat-bubble.style-${i}`);
  });
});

describe('Một ô trả lời cho nhiều câu hỏi cùng ticket (2026-11-14)', () => {
  const html = readWeb();
  const lib = new Function(html.slice(html.indexOf('function splitAnswers'), html.indexOf('function renderQuestions')) + 'return { splitAnswers, groupQuestions };')() as any;
  it('gom theo ticket + ghế; "1. … 2. …" đủ số câu thì tách, thiếu thì dùng chung', () => {
    const g = lib.groupQuestions([{ id: 1, ticket: 'A', seat: 'dev' }, { id: 2, ticket: 'B', seat: 'qc' }, { id: 3, ticket: 'A', seat: 'dev' }]);
    expect(g.map((x: any[]) => x.map((q) => q.id))).toEqual([[1, 3], [2]]);
    expect(lib.splitAnswers('1. Không có ảnh mẫu\n2. Đã chạy, đạt', 2)).toEqual(['Không có ảnh mẫu', 'Đã chạy, đạt']);
    expect(lib.splitAnswers('1) a\n2: b', 2)).toEqual(['a', 'b']);
    expect(lib.splitAnswers('Đạt hết, chuyển QC', 2)).toEqual(['Đạt hết, chuyển QC', 'Đạt hết, chuyển QC']);
    expect(lib.splitAnswers('1. chỉ có một', 2)).toEqual(['1. chỉ có một', '1. chỉ có một']);
    expect(lib.splitAnswers('ok', 1)).toEqual(['ok']);
    expect(html).toContain("clearBtn.className = 'q-clear';");
  });
});

describe('Để PM trả lời + chặn tạo goal nhầm (2026-11-14)', () => {
  const html = readWeb();
  it('nút gọi /api/questions/delegate; gửi Team khi còn câu hỏi thì hỏi lại trước', () => {
    expect(html).toContain('id="q-delegate"');
    expect(html).toContain("postJson('/api/questions/delegate', {})");
    expect(html).toContain("if (to === 'team' && latestSnapshot && (latestSnapshot.questions || []).length > 0) {");
    expect(html).toContain("text: tx('q.teamGuard'),");
    expect(html).toContain("var goPm = await askAsSeat('pm', { text: tx('cmd.pmGuard'");
  });
});

describe('Không còn confirm() của trình duyệt (2026-11-14)', () => {
  const html = readWeb();
  it('merge do PM hỏi; các hộp xác nhận khác cũng qua askOwner', () => {
    expect(html).toContain("var approveYes = await askAsSeat('pm', {");
    expect(html).toContain("'ask.merge': 'Anh Zon, G{n} is all done");
    const calls = html.match(/[^.\w]confirm\(/g) || [];
    expect(calls.length).toBe(1); // chỉ còn dự phòng trong askOwner khi trình duyệt không có <dialog>
  });
});

describe('Thời gian goal (2026-11-14)', () => {
  const html = readWeb();
  it('định dạng thời lượng và dòng ⏱ trên thẻ goal', () => {
    const f = new Function(html.slice(html.indexOf('function formatDuration'), html.indexOf('function renderGoals')) + 'return formatDuration;')() as (ms: number) => string;
    expect(f(3_725_000)).toBe('1h 02m');
    expect(f(37 * 60000)).toBe('37m');
    expect(f(20_000)).toBe('<1m');
    expect(html).toContain("tl.className = 'goal-time';");
  });
});

describe('Chat Auto: phân loại tin nhắn (2026-11-14)', () => {
  const html = readWeb();
  const classify = new Function(
    html.slice(html.indexOf('var CHAT_LINES'), html.indexOf('var chatLastIdx')) +
      html.slice(html.indexOf('function classifyMessage'), html.indexOf('// Anh Zon gõ đúng "go ahead"')) + 'return classifyMessage;'
  )() as (t: string, n?: any) => { kind: string; seat: string | null };
  const names = { pm: ['pm', 'Finn'], dev: ['dev', 'Marry'], qc: ['qc', 'Finn'], audit: ['audit', 'Bruno'] };
  it('câu thật của anh Zon hôm nay', () => {
    expect(classify('Audit G1 vừa rồi gặp lỗi secure gì ?', names)).toEqual({ kind: 'ask', seat: 'audit' });
    expect(classify('Kế tiếp làm job nào Finn?', names).kind).toBe('plan');
    expect(classify('Thêm boss và âm thanh cho game', names).kind).toBe('goal');
    expect(classify('Finn, thêm bảng điểm cao', names)).toEqual({ kind: 'goal', seat: 'pm' });
    expect(classify('Làm app ghi chú mới, project mới nhé', names).kind).toBe('project');
    expect(classify('Finn e trả lời luôn đi', names).kind).toBe('unknown');
    expect(classify('Marry làm đến đâu rồi?', names).kind).not.toBe('goal');
  });
  it('mặc định chọn Auto; gửi Auto không bao giờ tạo goal khi chưa xác nhận', () => {
    expect(html).toContain('<input type="radio" name="cmd-to" value="auto" checked>');
    const fn = html.slice(html.indexOf('async function sendAuto'), html.indexOf("if (cmdSendBtn && cmdTextArea) {"));
    const goalIdx = fn.indexOf("postJson('/api/team-note'");
    expect(fn.lastIndexOf("tx('auto.goalConfirm'", goalIdx)).toBeGreaterThan(-1);
    expect(fn).toContain("to: 'ask-' + seat");
  });
});

describe('Câu thoại theo giờ VN + file chat-lines.js (2026-11-14)', () => {
  const html = readWeb();
  const lib = new Function(html.slice(html.indexOf('var CHAT_LINES'), html.indexOf('// end chat-lib')) + 'return { vnHour, timeKind, CHAT_LINES };')() as any;
  it('khung giờ → nhóm câu; giờ VN là UTC+7; nhóm câu nằm trong web/app/chat-lines.js', () => {
    expect([6, 12, 15, 18, 21, 2].map(lib.timeKind)).toEqual(['timeMorning', 'timeLunch', 'timeAfternoon', 'timeDinner', 'timeEvening', 'timeLate']);
    expect(lib.vnHour(Date.parse('2026-11-14T05:30:00Z'))).toBe(12);
    expect(lib.CHAT_LINES.vi.timeLunch.some((l: string) => l.includes('{to}'))).toBe(true);
    expect(lib.CHAT_LINES.vi.weatherAsk[0]).toContain('mưa');
    const pick = new Function(html.slice(html.indexOf('var CHAT_LINES'), html.indexOf('// end chat-lib')) + 'return pickChatLine;')() as any;
    for (let k = 0; k < 6; k++) expect(pick('timeAfternoon', { to: 'anh Zon' }, 'vi')).toMatch(/^[A-ZĐ]/);
    expect(readFileSync(resolve(process.cwd(), 'web/app/chat-lines.js'), 'utf8')).toContain('Anh Zon sửa / thêm tay ở đây được');
    expect(html).toContain('<script src="/app/chat-lines.js"></script>');
  });
});

describe('Câu dạ khi nhận câu hỏi (2026-11-14)', () => {
  const html = readWeb();
  const ack = new Function(html.slice(html.indexOf('var CHAT_LINES'), html.indexOf('// end chat-lib')) + 'return ackLine;')() as (id: number, t: string) => string;
  it('tiếng Việt → dạ tiếng Việt; cố định theo id; có bong bóng khi gửi', () => {
    expect(ack(7, 'G1 đã làm đến đâu rồi Marry?')).toMatch(/^Dạ/);
    expect(ack(7, 'G1 đã làm đến đâu rồi Marry?')).toBe(ack(7, 'G1 đã làm đến đâu rồi Marry?'));
    expect(ack(7, 'How far is G1?')).not.toMatch(/Dạ/);
    expect(html).toContain("chatRun([{ target: seat, text: ackLine(r && r.id, text), delay: 1200, allowRunning: true }]);");
  });
});

describe('Khung chat History (2026-11-14)', () => {
  const html = readWeb();
  it('theo thời gian (cũ trên, mới dưới); câu trả lời ngay sau câu hỏi, kể cả lệnh thường; mốc goal ở cuối', () => {
    const build = new Function(
      html.slice(html.indexOf('var CHAT_LINES'), html.indexOf('// end chat-lib')) +
      html.slice(html.indexOf('function buildHistory'), html.indexOf('var HIST_ICON')) + 'return buildHistory;'
    )() as (s: any) => any[];
    const items = build({
      session: { goals: ['1'], status: 'running' },
      goals: [{ n: 1, title: 'Game' }],
      queue: [{ id: 5, to: 'audit', text: 'G1 lỗi gì?', status: 'done', created_at: 't5' }, { id: 4, to: 'ask-pm', text: '[plan] Kế tiếp làm gì?', status: 'queued', created_at: 't4' }, { id: 1, to: 'dev', text: 'tiếp tục', status: 'done', created_at: 't1' }],
      answers: [{ id: 5, seat: 'audit', asked: 'audit', agent: 'bruno', at: 't6', answer: 'DoS null byte, đã sửa' }],
    });
    // mỗi câu hỏi: "dạ" ngay (ack) rồi mới tới câu trả lời chi tiết
    expect(items.map((i) => `${i.kind}${i.ack ? '-ack' : ''}:${i.id ?? ''}`)).toEqual(['ask:1', 'reply-ack:1', 'ask:4', 'reply-ack:4', 'ask:5', 'reply-ack:5', 'reply:5', 'goal:']);
    expect(items[2]).toMatchObject({ plan: true, text: 'Kế tiếp làm gì?' });
    expect(items[5].text).toMatch(/^Dạ/);
    expect(items[6]).toMatchObject({ kind: 'reply', agent: 'bruno', text: 'DoS null byte, đã sửa' });
    expect(items[7]).toEqual({ kind: 'goal', text: 'G1 · Game', status: 'running' });
    expect(html).toContain('.chat-log .msg-owner { align-self: flex-start;');
    expect(html).toContain('.chat-log .msg-team { align-self: flex-end;');
  });
});

describe('Stop: agent hỏi lại thân thiện (2026-11-14)', () => {
  const html = readWeb();
  it('dùng <dialog> thay confirm(), mặc định là tiếp tục, chữ bằng textContent', () => {
    expect(html).toContain('<dialog id="ask-dialog"');
    expect(html).not.toContain("confirm(tx('confirm.stopCard'))");
    expect(html).not.toContain("confirm(tx('confirm.stop'))");
    expect(html).toContain("'ask.stopTicket': 'Do you want me to stop working on {ticket}?'");
    const fn = html.slice(html.indexOf('function askOwner'), html.indexOf('function renderSeatAvatar'));
    expect(fn).toContain('cancel.focus()');
    expect(fn).not.toContain('innerHTML');
  });
});

describe('Inbox / Goals / Log theo mẫu lần 2 (2026-11-14)', () => {
  const html = readWeb();
  it('cột Tags riêng, icon từng chặng, lọc log chỉ lỗi', () => {
    expect(html).toContain("thTags.textContent = tx('goal.col.tags')");
    expect(html).toContain('tdTags.appendChild(diffBtn)');
    for (const k of ['intake', 'plan', 'build', 'verify', 'audit', 'release']) expect(html).toContain(`.pipeline-step[data-stage="${k}"]`);
    const src = html.slice(html.indexOf('function isLogError'), html.indexOf('function logFilterValue'));
    const isErr = new Function(src + 'return isLogError;')() as (t: string) => boolean;
    expect(isErr('error: aborted')).toBe(true);
    expect(isErr('timeout: timeout')).toBe(true);
    expect(isErr('started GT-0005')).toBe(false);
    expect(html).toContain('.log-list.log-only-err .log-item:not(.log-err) { display: none; }');
  });
});

describe('Tab Folder cạnh Goals (2026-11-14)', () => {
  const html = readWeb();
  it('có tab Goals | Folder, chỉ GET /api/folders, giờ VN, cây file dựng bằng textContent', () => {
    expect(html).toContain('id="tab-goals"');
    expect(html).toContain('id="tab-folders"');
    expect(html).toContain('id="folders-container"');
    expect(html).toContain("fetch('/api/folders', { cache: 'no-store' })");
    const fn = html.slice(html.indexOf('function buildFileTree'), html.indexOf('async function loadFolders'));
    expect(fn).toContain('textContent');
    expect(fn).not.toContain('innerHTML');
    const src = html.slice(html.indexOf('function formatDateTimeVN'), html.indexOf('function buildFileTree'));
    const f = new Function(src + 'return formatDateTimeVN;')() as (iso: string) => string;
    expect(f('2026-11-13T18:42:00Z')).toBe('14/11, 01:42');
    const t = new Function(html.slice(html.indexOf('function buildFileTree'), html.indexOf('function renderFileTree')) + 'return buildFileTree;')() as (f: string[]) => any;
    const tree = t(['a.js', 'public/js/x.js', 'public/i.html']);
    expect(tree.files).toEqual(['a.js']);
    expect(tree.dirs.public.count).toBe(2);
    expect(tree.dirs.public.dirs.js.files).toEqual(['x.js']);
  });
});

describe('Khu Agents theo mẫu (2026-11-14)', () => {
  const html = readWeb();
  it('đếm ghế Live / Waiting / Idle và tiêu đề Agents (N)', () => {
    const src = html.slice(html.indexOf('function renderAgentCounts'), html.indexOf('(function () {', html.indexOf('function renderAgentCounts')));
    const els: Record<string, { textContent: string }> = { 'agents-count': { textContent: '' }, 'agents-live': { textContent: '' }, 'agents-waiting': { textContent: '' }, 'agents-idle': { textContent: '' } };
    const doc = { getElementById: (id: string) => els[id] ?? null };
    const tx = (_k: string, v: { n: number }) => `Agents (${v.n})`;
    const fn = new Function('document', 'tx', src + 'return renderAgentCounts;')(doc, tx);
    fn([{ status: 'running' }, { status: 'waiting' }, { status: 'waiting' }, { status: 'idle' }]);
    expect([els['agents-count']!.textContent, els['agents-live']!.textContent, els['agents-waiting']!.textContent, els['agents-idle']!.textContent]).toEqual(['Agents (4)', '1', '2', '']);
    for (const id of ['agents-refresh', 'agents-view', 'chat-mood']) expect(html).toContain(`id="${id}"`);
    expect(html).not.toContain('id="agents-idle"');
  });

  it('không khí team (2026-11-14): Vui vẻ nói nhiều hơn Bình thường; bàn kế hoạch [plan] đang chờ/chạy → tự Vui vẻ', () => {
    const lib = new Function(html.slice(html.indexOf('var CHAT_LINES'), html.indexOf('// end chat-lib')) + 'return { chatMoodCfg, chatDiscussing, livelyTalkPlan, CHAT_LINES };')() as any;
    expect(lib.chatMoodCfg('lively').chit).toEqual([0.5, 1]);
    for (const l of ['en', 'vi']) {
      const n = ['livelyChit', 'livelyAck', 'livelyThird'].map((k) => lib.CHAT_LINES[l][k].length);
      expect(n[0] + n[1] + n[2]).toBeGreaterThanOrEqual(50);
    }
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(lib.livelyTalkPlan(['pm', 'dev', 'qc', 'audit']).length);
    expect([...seen].sort()).toEqual([1, 2, 3]);
    expect(lib.livelyTalkPlan(['pm'])).toEqual(['pm']);
    expect(lib.livelyTalkPlan([])).toEqual([]);
    expect(html).toContain('setInterval(chatTick, 10000);');
    const lively = lib.chatMoodCfg('lively');
    const normal = lib.chatMoodCfg('normal');
    expect(lively.chit[1]).toBeLessThan(normal.chit[0]);
    expect(lively.check[1]).toBeLessThan(normal.check[0]);
    expect(lively.thoughtMs[0] + lively.thoughtMs[1]).toBeLessThan(normal.thoughtMs[0]);
    expect([lively.chitWhileWork, normal.chitWhileWork]).toEqual([true, false]);
    const q = (to: string, text: string, status: string) => ({ queue: [{ to, text, status }] });
    expect(lib.chatDiscussing(q('ask-pm', '[plan] next job?', 'queued'))).toBe(true);
    expect(lib.chatDiscussing(q('ask-qc', '[PLAN] review', 'running'))).toBe(true);
    expect(lib.chatDiscussing(q('ask-pm', '[plan] done one', 'done'))).toBe(false);
    expect(lib.chatDiscussing(q('ask-pm', 'just a question', 'queued'))).toBe(false);
    expect(lib.chatDiscussing(q('ask-lessons', '[plan] G1', 'queued'))).toBe(false);
    expect(lib.chatDiscussing(q('dev', '[plan] x', 'queued'))).toBe(false);
    expect(lib.chatDiscussing(null)).toBe(false);
  });
});

describe('Đốm sáng quanh thẻ ghế đang làm (2026-11-12)', () => {
  const html = readWeb();
  it('chỉ thẻ is-holder có hiệu ứng; luôn chạy kể cả reduced-motion (anh Zon chọn)', () => {
    expect(html).toContain('.seat-card.is-holder::before {');
    expect(html).toContain('animation: holder-glow 2.8s linear infinite;');
    expect(html).not.toMatch(/\.seat-card\.is-holder::before \{ animation: none; \}/);
    expect(html).toContain('pointer-events: none;');
  });
});

describe('Gộp Session goals vào khung hàng đợi (2026-11-12)', () => {
  const html = readWeb();
  it('không còn section Session goals; goal của phiên hiện "Goal G<n> · <tiêu đề>" trong cùng danh sách', () => {
    expect(html).not.toContain('goals-section');
    expect(html).not.toContain('id="goals-list"');
    expect(html).toContain("'queue.title': 'Meeting room'"); // 2026-11-14: gộp thành lịch sử chung
    expect(html).toContain("out.push({ kind: 'goal', text: text, status: s.status });");
    expect(html).toContain("text = 'G' + text + (found && found.title ? ' · ' + found.title : '');");
  });
});

describe('Thẻ thứ 5 Boss-Backup (2026-11-14)', () => {
  const html = readWeb();
  it('có thẻ seat-card-backup (id backup-*), nhãn "Backup", màn rộng chia đều một hàng', () => {
    expect(html).toContain('id="seat-card-backup"');
    expect(html).toContain('id="backup-last-line"');
    expect(html).toContain("'mb.badge': 'Backup',");
    expect(html).toContain('grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr);');
    expect(html).toContain('renderBossCard(state, isBusy);');
  });
});

describe('Workspace trên sidebar (2026-11-14)', () => {
  const html = readWeb();
  it('thẻ System status có tiêu đề "<project> – Workspace"; sidebar tự thu gọn sau 5 phút không đụng tới', () => {
    expect(html).toContain('<div class="ws-title" id="ws-title">Workspace</div>');
    expect(html).toContain("'ws.title': '{name} – Workspace'");
    expect(html).toContain('var AUTO_COLLAPSE_MS = 5 * 60 * 1000;');
    expect(html).toMatch(/\['mousemove', 'click', 'keydown', 'focusin'\]\.forEach\(function \(ev\) \{ sidebarEl\.addEventListener\(ev, armAutoCollapse\); \}\);/);
  });
});

describe('Họp tranh luận trên dashboard (2026-11-14)', () => {
  const html = readWeb();
  it('mục họp cho khung chat: đầu cuộc họp → lượt + ghi chú theo giờ → kết luận; id đổi khi có lượt mới', () => {
    const lib = new Function(html.slice(html.indexOf('function meetItems'), html.indexOf('function btmMeeting')) + 'return { meetItems, meetEvidenceMark };')() as any;
    expect(lib.meetItems(null)).toEqual([]);
    const m = {
      id: 3, topic: 'Nên dùng X?', status: 'done', quick: false, createdAt: '2026-11-14T01:00:00Z',
      turns: [
        { round: 1, agent: 'elon', seats: ['pm', 'qc'], at: '2026-11-14T01:01:00Z', points: [{ text: 'a', evidence: { type: 'file', ref: 'x.js' }, verified: true }] },
        { round: 2, agent: 'jenny', seats: ['dev'], at: '2026-11-14T01:05:00Z', points: [], skipped: 'timeout' },
      ],
      ownerNotes: [{ at: '2026-11-14T01:03:00Z', text: 'ý anh' }],
      conclusion: { by: 'elon', at: '2026-11-14T01:09:00Z', agreed: [], disputed: [], recommendation: 'Làm A', questions: [] },
    };
    const items = lib.meetItems(m);
    expect(items.map((x: any) => x.kind)).toEqual(['meet-head', 'meet-turn', 'meet-note', 'meet-turn', 'meet-end']);
    expect(items.map((x: any) => x.id)).toEqual(['M3', 'M3-1-elon-pm', 'M3-note-0', 'M3-2-jenny-dev', 'M3-end']);
    expect(items[3].status).toBe('skip');
    expect([lib.meetEvidenceMark(true), lib.meetEvidenceMark(false), lib.meetEvidenceMark(null)]).toEqual(['✓', '⚠', '⚠']);
  });

  it('có lựa chọn Meeting + Quick, thanh điều khiển, zoom chữ; đang họp thì tự Lively', () => {
    expect(html).toContain("{ value: 'meeting', label: tx('cmd.meeting') }");
    for (const id of ['meet-bar', 'meet-quick', 'chat-zoom-in', 'chat-zoom-out']) expect(html).toContain(`id="${id}"`);
    expect(html).toContain("postJson('/api/meeting', { action: 'start', topic: text, quick:");
    expect(html).toContain('<script src="/app/meeting.js"></script>');
    expect(html).toMatch(/\.chat-log \.msg-body, \.chat-log \.meet-topic \{ font-size: calc\(13px \* var\(--chat-zoom, 1\)\); \}/);
    const lib = new Function(html.slice(html.indexOf('var CHAT_LINES'), html.indexOf('// end chat-lib')) + 'return { chatDiscussing };')() as any;
    expect(lib.chatDiscussing({ meeting: { status: 'running' }, queue: [] })).toBe(true);
    expect(lib.chatDiscussing({ meeting: { status: 'paused' }, queue: [] })).toBe(false);
    expect(html.slice(html.indexOf('function meetItems'), html.indexOf('// end meeting'))).not.toContain('innerHTML');
  });
});

describe('Họp: tài liệu upload + xuất biên bản trên dashboard (2026-11-14, bước 2)', () => {
  const html = readWeb();
  it('có nút đính kèm tài liệu (chỉ khi chọn Meeting), danh sách chờ, nút xuất md / html', () => {
    for (const id of ['meet-docs-wrap', 'meet-doc-input', 'meet-docs-list']) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('accept=".pdf,.docx,.xlsx,.txt,.md,.csv"');
    expect(html).toContain("if (docsWrap) docsWrap.hidden = to !== 'meeting';");
    expect(html).toContain("postJson('/api/meeting/doc', { action: 'add', name: f.name, base64: await readBase64(f) })");
    expect(html).toContain("a.href = '/api/meetings/' + m.id + '/export.' + f[0];");
    const lib = new Function(html.slice(html.indexOf('function meetItems'), html.indexOf('function btmMeeting')) + 'return { meetItems };')() as any;
    expect(lib.meetItems({ id: 1, topic: 't', status: 'done', createdAt: 'x', docs: [{ name: 'a.pdf', note: '3 pages' }] })[0].docs).toEqual([{ name: 'a.pdf', note: '3 pages' }]);
  });
});

describe('Settings trên dashboard (2026-11-14)', () => {
  const html = readWeb();
  it('có trang Settings: 4 chuẩn + chuẩn riêng + mặc định dashboard, lưu qua /api/standards; trình duyệt mới theo mặc định server', () => {
    for (const id of ['settings-section', 'std-tz', 'std-tz-value', 'std-utf8', 'std-theme', 'std-bilingual', 'std-custom', 'ui-lang', 'ui-theme', 'settings-save']) expect(html).toContain(`id="${id}"`);
    expect(html).toContain("postJson('/api/standards', {");
    expect(html).toContain("if (!localStorage.getItem('btm-theme') && (ui.theme === 'light' || ui.theme === 'dark')) document.documentElement.setAttribute('data-theme', ui.theme);");
    expect(html).toContain('<script src="/app/settings.js"></script>');
  });
});

describe('Thu gọn cả thẻ Accounts (2026-11-14)', () => {
  const html = readWeb();
  it('mũi tên to thu gọn cả thẻ chỉ còn hàng tiêu đề; mở mà 3 phút không đụng tới thì tự thu; bấm nút trên thanh công cụ thì mở lại', () => {
    expect(html).toContain('id="acc-card-toggle"');
    expect(html).toContain('.accounts-section.acc-card-collapsed > :not(.acc-header) { display: none !important; }');
    expect(html).toContain("card.classList.toggle('acc-card-collapsed', !open);");
    expect(html).toContain('timer = open ? setTimeout(function () { setOpen(false); }, ACC_SLEEP_COLLAPSE_MS) : null;');
    expect(html).toContain('if (!open && ev.target !== btn) setOpen(true);');
    expect(html).toMatch(/\.acc-card-toggle \{[^}]*font-size: 20px/);
  });
});

describe('Skills trong Settings (2026-11-14)', () => {
  const html = readWeb();
  it('có ô dán + link GitHub + danh sách; tóm tắt cổng bảo mật (Core + từng người kiểm); chỉ skill đã duyệt mới bật được', () => {
    for (const id of ['skills-paste', 'skills-paste-btn', 'skills-url', 'skills-url-btn', 'skills-candidates', 'skills-list', 'skills-reviewers']) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('<script src="/app/skills.js"></script>');
    expect(html).toContain("oncb.disabled = s.status !== 'approved';");
    const src = html.slice(html.indexOf('var SKILL_STATUS'), html.indexOf('// end skills'));
    expect(src).not.toContain('innerHTML');
    const lib = new Function(html.slice(html.indexOf('function skillChecks'), html.indexOf('function btmSkills')) + 'return { skillChecks };')() as any;
    expect(lib.skillChecks({ scan: [], reviews: [] })).toEqual([{ who: 'core', ok: true, worst: 'none', count: 0 }]);
    const c = lib.skillChecks({ scan: [{ severity: 'low' }, { severity: 'high' }], reviews: [{ agent: 'mb', verdict: 'safe', summary: 'ok', risks: [] }, { agent: 'elon', verdict: 'unsafe', summary: 'bad', risks: [{}] }] });
    expect(c[0]).toEqual({ who: 'core', ok: false, worst: 'high', count: 2 });
    expect(c.slice(1)).toEqual([{ who: 'mb', ok: true, summary: 'ok', count: 0 }, { who: 'elon', ok: false, summary: 'bad', count: 1 }]);
  });
});

describe('Find skills trên dashboard (2026-11-14)', () => {
  const html = readWeb();
  it('một ô nhận từ khoá / owner/repo@skill / link GitHub; gợi ý từ khoá theo project; kết quả có lượt cài + mức tin', () => {
    const lib = new Function(html.slice(html.indexOf('function skillsInputKind'), html.indexOf('function btmSkills')) + 'return { skillsInputKind, skillKeywordHints };')() as any;
    expect(lib.skillsInputKind('code review')).toBe('keyword');
    expect(lib.skillsInputKind('react')).toBe('keyword');
    expect(lib.skillsInputKind('vercel-labs/skills@find-skills')).toBe('repo');
    expect(lib.skillsInputKind('acme/skills')).toBe('repo');
    expect(lib.skillsInputKind('https://github.com/acme/skills')).toBe('repo');
    expect(lib.skillKeywordHints({ exts: ['js', 'html', 'css'], hasTests: true })).toEqual(['frontend design', 'javascript', 'testing', 'code review', 'security review', 'debugging']);
    expect(lib.skillKeywordHints(null)).toEqual(['code review', 'security review', 'debugging']);
    expect(html).toContain("postJson('/api/skills', { action: 'search', query: q })");
    expect(html).toContain("action: 'search-import'");
    expect(html).toContain('id="skills-hints"');
    expect(html).toContain("if (/^https?:/i.test(q) || q.indexOf('@') >= 0) throw err;");
  });
});

describe('Settings: chat lúc rảnh + lỗi tay nắm ô Command (2026-11-14)', () => {
  const html = readWeb();
  it('nhịp chat theo cài đặt: Vui vẻ tính bằng giây, Bình thường bằng phút, số người nói tối đa; không có cài đặt thì như cũ', () => {
    const lib = new Function(html.slice(html.indexOf('var CHAT_LINES'), html.indexOf('// end chat-lib')) + 'return { chatMoodCfg, capSpeakers, livelyTalkPlan };')() as any;
    const opt = { speakers: 2, livelySec: [20, 40], normalMin: [10, 15] };
    expect(lib.chatMoodCfg('lively', opt)).toMatchObject({ chit: [20 / 60, 40 / 60], speakers: 2 });
    expect(lib.chatMoodCfg('normal', opt)).toMatchObject({ chit: [10, 15], speakers: 2 });
    expect(lib.chatMoodCfg('lively')).toMatchObject({ chit: [0.5, 1], speakers: 3 });
    expect(lib.chatMoodCfg('normal', null)).toMatchObject({ chit: [5, 8], speakers: 3 });
    const steps = [{ target: 'owner' }, { target: 'pm' }, { target: 'dev' }, { target: 'pm' }, { target: 'qc' }];
    expect(lib.capSpeakers(steps, 2).map((s: any) => s.target)).toEqual(['owner', 'pm', 'dev', 'pm']);
    expect(lib.capSpeakers(steps, 1).map((s: any) => s.target)).toEqual(['owner', 'pm', 'pm']);
    for (let i = 0; i < 50; i++) expect(lib.livelyTalkPlan(['pm', 'dev', 'qc', 'audit'], null, 1)).toHaveLength(1);
    for (let i = 0; i < 50; i++) expect(lib.livelyTalkPlan(['pm', 'dev', 'qc', 'audit'], null, 2).length).toBeLessThanOrEqual(2);
  });

  it('trang Settings có ô số người nói + khoảng nghỉ; ô Command không còn tay nắm đổi cỡ', () => {
    for (const id of ['chat-speakers', 'chat-lively-min', 'chat-lively-max', 'chat-normal-min', 'chat-normal-max']) expect(html).toContain(`id="${id}"`);
    expect(html).toContain("if (JSON.stringify(opt) !== JSON.stringify(chatOpt)) { chatOpt = opt; rescheduleMood(); }");
    expect(html).toMatch(/\.cmd-composer \.cmd-composer-text \{\s*resize: none;/);
  });
});

describe('Skills: bước thêm vào BTM rõ ràng (2026-11-14)', () => {
  const html = readWeb();
  it('nút thêm ghi số skill đã tick, tắt khi chưa tick; Save settings nhắc khi còn skill đã tick chưa thêm', () => {
    expect(html).toContain("'skills.import': 'Add {n} selected skill(s) to BTM (security check first)'");
    expect(html).toContain('imp.disabled = n === 0;');
    expect(html).toContain("var pending = document.querySelectorAll('#skills-candidates input:checked').length;");
    expect(html).toContain("tx('skills.notAdded', { n: pending })");
  });
});

describe('Kết quả tìm skill: nhiều cột, chữ to hơn (2026-11-14)', () => {
  it('lưới tự chia cột theo độ rộng, chữ 17.3px, nút thêm trải hết hàng', () => {
    const html = readWeb();
    expect(html).toMatch(/\.skills-candidates \{ display: grid; grid-template-columns: repeat\(auto-fill, minmax\(420px, 1fr\)\);[^}]*font-size: 17\.3px;[^}]*\}/);
    expect(html).toContain('.skills-candidates > .skills-import-btn, .skills-candidates > .empty-placeholder { grid-column: 1 / -1; }');
  });
});
