// 品牌资源生成器：node scripts/generate-brand-assets.mjs
// 母版 SVG 存于 design/brand/svg/， rasterize 到 android res / src assets / design masters。
// 依赖 sharp（npm install --no-save sharp）。
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SVG_DIR = path.join(ROOT, 'design/brand/svg');
fs.mkdirSync(SVG_DIR, { recursive: true });

const INK = '#0B0B0F';

// 品牌标记「光圈播放标」：圆角六边形光圈 + 六道螺旋叶隙 + 播放三角负空间
const HEX = 'M -45,-324 Q 0,-350 45,-324 L 258.1,-201 Q 303.1,-175 303.1,-123 L 303.1,123 Q 303.1,175 258.1,201 L 45,324 Q 0,350 -45,324 L -258.1,201 Q -303.1,175 -303.1,123 L -303.1,-123 Q -303.1,-175 -258.1,-201 L -45,-324 Z';
const SLITS = [
  [0, -357, 110.4, -122.7],
  [309.2, -178.5, 161.4, 34.4],
  [309.2, 178.5, 51, 156.9],
  [0, 357, -110.4, 122.7],
  [-309.2, 178.5, -161.4, -34.4],
  [-309.2, -178.5, -51, -156.9],
];
const FACETS = [
  [0, -350, 303.1, -175],
  [303.1, -175, 303.1, 175],
  [303.1, 175, 0, 350],
  [0, 350, -303.1, 175],
  [-303.1, 175, -303.1, -175],
  [-303.1, -175, 0, -350],
];
// 播放三角负空间（stroke round join 产生圆角）
const PLAY = '-78,-92 -78,92 82,0';

function defs(id) {
  return `
  <defs>
    <linearGradient id="${id}-body" gradientUnits="userSpaceOnUse" x1="-303" y1="-350" x2="303" y2="350">
      <stop offset="0" stop-color="#FFD873"/>
      <stop offset="0.45" stop-color="#FF9E2C"/>
      <stop offset="1" stop-color="#F4511E"/>
    </linearGradient>
    <linearGradient id="${id}-rim" gradientUnits="userSpaceOnUse" x1="0" y1="-350" x2="0" y2="160">
      <stop offset="0" stop-color="#FFF3D0" stop-opacity="0.95"/>
      <stop offset="0.55" stop-color="#FFD98A" stop-opacity="0.25"/>
      <stop offset="1" stop-color="#FFD98A" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="${id}-shade" gradientUnits="userSpaceOnUse" x1="0" y1="80" x2="0" y2="350">
      <stop offset="0" stop-color="#8A2908" stop-opacity="0"/>
      <stop offset="1" stop-color="#7A2406" stop-opacity="0.35"/>
    </linearGradient>
    <radialGradient id="${id}-gloss" gradientUnits="userSpaceOnUse" cx="-120" cy="-200" r="210">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.3"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="${id}-clip"><path d="${HEX}"/></clipPath>
    <mask id="${id}-hole">
      <rect x="-600" y="-600" width="1200" height="1200" fill="#fff"/>
      ${SLITS.map(([x1, y1, x2, y2]) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#000" stroke-width="16" stroke-linecap="round"/>`).join('\n      ')}
      <polygon points="${PLAY}" fill="#000" stroke="#000" stroke-width="40" stroke-linejoin="round"/>
    </mask>
  </defs>`;
}

// scale: 标记相对 1024 设计空间的缩放；cx/cy 为放置中心
function mark(id, cx, cy, s) {
  return `
  <g transform="translate(${cx} ${cy}) scale(${s})" mask="url(#${id}-hole)">
    <path d="${HEX}" fill="url(#${id}-body)"/>
    ${FACETS.map(([x1, y1, x2, y2], i) => `<polygon points="0,0 ${x1},${y1} ${x2},${y2}" fill="${i % 2 ? '#000000' : '#FFFFFF'}" opacity="${i % 2 ? 0.05 : 0.06}"/>`).join('\n    ')}
    <path d="${HEX}" fill="url(#${id}-shade)"/>
    <ellipse cx="-120" cy="-200" rx="200" ry="150" fill="url(#${id}-gloss)" clip-path="url(#${id}-clip)"/>
    <path d="${HEX}" fill="none" stroke="url(#${id}-rim)" stroke-width="6"/>
  </g>`;
}

function tileBg(id, shape) {
  return `
  <defs>
    <radialGradient id="${id}-bg" gradientUnits="userSpaceOnUse" cx="512" cy="450" r="680">
      <stop offset="0" stop-color="#2B1C08"/>
      <stop offset="0.55" stop-color="#14110B"/>
      <stop offset="1" stop-color="${INK}"/>
    </radialGradient>
    <linearGradient id="${id}-sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.05"/>
      <stop offset="0.5" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
  </defs>
  ${shape === 'round'
    ? `<circle cx="512" cy="512" r="512" fill="url(#${id}-bg)"/>`
    : `<rect width="1024" height="1024" rx="232" fill="url(#${id}-bg)"/>`}
  ${shape === 'round'
    ? `<circle cx="512" cy="512" r="512" fill="url(#${id}-sheen)"/>`
    : `<rect width="1024" height="1024" rx="232" fill="url(#${id}-sheen)"/>`}`;
}

function iconSvg(kind, px) {
  const id = `ic-${kind}`;
  const inner = kind === 'foreground'
    ? mark(id, 512, 512, 0.85)
    : tileBg(id, kind === 'round' ? 'round' : 'square') + mark(id, 512, 512, kind === 'round' ? 1.0 : 0.95);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 1024 1024">${defs(id)}${inner}</svg>`;
}

function splashSvg(w, h, land) {
  const id = 'sp';
  const u = land ? h / 1280 : w / 1280;
  const mx = land ? w / 2 - 300 * u : w / 2;
  const my = land ? h / 2 : h * 0.415;
  const s = land ? (300 * u) / 700 : (h * 0.185) / 700;
  const wordY = land ? h / 2 + 6 * u : my + (700 * s) / 2 + h * 0.085;
  const tagY = land ? h / 2 + 92 * u : wordY + h * 0.048;
  const wordX = land ? w / 2 - 110 * u : w / 2;
  const anchor = land ? 'start' : 'middle';
  const wordSize = Math.round(96 * u);
  const tagSize = Math.round(40 * u);
  const perfY = h - Math.round(h * 0.05);
  const perfs = [-2, -1, 0, 1, 2]
    .map(i => `<rect x="${w / 2 + i * 34 * u - 7 * u}" y="${perfY}" width="${14 * u}" height="${20 * u}" rx="${4 * u}"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <radialGradient id="${id}-glow" gradientUnits="userSpaceOnUse" cx="${mx}" cy="${my}" r="${Math.max(w, h) * 0.62}">
      <stop offset="0" stop-color="#241703"/>
      <stop offset="0.45" stop-color="#120E08"/>
      <stop offset="1" stop-color="${INK}"/>
    </radialGradient>
    <radialGradient id="${id}-vig" gradientUnits="userSpaceOnUse" cx="${w / 2}" cy="${h / 2}" r="${Math.max(w, h) * 0.75}">
      <stop offset="0.55" stop-color="#000000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.42"/>
    </radialGradient>
    <filter id="${id}-grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.035 0"/></filter>
    ${defs(id).replace('<defs>', '').replace('</defs>', '')}
  </defs>
  <rect width="${w}" height="${h}" fill="url(#${id}-glow)"/>
  <rect width="${w}" height="${h}" filter="url(#${id}-grain)" opacity="0.55"/>
  ${mark(id, mx, my, s)}
  <text x="${wordX}" y="${wordY}" text-anchor="${anchor}" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-weight="600" font-size="${wordSize}" letter-spacing="${Math.round(u)}" fill="#F2ECDF">PeanutMov</text>
  <text x="${wordX}" y="${tagY}" text-anchor="${anchor}" font-family="Microsoft YaHei, Segoe UI, sans-serif" font-weight="400" font-size="${tagSize}" letter-spacing="${Math.round((land ? 14 : 18) * u)}" fill="#8F887A">好戏开场</text>
  <g fill="#F5A623" opacity="0.22">${perfs}</g>
  <rect width="${w}" height="${h}" fill="url(#${id}-vig)"/>
</svg>`;
}

async function render(svg, file, w, h) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp(Buffer.from(svg)).png().toFile(file);
  console.log(`${path.relative(ROOT, file)}  ${w}x${h}`);
}

const RES = path.join(ROOT, 'android/app/src/main/res');
const densities = [
  ['mdpi', 48, 108],
  ['hdpi', 72, 162],
  ['xhdpi', 96, 216],
  ['xxhdpi', 144, 324],
  ['xxxhdpi', 192, 432],
];

fs.writeFileSync(path.join(SVG_DIR, 'icon-master.svg'), iconSvg('square', 1024));
fs.writeFileSync(path.join(SVG_DIR, 'icon-round.svg'), iconSvg('round', 1024));
fs.writeFileSync(path.join(SVG_DIR, 'icon-foreground.svg'), iconSvg('foreground', 1024));
fs.writeFileSync(path.join(SVG_DIR, 'splash-port.svg'), splashSvg(1280, 1920, false));
fs.writeFileSync(path.join(SVG_DIR, 'splash-land.svg'), splashSvg(1920, 1280, true));

await render(iconSvg('square', 1024), path.join(ROOT, 'design/brand/app-icon-master.png'), 1024, 1024);
await render(iconSvg('foreground', 1024), path.join(ROOT, 'design/brand/ic_launcher_foreground-master.png'), 1024, 1024);
const tightMark = await sharp(Buffer.from(iconSvg('foreground', 1024))).trim().resize(464, 464, { fit: 'inside' }).extend({ top: 24, bottom: 24, left: 24, right: 24, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
fs.writeFileSync(path.join(ROOT, 'design/brand/logo-mark.png'), tightMark);
fs.writeFileSync(path.join(ROOT, 'src/assets/brand/logo-mark.png'), tightMark);
console.log('design/brand/logo-mark.png + src/assets/brand/logo-mark.png  512x512');
await render(splashSvg(1280, 1920, false), path.join(ROOT, 'design/brand/splash-port-master.png'), 1280, 1920);
await render(splashSvg(1920, 1280, true), path.join(ROOT, 'design/brand/splash-land-master.png'), 1920, 1280);

for (const [d, launcher, fg] of densities) {
  await render(iconSvg('square', launcher), path.join(RES, `mipmap-${d}/ic_launcher.png`), launcher, launcher);
  await render(iconSvg('round', launcher), path.join(RES, `mipmap-${d}/ic_launcher_round.png`), launcher, launcher);
  await render(iconSvg('foreground', fg), path.join(RES, `mipmap-${d}/ic_launcher_foreground.png`), fg, fg);
}

// 9:19.5 手机长宽比：window background 位图会被拉伸铺满窗口，比例必须贴近真机否则标记变形
const ports = [['mdpi', 360, 780], ['hdpi', 540, 1170], ['xhdpi', 720, 1560], ['xxhdpi', 1080, 2340], ['xxxhdpi', 1440, 3120]];
const lands = [['mdpi', 780, 360], ['hdpi', 1170, 540], ['xhdpi', 1560, 720], ['xxhdpi', 2340, 1080], ['xxxhdpi', 3120, 1440]];
for (const [d, w, h] of ports) await render(splashSvg(w, h, false), path.join(RES, `drawable-port-${d}/splash.png`), w, h);
for (const [d, w, h] of lands) await render(splashSvg(w, h, true), path.join(RES, `drawable-land-${d}/splash.png`), w, h);
await render(splashSvg(1080, 2340, false), path.join(RES, 'drawable/splash.png'), 1080, 2340);

// 应用内 logo：透明底纯标记
const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="PeanutMov">${defs('lg')}${mark('lg', 512, 512, 0.95)}</svg>`;
fs.writeFileSync(path.join(ROOT, 'src/assets/logo.svg'), logoSvg);
fs.writeFileSync(path.join(SVG_DIR, 'logo.svg'), logoSvg);
console.log('src/assets/logo.svg + design/brand/svg/logo.svg');