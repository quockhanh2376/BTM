/* BTM dashboard – tab Folder (chỉ xem cấu trúc repo + thư mục từng account). Tách từ app.js 2026-11-14, không đổi hành vi.
   Hàm thuần là global (goals.js và app.js dùng formatDateTimeVN); phần cần clearChildren/agentLabel nằm trong btmFolders(d). */
// Tab Folder (anh Zon 2026-11-14): chỉ xem cấu trúc repo chính + thư mục làm việc từng account.
function formatDateTimeVN(iso) {
  var d = new Date(iso);
  if (!iso || isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}
function buildFileTree(files) {
  var root = { dirs: {}, files: [], count: 0 };
  files.forEach(function (f) {
    var parts = String(f).split('/');
    var node = root;
    root.count++;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!Object.prototype.hasOwnProperty.call(node.dirs, parts[i])) node.dirs[parts[i]] = { dirs: {}, files: [], count: 0 };
      node = node.dirs[parts[i]];
      node.count++;
    }
    node.files.push(parts[parts.length - 1]);
  });
  return root;
}
function renderFileTree(node, parent) {
  Object.keys(node.dirs).sort().forEach(function (name) {
    var det = document.createElement('details');
    det.className = 'ftree-dir';
    var sum = document.createElement('summary');
    sum.textContent = '📁 ' + name + '/ ';
    var cnt = document.createElement('span');
    cnt.className = 'ftree-count';
    cnt.textContent = String(node.dirs[name].count);
    sum.appendChild(cnt);
    det.appendChild(sum);
    renderFileTree(node.dirs[name], det);
    parent.appendChild(det);
  });
  node.files.sort().forEach(function (name) {
    var f = document.createElement('div');
    f.className = 'ftree-file';
    f.textContent = name;
    parent.appendChild(f);
  });
}
function folderCard(title, path, rows, files, truncated, note) {
  var card = document.createElement('div');
  card.className = 'folder-card';
  var h = document.createElement('div');
  h.className = 'folder-title';
  h.textContent = title;
  card.appendChild(h);
  var p = document.createElement('code');
  p.className = 'folder-path';
  p.textContent = path;
  card.appendChild(p);
  var meta = document.createElement('div');
  meta.className = 'folder-meta';
  rows.forEach(function (r) {
    var chip = document.createElement('span');
    chip.className = 'folder-chip';
    var k = document.createElement('span');
    k.className = 'folder-chip-k';
    k.textContent = r[0];
    chip.appendChild(k);
    chip.appendChild(document.createTextNode(' ' + r[1]));
    meta.appendChild(chip);
  });
  card.appendChild(meta);
  if (note) {
    var n = document.createElement('div');
    n.className = 'account-detail';
    n.textContent = note;
    card.appendChild(n);
  }
  if (files && files.length) {
    var det = document.createElement('details');
    det.className = 'ftree';
    var sum = document.createElement('summary');
    sum.textContent = tx('folders.tree', { n: files.length }) + (truncated ? ' · ' + tx('folders.truncated', { n: files.length }) : '');
    det.appendChild(sum);
    renderFileTree(buildFileTree(files), det);
    card.appendChild(det);
  }
  return card;
}

    function btmFolders(d) {
      var clearChildren = d.clearChildren, agentLabel = d.agentLabel;

      function renderFolders(data) {
        var box = document.getElementById('folders-container');
        if (!box) return;
        clearChildren(box);
        var ro = document.createElement('div');
        ro.className = 'account-detail';
        ro.textContent = tx('folders.readOnly');
        box.appendChild(ro);
        if (!data || !data.repo) {
          var e = document.createElement('div');
          e.className = 'empty-placeholder';
          e.textContent = tx('folders.noProject');
          box.appendChild(e);
          return;
        }
        var r = data.repo;
        box.appendChild(folderCard(tx('folders.repo'), r.path, [
          [tx('folders.branch'), r.branch || '—'],
          [tx('folders.commit'), r.commit ? r.commit.sha + ' · ' + r.commit.subject + ' · ' + formatDateTimeVN(r.commit.at) : '—'],
          [tx('folders.dirty'), String(r.dirty)]
        ], r.files, r.truncated, data.isolated ? '' : tx('folders.shared')));
        var grid = document.createElement('div');
        grid.className = 'folder-grid';
        (data.accounts || []).forEach(function (a) {
          var slug = a.key !== a.agent && a.key.indexOf(a.agent + '-') === 0 ? a.key.slice(a.agent.length + 1) : '';
          grid.appendChild(folderCard(agentLabel(a.agent) + (slug ? ' · ' + slug : ''), a.path, [
            [tx('folders.projects'), (a.projects || []).join(', ') || '—'],
            [tx('folders.synced'), a.syncedAt ? formatDateTimeVN(a.syncedAt) : '—'],
            [tx('folders.dirty'), a.dirty == null ? '—' : String(a.dirty)]
          ], a.files, a.truncated, a.error ? tx('folders.notCreated') : ''));
        });
        box.appendChild(grid);
      }
      async function loadFolders() {
        var box = document.getElementById('folders-container');
        if (!box) return;
        if (!box.firstChild) {
          var l = document.createElement('div');
          l.className = 'empty-placeholder';
          l.textContent = tx('folders.loading');
          box.appendChild(l);
        }
        try {
          var res = await fetch('/api/folders', { cache: 'no-store' });
          if (!res.ok) throw new Error(String(res.status));
          renderFolders(await res.json());
        } catch (e) {
          clearChildren(box);
          var f = document.createElement('div');
          f.className = 'empty-placeholder';
          f.textContent = tx('folders.failed');
          box.appendChild(f);
        }
      }
      (function () {
        var tg = document.getElementById('tab-goals');
        var tf = document.getElementById('tab-folders');
        if (!tg || !tf) return;
        function show(folders) {
          tg.classList.toggle('active', !folders);
          tf.classList.toggle('active', folders);
          tg.setAttribute('aria-selected', folders ? 'false' : 'true');
          tf.setAttribute('aria-selected', folders ? 'true' : 'false');
          document.getElementById('goals-container').hidden = folders;
          document.getElementById('folders-container').hidden = !folders;
          // .btn đặt display nên thuộc tính hidden không ăn: ẩn bằng style.
          document.getElementById('goal-add').style.display = folders ? 'none' : '';
          document.getElementById('folders-refresh').style.display = folders ? '' : 'none';
          if (folders) loadFolders();
        }
        tg.addEventListener('click', function () { show(false); });
        tf.addEventListener('click', function () { show(true); });
        document.getElementById('folders-refresh').addEventListener('click', loadFolders);
      })();
    }
