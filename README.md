# ris-api-app — Automation RIS PACS-AI bằng REST API

App web chạy tại **http://localhost:8000**, thực hiện trọn quy trình
**100% bằng REST API** (không dùng browser/UI automation):

1. Worklist ca Chờ chụp → 2. Tiếp nhận → 3. Xác nhận ca chụp → 4. Xem ca đọc →
   5. Khóa ca → 6. Lưu nháp mô tả/kết luận → 7. Hoàn thành ca chụp (ký) →
   8. Duyệt kết quả

## Chạy

```bash
cd /root/pac/ris-api-app
node server.cjs            # mặc định port 8000
PORT=8001 node server.cjs  # đổi port nếu cần
```

Mở http://localhost:8000, đăng nhập bằng **tài khoản bất kỳ** trên Keycloak,
bấm “Tải worklist” rồi “Chạy ca Chờ chụp đầu tiên” (hoặc nút Chạy từng dòng,
hoặc phím tắt **Alt+T**).

Worklist và nút chạy mặc định **chỉ lấy các ca đã gán máy Siêu âm CS1**
(`CS1 - Máy siêu âm mắt`, lọc cứng theo `device.id`). Bỏ tick
“Chỉ máy Siêu âm CS1” trên giao diện (hoặc `onlyCS1=0` / `onlyCS1:false`)
để làm việc với mọi máy.

- Tick **Dry-run** (mặc định bật): chỉ đọc + chọn thiết bị, **không ghi** gì.
- Bỏ tick dry-run mới ghi thật: tiếp nhận → xác nhận → khóa → nháp → duyệt.

## API của app

| Method | Path | Mô tả |
|---|---|---|
| GET | `/` | Giao diện web |
| GET | `/api/health` | Kiểm tra sống |
| POST | `/api/login` | `{username,password}` → session cookie `ris_sid` |
| POST | `/api/logout` | Xóa session |
| GET | `/api/me` | User đang đăng nhập |
| GET | `/api/worklist?onlyCS1=1&days=3&page=1&pageSize=10&q=tên+mã+phiếu` | Ca chụp trong N ngày gần nhất (mặc định 3 ngày, 10 ca/trang); lọc máy CS1 bằng `ModalityIds=<id máy>` đúng như web thật; `q` tìm kiếm thông minh xuyên mọi cột, không phân biệt dấu |
| POST | `/api/run` | `{studyId?, description?, conclusion?, confirmOverlap?, dryRun?}` |

Mặc định `description="."`, `conclusion="dịch kính vẩn đục không bong võng mạc"`.

## Cách đăng nhập (không cần browser)

Client `ris` trên Keycloak đã tắt password-grant (`unauthorized_client`), nên app
tự thực hiện luồng **Authorization Code + PKCE qua HTTP thuần túy**
(`lib/keycloak.cjs`): mở form login → submit user/pass → hứng `code` →
đổi lấy `access_token/refresh_token`. Token tự refresh khi sắp hết hạn.

## Mapping endpoint ris-api (khớp frontend PACS-AI)

| Bước | Gọi |
|---|---|
| Worklist | `GET /study/image?Page&PageSize&OrderDateFrom&OrderDateTo` |
| Chọn thiết bị | `GET /device?ProcedureId&IsActive=true&ExcludeRoom=true` (hoặc dùng `device` có sẵn của ca) |
| Tiếp nhận | `POST /study/{id}/device/{deviceId}` (không body) |
| Xác nhận ca chụp | `PUT /study/{id}/complete` |
| Xem ca đọc | `GET /study/{id}` + `GET /study/{id}/report/me` |
| Khóa ca | `PUT /study/{id}/lock` body `{isLocked:true}` |
| Lưu nháp | `POST /study/{id}/report/draft` body `{diagnosticContent, doctorAdvice, templateId, resultTemplateId, imageUrls}` |
| Hoàn thành ca chụp (ký) | `POST /study/{id}/report` body `{diagnosticContent, doctorAdvice, templateId, resultTemplateId, eSignUserId, diagnosisAt, startedAt, imageUrls, technicianId}` — **bắt buộc trước khi duyệt** |
| Kiểm tra trùng | `POST /study/check-overlap` body `{patientId, studyId, endTime, startTime, eSignUserId}` |
| Duyệt | `POST /study/{id}/report/approve` body `{diagnosticContent, doctorAdvice, templateId, resultTemplateId, eSignUserId, diagnosisAt, startedAt, imageUrls, technicianId}` |

`diagnosticContent` dựng theo đúng format frontend:
`<p><strong>Mô tả</strong></p><p>...</p><p><strong>Kết luận</strong></p><p>...</p>`.
`templateId`/`resultTemplateId` gửi `null` như web thật (gửi id mẫu sai gây 500).
`diagnosisAt` phải sau `startedAt` tuyệt đối (lệch 60 giây).

## Lưu ý

- Server nội bộ dùng chứng chỉ riêng nên app mặc định bỏ verify TLS
  (`NODE_TLS_REJECT_UNAUTHORIZED=0`); đặt biến môi trường này thành `1` nếu hạ tầng đã có CA hợp lệ.
- Server tự mở khóa ca sau khi lưu nháp, nên app tự khóa lại ngay trước
  mỗi bước ghi (ký/duyệt).
- Session/token lưu trong RAM tiến trình; restart server phải đăng nhập lại.
