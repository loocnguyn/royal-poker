// Logic của thanh cược: 1 nút hành động đi theo thanh kéo.
// Giá trị thanh = TỔNG mức cược của mình ở vòng này (giống "raise to").
//   = callTo           → Check (nếu không ai cược) hoặc Call
//   > callTo           → Bet / Raise tới giá trị đó (tối thiểu minTo)
//   = maxTo            → All-in
// `legal` là object legalActions từ server.
export function betModel(legal, step = 1) {
  const L = legal;
  const callTo = L.myBet + L.toCall;        // tổng cược sau khi check/call
  const max = L.canRaise ? L.maxTo : callTo;
  const callIsAllIn = L.canCall && L.toCall >= L.maxTo - L.myBet;

  /** Đưa một giá trị bất kỳ về giá trị hợp lệ gần nhất. */
  function snap(x) {
    let v = Math.round(Number(x));
    if (!Number.isFinite(v)) v = callTo;
    v = Math.max(callTo, Math.min(max, v));
    // Khoảng (callTo, minTo) không hợp lệ → về mốc gần hơn
    if (v > callTo && v < L.minTo) v = v - callTo < (L.minTo - callTo) / 2 ? callTo : L.minTo;
    return v;
  }

  /** Mức theo tỉ lệ pot (½, ¾, 1…), làm tròn theo step. */
  function potFraction(f) {
    const potAfterCall = L.pot + L.toCall;
    const target = L.isBet ? L.pot * f : L.currentBet + potAfterCall * f;
    return snap(Math.round(target / step) * step);
  }

  /** Hành động gửi lên server cho giá trị v. */
  function action(v) {
    v = snap(v);
    if (v <= callTo) return L.canCheck ? { action: 'check' } : { action: 'call' };
    return { action: 'raise', amount: v };
  }

  /** Nhãn nút: { text, amount (null nếu Check), kind: 'call' | 'raise' }. */
  function label(v) {
    v = snap(v);
    if (v <= callTo) {
      if (L.canCheck) return { text: 'Check', amount: null, kind: 'call' };
      return { text: callIsAllIn ? 'All-in' : 'Call', amount: L.toCall, kind: 'call' };
    }
    return { text: v >= L.maxTo ? 'All-in' : L.isBet ? 'Bet' : 'Raise', amount: v, kind: 'raise' };
  }

  return { callTo, max, snap, potFraction, action, label, canSlide: L.canRaise && max > callTo };
}
