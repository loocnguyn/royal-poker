// Bộ bài & xáo bài. Chạy được trên cả Deno (Edge Function) lẫn Node (test).
export const RANKS = '23456789TJQKA';
export const SUITS = 'shdc'; // bích, cơ, rô, chuồn

export function newDeck() {
  const deck = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
  return deck;
}

// Số ngẫu nhiên an toàn trong [0, n) — rejection sampling để không lệch.
function randomInt(n) {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  return buf[0] % n;
}

// Fisher–Yates với CSPRNG.
export function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function rankValue(card) {
  return RANKS.indexOf(card[0]) + 2; // 2..14
}
