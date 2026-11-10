# P5 review 1 – nhánh plan5-flexible-team

Reviewer độc lập (chỉ đọc code). Failover không phá luật cứng: người code ≠ QC, người code ≠ Audit, người ngồi thay được ghi đúng tên.

| # | Mức | Vấn đề | Xử lý |
|---|---|---|---|
| H1 | High | Gate chạy lệnh dưới user Dev mà không reset trước, nên `~/.npmrc` (`script-shell=/bin/true`) làm gate đạt giả | Đã sửa: reset trước sync trong gate |
| H2 | High | Agent `chmod 555` thư mục thì reset xoá không được mà vẫn thoát 0 | Đã sửa: `chmod -R u+rwX` rồi kiểm từng path, còn sót thì thoát 3 và lượt huỷ. Đã thử thật trên VM |
| M1 | Med | Reset sót `~/.claude.json` mcpServers/allowedTools, memory `~/.claude/projects`, file rc shell, `~/.local/bin`, skills/extensions | Đã sửa: bỏ các khoá đó trong `.claude.json`; xoá projects, `.local/bin`, skills, extensions; dựng lại `.bashrc`/`.profile` từ `/etc/skel` |
| M2 | Med | Ticket có scope `team/project.yaml` thì đổi được ghế sau khi merge | Đã sửa: gate báo `project_config_tampered` |
| M3 | Med | Task 7 chưa đủ so với spec | Còn thiếu: xử lý lỗi hạn mức giữa lượt; `seats_backup` theo project; dừng hẳn kiểu nút Dừng; giờ hồi sớm nhất. Ghi trong plan; lượt lỗi hạn mức thì bấm Tiếp tục |
| M4 | Med | `--effort` có thể không được CLI nhận | Đã kiểm `--help` trên VM: claude và agy đều có `--effort`, agy nhận low…max |
| L1 | Low | Cờ handoff tính trước khi chọn người thay | Đã sửa |
| L2 | Low | PM bị thay thì người chính không quay lại trong goal đó | Để sau |
| L3 | Low | Model bắt đầu bằng `-` | Đã sửa: ký tự đầu phải là chữ hoặc số |
| L4 | Low | Override ghế cũ (không theo project) giờ xếp dưới `project.yaml` | Chấp nhận, đã ghi trong `docs/team-setup.md` |
