// Lá bài & chip vẽ bằng SVG — sắc nét ở mọi kích thước, không cần file ảnh.
let uid = 0;

const SUIT_PATH = {
  s: '<path d="M50 3C59 19 96 38 96 62c0 14-11 24-24 24-9 0-15-4-19-10 1 9 5 16 13 21H34c8-5 12-12 13-21-4 6-10 10-19 10C15 86 4 76 4 62 4 38 41 19 50 3z"/>',
  h: '<path d="M50 93C22 71 3 53 3 31 3 16 14 5 28 5c10 0 18 6 22 15 4-9 12-15 22-15 14 0 25 11 25 26 0 22-19 40-47 62z"/>',
  d: '<path d="M50 2C61 21 76 37 94 50 76 63 61 79 50 98 39 79 24 63 6 50 24 37 39 21 50 2z"/>',
  c: '<circle cx="50" cy="27" r="21"/><circle cx="26" cy="57" r="21"/><circle cx="74" cy="57" r="21"/><path d="M42 44h16v14H42z"/><path d="M45 58c0 18-6 30-16 38h42c-10-8-16-20-16-38z"/>',
};

const RANK_LABEL = { T: '10', J: 'J', Q: 'Q', K: 'K', A: 'A' };

export function suitColor(suit, fourColor) {
  if (fourColor) return { s: '#17171c', h: '#c1121f', d: '#1f5fbf', c: '#1f7a3a' }[suit];
  return suit === 'h' || suit === 'd' ? '#c1121f' : '#17171c';
}

function pip(suit, cx, cy, size, flip = false) {
  const k = size / 100;
  const t = `translate(${cx - size / 2} ${cy - size / 2}) scale(${k})`;
  return `<g transform="${flip ? `rotate(180 ${cx} ${cy}) ` : ''}${t}">${SUIT_PATH[suit]}</g>`;
}

// Bố cục pip cho lá 2–10: [cột, hàng 0..1]
const L = 74, C = 120, R = 166;
const LAYOUT = {
  2: [[C, 0], [C, 1]],
  3: [[C, 0], [C, 0.5], [C, 1]],
  4: [[L, 0], [R, 0], [L, 1], [R, 1]],
  5: [[L, 0], [R, 0], [C, 0.5], [L, 1], [R, 1]],
  6: [[L, 0], [R, 0], [L, 0.5], [R, 0.5], [L, 1], [R, 1]],
  7: [[L, 0], [R, 0], [C, 0.25], [L, 0.5], [R, 0.5], [L, 1], [R, 1]],
  8: [[L, 0], [R, 0], [C, 0.25], [L, 0.5], [R, 0.5], [C, 0.75], [L, 1], [R, 1]],
  9: [[L, 0], [R, 0], [L, 1 / 3], [R, 1 / 3], [C, 0.5], [L, 2 / 3], [R, 2 / 3], [L, 1], [R, 1]],
  10: [[L, 0], [R, 0], [C, 1 / 6], [L, 1 / 3], [R, 1 / 3], [L, 2 / 3], [R, 2 / 3], [C, 5 / 6], [L, 1], [R, 1]],
};

function corner(label, suit) {
  const small = label === '10' ? 34 : 40;
  return `<text x="27" y="48" text-anchor="middle" font-family="'Playfair Display', Georgia, serif" font-weight="900" font-size="${small}" letter-spacing="${label === '10' ? -3 : 0}">${label}</text>${pip(suit, 27, 70, 24)}`;
}

// Hình nhân vật J/Q/K (nửa trên; nửa dưới lật đối xứng như lá bài thật)
function courtHalf(rank, suit, color, id) {
  const skin = '#f5d6b4';
  const gold = `url(#gold${id})`;
  const robe = `url(#robe${id})`;
  const hats = {
    K: `<path d="M97 86 L100 60 L110 74 L120 54 L130 74 L140 60 L143 86 Z" fill="${gold}" stroke="#7a5a12" stroke-width="1.5"/>
        <circle cx="120" cy="66" r="3.5" fill="${color}"/><circle cx="104" cy="76" r="2.5" fill="#1f5fbf"/><circle cx="136" cy="76" r="2.5" fill="#1f5fbf"/>
        <path d="M100 118 Q120 146 140 118 Q134 132 120 136 Q106 132 100 118Z" fill="#e8e2d6" stroke="#9c9486" stroke-width="1"/>`,
    Q: `<path d="M94 104 Q92 76 120 72 Q148 76 146 104 Q148 124 138 132 L136 104 Q134 88 120 86 Q106 88 104 104 L102 132 Q92 124 94 104Z" fill="#6b3a1e"/>
        <path d="M101 84 Q120 66 139 84 L135 88 Q120 76 105 88Z" fill="${gold}" stroke="#7a5a12" stroke-width="1.2"/>
        <circle cx="120" cy="74" r="3" fill="${color}"/><circle cx="110" cy="79" r="2" fill="#fff"/><circle cx="130" cy="79" r="2" fill="#fff"/>`,
    J: `<path d="M96 90 Q98 68 122 68 Q146 70 146 90 Z" fill="${robe}" stroke="#7a5a12" stroke-width="1.2"/>
        <path d="M96 90 H146" stroke="${gold}" stroke-width="4"/>
        <path d="M140 72 Q158 52 170 50 Q160 62 146 80Z" fill="${gold}" stroke="#7a5a12" stroke-width="1"/>
        <path d="M98 94 Q96 110 102 118" fill="none" stroke="#6b3a1e" stroke-width="5" stroke-linecap="round"/>
        <path d="M142 94 Q144 110 138 118" fill="none" stroke="#6b3a1e" stroke-width="5" stroke-linecap="round"/>`,
  };
  return `
    <path d="M58 168 Q62 128 120 122 Q178 128 182 168 Z" fill="${robe}"/>
    <path d="M58 168 Q62 128 120 122 Q178 128 182 168" fill="none" stroke="${gold}" stroke-width="3"/>
    <path d="M78 168 Q84 140 104 134 M162 168 Q156 140 136 134" fill="none" stroke="${gold}" stroke-width="2" stroke-dasharray="4 3"/>
    <path d="M100 128 Q120 146 140 128 L136 138 Q120 152 104 138Z" fill="${gold}" stroke="#7a5a12" stroke-width="1"/>
    <ellipse cx="120" cy="104" rx="17" ry="20" fill="${skin}" stroke="#b98d62" stroke-width="1"/>
    <circle cx="113" cy="101" r="1.8" fill="#2b1d12"/><circle cx="127" cy="101" r="1.8" fill="#2b1d12"/>
    <path d="M114 113 Q120 117 126 113" fill="none" stroke="#a0463a" stroke-width="1.6" stroke-linecap="round"/>
    ${hats[rank]}
    ${pip(suit, 72, 70, 22)}
    <g fill="${gold}" opacity="0.9">${pip('d', 168, 150, 10)}${pip('d', 72, 150, 10)}</g>`;
}

export function cardFace(card, { fourColor = false } = {}) {
  const id = ++uid;
  const rank = card[0], suit = card[1];
  const label = RANK_LABEL[rank] || rank;
  const color = suitColor(suit, fourColor);
  let center = '';

  if (rank === 'A') {
    center = suit === 's'
      ? `<circle cx="120" cy="168" r="62" fill="none" stroke="url(#gold${id})" stroke-width="3"/>
         <circle cx="120" cy="168" r="54" fill="none" stroke="url(#gold${id})" stroke-width="1" stroke-dasharray="3 4"/>
         ${pip('s', 120, 166, 92)}`
      : pip(suit, 120, 168, 100);
  } else if ('JQK'.includes(rank)) {
    center = `
      <rect x="48" y="44" width="144" height="248" rx="8" fill="url(#tint${id})" stroke="url(#gold${id})" stroke-width="3"/>
      <rect x="54" y="50" width="132" height="236" rx="5" fill="none" stroke="${color}" stroke-opacity=".35" stroke-width="1"/>
      <clipPath id="clip${id}"><rect x="54" y="50" width="132" height="236" rx="5"/></clipPath>
      <g clip-path="url(#clip${id})">
        <g>${courtHalf(rank, suit, color, id)}</g>
        <g transform="rotate(180 120 168)">${courtHalf(rank, suit, color, id)}</g>
        <path d="M54 176 L186 160" stroke="url(#gold${id})" stroke-width="2"/>
      </g>`;
  } else {
    const n = Number(label);
    const size = n >= 9 ? 40 : 44;
    center = LAYOUT[n].map(([x, r]) => pip(suit, x, 72 + r * 192, size, r > 0.5)).join('');
  }

  return `<svg class="card-svg" viewBox="0 0 240 336" xmlns="http://www.w3.org/2000/svg" aria-label="${label}${suit}">
    <defs>
      <linearGradient id="bg${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fffef9"/><stop offset="1" stop-color="#f1e9d6"/></linearGradient>
      <linearGradient id="gold${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f7e08a"/><stop offset=".5" stop-color="#c9a13b"/><stop offset="1" stop-color="#8a6516"/></linearGradient>
      <linearGradient id="robe${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="${color}" stop-opacity=".75"/></linearGradient>
      <linearGradient id="tint${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fffaf0"/><stop offset="1" stop-color="#f3e6c8"/></linearGradient>
    </defs>
    <rect x="1" y="1" width="238" height="334" rx="16" fill="url(#bg${id})" stroke="#cdbf9f" stroke-width="2"/>
    <rect x="9" y="9" width="222" height="318" rx="11" fill="none" stroke="#e2d6b8" stroke-width="1"/>
    <g fill="${color}">
      ${corner(label, suit)}
      <g transform="rotate(180 120 168)">${corner(label, suit)}</g>
      ${center}
    </g>
  </svg>`;
}

const BACKS = {
  red: ['#8e1328', '#4a0714'],
  blue: ['#123b8a', '#081a45'],
  black: ['#2a2a33', '#0c0c10'],
};

export function cardBack(theme = 'red') {
  const id = ++uid;
  const [a, b] = BACKS[theme] || BACKS.red;
  return `<svg class="card-svg" viewBox="0 0 240 336" xmlns="http://www.w3.org/2000/svg" aria-label="Lá úp">
    <defs>
      <linearGradient id="bk${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>
      <linearGradient id="gb${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f7e08a"/><stop offset=".5" stop-color="#c9a13b"/><stop offset="1" stop-color="#8a6516"/></linearGradient>
      <pattern id="pt${id}" width="20" height="20" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="20" height="20" fill="none"/>
        <path d="M0 10H20M10 0V20" stroke="#fff" stroke-opacity=".12" stroke-width="1.2"/>
        <circle cx="10" cy="10" r="2.2" fill="#f7e08a" fill-opacity=".35"/>
      </pattern>
    </defs>
    <rect x="1" y="1" width="238" height="334" rx="16" fill="#fbf7ee" stroke="#cdbf9f" stroke-width="2"/>
    <rect x="12" y="12" width="216" height="312" rx="10" fill="url(#bk${id})"/>
    <rect x="12" y="12" width="216" height="312" rx="10" fill="url(#pt${id})"/>
    <rect x="20" y="20" width="200" height="296" rx="7" fill="none" stroke="url(#gb${id})" stroke-width="2.5"/>
    <circle cx="120" cy="168" r="44" fill="${b}" stroke="url(#gb${id})" stroke-width="3"/>
    <circle cx="120" cy="168" r="36" fill="none" stroke="url(#gb${id})" stroke-width="1" stroke-dasharray="2 3"/>
    <g fill="url(#gb${id})">${pip('s', 120, 160, 40)}</g>
    <text x="120" y="199" text-anchor="middle" font-family="'Playfair Display', Georgia, serif" font-weight="900" font-size="15" fill="url(#gb${id})" letter-spacing="3">RP</text>
  </svg>`;
}

// ───────────── chip ─────────────
const CHIP_COLORS = [
  [1_000_000, '#1c1c1c', '#e5c158'],
  [100_000, '#f28c28', '#fff'],
  [25_000, '#7e3fbf', '#fff'],
  [5_000, '#e0b21b', '#5a3d00'],
  [1_000, '#1b1b1b', '#fff'],
  [500, '#6b2fb5', '#fff'],
  [100, '#1a8f4d', '#fff'],
  [25, '#1f5fbf', '#fff'],
  [5, '#c1121f', '#fff'],
  [0, '#e8e3d8', '#1f5fbf'],
];

export function chipColor(amount) {
  return CHIP_COLORS.find(([min]) => amount >= min);
}

export function chipSVG(amount, size = 22) {
  const [, base, edge] = chipColor(amount);
  const stripes = Array.from({ length: 6 }, (_, i) =>
    `<rect x="46" y="2" width="8" height="15" rx="1.5" fill="${edge}" transform="rotate(${i * 60} 50 50)"/>`).join('');
  return `<svg class="chip-svg" width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true">
    <circle cx="50" cy="50" r="48" fill="${base}" stroke="rgba(0,0,0,.35)" stroke-width="2"/>
    ${stripes}
    <circle cx="50" cy="50" r="31" fill="none" stroke="${edge}" stroke-width="3" stroke-dasharray="6 5"/>
    <circle cx="50" cy="50" r="25" fill="${base}"/>
    <circle cx="50" cy="50" r="25" fill="url(#chipShine)" opacity=".5"/>
  </svg>`;
}

/** Chồng chip nhỏ (1–4 chip) theo độ lớn số tiền. */
export function chipStack(amount, size = 20) {
  const n = Math.max(1, Math.min(4, Math.ceil(Math.log10(Math.max(amount, 1)) - 0.5)));
  let html = '<span class="chip-stack">';
  for (let i = 0; i < n; i++) html += `<span class="chip-layer" style="--i:${i}">${chipSVG(amount, size)}</span>`;
  return html + '</span>';
}
