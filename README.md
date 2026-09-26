# ♠ Royal Poker

Texas Hold'em (No-Limit) online cho nhóm bạn: tạo tài khoản bằng tên đăng nhập + mật khẩu, tạo bàn, chơi kiểu **Sit & Go**
(ai cũng bắt đầu với số chip như nhau, chip chỉ tồn tại trong trận).

- **Frontend:** HTML/CSS/JS thuần, host trên **Vercel** (thư mục `public/`)
- **Backend:** **Supabase**: Auth (tên đăng nhập + mật khẩu), Postgres (RLS), Realtime, Edge Function `poker`

## Kiến trúc

```
Trình duyệt ──(signInWithPassword)──► Supabase Auth   (tạo tài khoản: POST /functions/v1/register)
     │
     ├── POST /functions/v1/poker  { op: sit | act | tick | ... }   ← mọi hành động đi qua server
     │        └─ Edge Function: đọc state → engine.advance() → thao tác → commit nguyên tử (optimistic lock)
     │
     ├── Realtime: nghe poker_tables (có thay đổi → tải lại view), poker_chat, presence (ai đang online)
     └── REST (RLS): danh sách bàn, bảng xếp hạng, lịch sử chat
```

- **Server là nguồn sự thật duy nhất.** Bộ bài và bài tẩy nằm trong `poker_state`. Bảng này không có
  policy nào, nên client không thể đọc. Mỗi người chỉ nhận `viewFor(userId)` chứa bài của chính mình.
- **Không cần server chạy liên tục.** Engine không dùng `setTimeout`: mọi hẹn giờ (hết lượt, chia street
  tiếp theo, ván mới, đếm ngược match) là mốc thời gian lưu trong state. Client gọi `tick` khi đến hạn,
  server xử lý mọi sự kiện đã đến hạn.
- **Chống tranh chấp.** Mỗi lần ghi kiểm tra `version` (optimistic lock, tự retry). Thống kê
  thắng/trận được cộng trong cùng transaction (`poker_commit`).
- **Xáo bài** bằng Fisher–Yates + `crypto.getRandomValues` (rejection sampling, không lệch).

## Cấu trúc thư mục

```
public/                      # Web (deploy lên Vercel)
  index.html, css/style.css
  js/app.js                  # sảnh, bàn, animation, realtime, presence
  js/cards.js                # lá bài & chip vẽ bằng SVG
  js/voice.js                # đọc bài tiếng Việt (Web Speech API)
  js/sfx.js                  # âm thanh tổng hợp bằng WebAudio
  js/config.js               # URL + publishable key Supabase (public)
supabase/
  migrations/*.sql           # schema, RLS, hàm poker_commit
  functions/poker/index.ts   # API game (Edge Function)
  functions/register/index.ts # tạo tài khoản (Edge Function)
  functions/poker/engine/    # engine poker (JS thuần, chạy cả Deno & Node)
test/                        # test (xem bên dưới)
```

## Tài khoản

Không dùng Gmail/Google. Edge Function `register` tạo tài khoản trong Supabase Auth với email nội bộ
`<tên đăng nhập>@players.royalpoker.test` (đã xác nhận sẵn, không bao giờ gửi mail). Client đăng nhập bằng
`signInWithPassword`. Chưa có chức năng lấy lại mật khẩu.

## Chạy local

```bash
npx serve public -l 5173      # mở http://localhost:5173
```

## Test

```bash
npm test                      # toàn bộ test offline (~1 phút)
FUZZ_GAMES=2000 npm run test:fuzz   # fuzz sâu hơn
RP_TEST_EMAIL_A=a@x.com RP_TEST_EMAIL_B=b@x.com RP_TEST_PASSWORD=... npm run test:api   # test với server thật
```

| File | Nội dung |
|---|---|
| `evaluator.test.js` | Duyệt **toàn bộ 2.598.960 bộ 5 lá** và so với tần suất chuẩn; so chéo 40.000 cặp tay 7 lá với một bộ đánh giá độc lập; các ca so bài hiểm (wheel, 3 đôi, kicker, board thắng…) |
| `rules.test.js` | Luật theo kịch bản với bộ bài dựng sẵn: thứ tự hành động (heads-up / nhiều người), min-raise, all-in thiếu không mở lại raise, BB all-in thiếu, ante, side pot, dead money, chip lẻ khi chia pot, cược không ai theo, lật/úp bài, hết giờ, ngồi ngoài, rời bàn mọi thời điểm, xếp hạng, rematch, tăng blind |
| `fuzz.test.js` | Hàng trăm bàn ngẫu nhiên (2–9 người, stack/blind/ante/tăng blind ngẫu nhiên), hành động ngẫu nhiên kể cả **hành động sai**, rời bàn, ngồi ngoài, vào muộn, nhảy thời gian. Sau **mỗi bước** kiểm tra: bảo toàn chip, không trùng lá, không kẹt ván, state JSON round-trip, view không lộ bài |
| `engine.test.js` | Luồng match cơ bản |
| `client.test.js` | Vẽ đủ 52 lá (SVG hợp lệ, đúng số pip), chip, tên lá & bộ bài tiếng Việt |
| `api.integration.test.js` | Server thật: xác thực, validate, ngồi ghế, riêng tư bài, gửi trùng song song, hết giờ phía server, **RLS** (không đọc được bộ bài, không sửa được dữ liệu, không gọi được hàm nội bộ), chat, rematch, bàn có mật khẩu |
