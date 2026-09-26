// Đọc tên lá bài bằng tiếng Việt qua Web Speech API.
const RANK_VI = {
  A: 'Át', K: 'Già', Q: 'Đầm', J: 'Bồi', T: 'Mười',
  9: 'Chín', 8: 'Tám', 7: 'Bảy', 6: 'Sáu', 5: 'Năm', 4: 'Bốn', 3: 'Ba', 2: 'Hai',
};
const RANK_BY_VALUE = { 14: 'Át', 13: 'Già', 12: 'Đầm', 11: 'Bồi', 10: 'Mười', 9: 'Chín', 8: 'Tám', 7: 'Bảy', 6: 'Sáu', 5: 'Năm', 4: 'Bốn', 3: 'Ba', 2: 'Hai' };
const SUIT_VI = { s: 'bích', h: 'cơ', d: 'rô', c: 'chuồn' };

export const cardNameVi = (c) => `${RANK_VI[c[0]]} ${SUIT_VI[c[1]]}`;

export function handNameVi(hand) {
  if (!hand) return '';
  const r = (i) => RANK_BY_VALUE[hand.ranks[i]] || '';
  switch (hand.category) {
    case 8: return hand.ranks[0] === 14 ? 'Thùng phá sảnh hoàng gia' : `Thùng phá sảnh đến ${r(0)}`;
    case 7: return `Tứ quý ${r(0)}`;
    case 6: return `Cù lũ ${r(0)} đầy ${r(1)}`;
    case 5: return `Thùng, ${r(0)} cao nhất`;
    case 4: return `Sảnh đến ${r(0)}`;
    case 3: return `Sám cô ${r(0)}`;
    case 2: return `Hai đôi, ${r(0)} và ${r(1)}`;
    case 1: return `Đôi ${r(0)}`;
    default: return `Mậu thầu, ${r(0)} cao nhất`;
  }
}

let viVoice = null;
const hasSpeech = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

function pickVoice() {
  if (!hasSpeech()) return null;
  const voices = speechSynthesis.getVoices();
  viVoice = voices.find((v) => /^vi/i.test(v.lang) && /natural|online|google/i.test(v.name))
    || voices.find((v) => /^vi/i.test(v.lang)) || null;
  return viVoice;
}
if (hasSpeech()) {
  pickVoice();
  speechSynthesis.addEventListener?.('voiceschanged', pickVoice);
}

export const voiceSupported = hasSpeech;
export const hasVietnameseVoice = () => !!(viVoice || pickVoice());

export function speak(text, rate = 1) {
  if (!voiceSupported()) return false;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'vi-VN';
  u.rate = rate;
  const v = viVoice || pickVoice();
  if (v) u.voice = v;
  speechSynthesis.speak(u);
  return true;
}

/** Câu đọc bài trên tay (chỉ 2 lá tẩy). */
export function holeCardsSpeech(myCards) {
  const cards = (myCards || []).filter(Boolean);
  return cards.length ? `${cards.map(cardNameVi).join(', ')}.` : 'Bạn chưa có bài.';
}
