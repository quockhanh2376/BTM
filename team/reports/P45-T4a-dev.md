Cần sửa: CLI chưa truyền cfg vào initProject/migrateProject nên isolation chưa bật ở luồng lệnh thực tế.
Cần xác nhận: cập nhật caller src/cli.ts nằm ngoài scope file được giao.
Bug: chưa có kiểm thử xung đột merge-tree trong trusted repo.
`npx tsc --noEmit`: sạch.
`npx vitest run`: không khởi động; Windows `spawn EPERM` khi load vitest.config.ts.
