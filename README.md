# bStocks Live Leaderboard

Bảng xếp hạng "live" cho chiến dịch [bStocks Trading Competition](https://trustwallet.com/blog/campaigns/bstocks-trading-campaign) của Trust Wallet.
Bảng chính thức ([campaign.trustwallet.com/bstocks-leaderboard](https://campaign.trustwallet.com/bstocks-leaderboard)) chỉ cập nhật định kỳ; trang này tự tính lại điểm từ dữ liệu on-chain BSC mỗi khi bấm **Fetch**.

## Cách hoạt động

- `api/leaderboard.js` — Vercel Function, proxy API leaderboard của Trust Wallet (API này chặn CORS) để lấy danh sách ví. Cache 60s ở edge.
- `public/engine.js` — chạy trong trình duyệt: quét log `Transfer` của 21 bStock hợp lệ qua RPC công khai (publicnode), lọc swap đi qua route của Trust Wallet, lấy giá từ DexScreener rồi tính điểm.
- Dữ liệu đã quét được cache trong `localStorage`, nên lần Fetch đầu mất ~1–2 phút, các lần sau chỉ vài giây.
- Ví của người dùng chỉ lưu trên trình duyệt của họ.

Cách tính: điểm = volume USD × hệ số (1.5× cho ANTB, NVDAB; 1× cho bStock khác), từ 20/11/2026 02:00 UTC; bỏ swap bStock→bStock và giao dịch dưới $10. Đây là ước tính (lệch ~1–3% do dùng giá hiện tại), không phải kết quả chính thức.

## Chạy trên máy

```bash
npm run dev   # http://localhost:3000
```

## Deploy

Import repo vào Vercel, để Framework Preset = **Other**, không cần build command. Vercel tự phục vụ thư mục `public/` và hàm trong `api/`.
