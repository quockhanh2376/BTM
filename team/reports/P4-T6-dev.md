tests/session.test.ts: 14 -> 71, tests/qc.test.ts: 3 -> 32
- Bỏ test 'thẻ T-001 cũ có sẵn + PM tạo T-002': thay thế bởi luồng goal ticket (team/tickets/).
- Bỏ test 'resumeSession dùng đúng tập thẻ của commit PM (session_tasks)': thay thế bởi ticket store và thư mục goal (session_tasks đã bỏ).
- Bỏ test 'chỉ parse thẻ trong diff PM; thẻ cũ hỏng + PM tạo T-002': thay thế bởi loadTickets đọc ticket hợp lệ theo KEY.
- Bỏ test 'resume với session_tasks rỗng → no_session_tasks': thay thế bởi kiểm tra goals_json (no_session_goals).
- Bỏ test 'repo ở nhánh session cũ có commit lạ': thay thế bởi nhánh goal/G<n>-<slug> độc lập thay vì session/<id>.
Bug: không
