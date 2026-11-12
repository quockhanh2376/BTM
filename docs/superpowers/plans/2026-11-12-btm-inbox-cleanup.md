# Team inbox: xoá ghi chú, thu gọn, đổi thứ tự dashboard

Anh Zon duyệt 2026-11-12.

**Mục tiêu:** dashboard gọn cho việc xem hằng ngày (Command + Accounts ở trên), inbox không chiếm chỗ, xoá được ghi chú cũ.

## Thiết kế đã duyệt

- **Xoá:** ô chọn mỗi ghi chú + nút *Delete selected* / *Delete all* (hỏi xác nhận, liệt kê N-x). Xoá dòng DB **và** `team/inbox/N-x.md` + ảnh trên nhánh `main` của checkout tin cậy, commit `inbox: delete N-…` (tác giả owner). Chỉ khi rảnh (đang chạy → 409).
- **Thu gọn:** mặc định chỉ thanh tiêu đề `Team inbox · N notes · M open`; rê chuột hoặc bấm tiêu đề → mở; rời chuột 3 phút → tự thu.
- **Thứ tự:** thanh phiên → Questions → Command → Accounts → các ghế → Session goals → Team inbox → Goals + Log + Diff.

**Không làm:** viết lại lịch sử git (file vẫn còn trong lịch sử); xoá file trên nhánh `goal/…` chưa merge.

## Cách làm (đã chọn)

- Commit xoá theo mẫu merge goal (`src/ticket/goal.ts`): cây sạch, `main` khớp SHA ghim (`protected_sha:<repo>`, lệch → `protected_branch_moved`), checkout `main`, `git rm`, commit, cập nhật ghim, checkout lại nhánh cũ; lỗi → `reset --hard` + về nhánh cũ.
- Phương án bỏ: dùng index tạm để commit không checkout (thêm đường đi thứ hai khi HEAD đang ở main); viết lại lịch sử (hỏng nhánh/workspace agent).

## Task

1. `removeInboxFromMain(repo, names, protectedBranch, pinned)` trong `src/server/inbox.ts` + `POST /api/notes/delete {ids?: number[], all?: true}` trong `src/server/http.ts`. Test: file mất trên main, ghim mới = main, nhánh cũ giữ nguyên, bận → 409, main lệch ghim → 409, id project khác bị bỏ qua.
2. `web/index.html`: inbox thu gọn + ô chọn + 2 nút; đổi thứ tự section. Test HTML: thứ tự section, chuỗi i18n mới có trong `STRINGS.en`.
