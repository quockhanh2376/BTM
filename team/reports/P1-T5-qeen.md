Bug: `src/runner/run.ts:78` — `killTimer.unref()` cho phép BTM thoát trước SIGKILL; tái hiện Node thoát sau ~0,8 giây, process con bỏ qua SIGTERM vẫn sống sau 5,5 giây.
Cần sửa: Giữ event loop sống đến khi hoàn tất diệt process group; thêm test chạy runner trong Node riêng, vì test hiện tại tự giữ event loop nên che lỗi.
