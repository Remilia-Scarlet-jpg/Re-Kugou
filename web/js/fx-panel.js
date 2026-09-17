/**
 * 视觉 DIY 控制台:声明式注册表 → 渲染到右抽屉「视觉」标签页。
 *
 * 全部控件经 setFx 写入 fx.js(唯一写入口);预设槽 = 4 个命名快照
 * (vmp.fxpresets.v1),应用时逐字段归一化,天然兼容未来新增参数。
 * 面板结构随功能阶段增长:FX_GROUPS 里追加分组即可(运镜/壁纸/桌词)。
 */
import { FX_DEFAULTS, FX_SPECS, getFx, setFx, applyFxSnapshot, resetFx, getFxSnapshot, subscribe } from './fx.js';

const PRESET_KEY = 'vmp.fxpresets.v1';
const COLLAPSE_KEY = 'vmp.fxcollapsed.v1';
const SLOT_COUNT = 4;

/** 已收缩的分组标题集合(场景/运镜/壁纸/桌词),持久化在 vmp.fxcollapsed.v1 */
function loadCollapsed() {
  try {
    const a = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]');
    return new Set(Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(set) {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set]));
  } catch {
    /* 存储满等异常忽略 */
  }
}

/** 面板分组注册表(标签页→组→参数键) */
const FX_GROUPS = [
  {
    title: '场景',
    items: ['sceneEnabled', 'orbScale', 'reactScale', 'orbSize', 'starSize', 'starSpeed', 'ringSpeed', 'shockEnabled'],
  },
  {
    title: '运镜',
    items: ['cineEnabled', 'cineShake', 'cineIdle', 'cineKick', 'cinePunch', 'fovBase'],
  },
  {
    title: '壁纸',
    items: ['bgOpacity', 'bgZoom', 'bgBlur', 'bgVolume', 'bgDuck'],
  },
  {
    title: '桌词',
    items: ['dlFontSize', 'dlOpacity'],
  },
];

const LABELS = {
  sceneEnabled: '粒子效果',
  orbScale: '球体大小', reactScale: '律动强度', orbSize: '球体粒子', starSize: '星尘大小',
  starSpeed: '星场转速', ringSpeed: '光环转速', shockEnabled: '节拍冲击波',
  cineEnabled: '运镜开关', cineShake: '运镜幅度', cineIdle: '闲时漂移', cineKick: '节拍冲击',
  cinePunch: '镜头脉冲', fovBase: '基础视角',
  bgOpacity: '壁纸透明度', bgZoom: '壁纸缩放', bgBlur: '壁纸模糊',
  bgVolume: '壁纸音量', bgDuck: '音乐时静音',
  dlFontSize: '桌词字号', dlOpacity: '桌词透明度',
};

const fmt = (v) => String(Math.round(v * 100) / 100);

const paintInput = (inp) => {
  const pct = ((Number(inp.value) - Number(inp.min)) / (Number(inp.max) - Number(inp.min))) * 100;
  inp.style.setProperty('--fill', `${pct}%`);
};

// ---------- 参数控件 ----------
function renderItem(key) {
  const def = FX_DEFAULTS[key];
  const item = document.createElement('div');
  item.className = 'fx-item fx-param' + (typeof def === 'boolean' ? ' fx-toggle-item' : '');

  if (typeof def === 'boolean') {
    const label = document.createElement('span');
    label.className = 'fx-label';
    label.textContent = LABELS[key];
    const btn = document.createElement('button');
    btn.className = 'chip fx-toggle';
    btn.id = `fx-${key}`;
    btn.title = `开关:${LABELS[key]}`;
    btn.addEventListener('click', () => setFx(key, !getFx()[key]));
    item.append(label, btn);
    return item;
  }

  const [min, max, step] = FX_SPECS[key];
  const head = document.createElement('div');
  head.className = 'fx-item-head';
  const label = document.createElement('span');
  label.className = 'fx-label';
  label.textContent = LABELS[key];
  const val = document.createElement('span');
  val.className = 'fx-val';
  head.append(label, val);

  const inp = document.createElement('input');
  inp.type = 'range';
  inp.className = 'fx-range';
  inp.id = `fx-${key}`;
  inp.min = String(min);
  inp.max = String(max);
  inp.step = String(step);
  inp.addEventListener('input', () => {
    setFx(key, Number(inp.value));
    paintInput(inp);
    val.textContent = fmt(getFx()[key]);
  });

  item.append(head, inp);
  return item;
}

function renderGroup(group, collapsedSet) {
  const g = document.createElement('div');
  g.className = 'fx-group';
  const title = document.createElement('div');
  title.className = 'fx-group-title fx-group-head';
  title.textContent = group.title;
  const body = document.createElement('div');
  body.className = 'fx-group-body';
  for (const key of group.items) body.appendChild(renderItem(key));
  // 收缩状态持久化(vmp.fxcollapsed.v1):刷新/重开面板保持用户的折叠习惯
  const collapsed = collapsedSet.has(group.title);
  g.classList.toggle('collapsed', collapsed);
  const paintHint = (isCollapsed) => {
    title.title = `点击${isCollapsed ? '展开' : '收起'}「${group.title}」`;
    title.setAttribute('aria-expanded', String(!isCollapsed));
  };
  paintHint(collapsed);
  title.addEventListener('click', () => {
    const now = g.classList.toggle('collapsed');
    if (now) collapsedSet.add(group.title);
    else collapsedSet.delete(group.title);
    paintHint(now);
    saveCollapsed(collapsedSet);
  });
  g.append(title, body);
  return g;
}

/** fx 外部变化(预设应用/重置等)→ 回写全部控件 */
function syncControls(rootEl) {
  const fx = getFx();
  rootEl.querySelectorAll('.fx-range').forEach((inp) => {
    const key = inp.id.slice(3);
    inp.value = String(fx[key]);
    paintInput(inp);
    const val = inp.closest('.fx-item')?.querySelector('.fx-val');
    if (val) val.textContent = fmt(fx[key]);
  });
  rootEl.querySelectorAll('.fx-toggle').forEach((btn) => {
    const key = btn.id.slice(3);
    const on = !!fx[key];
    btn.classList.toggle('active', on);
    btn.textContent = on ? '开' : '关';
  });
}

// ---------- 预设槽 ----------
function loadSlots() {
  try {
    const d = JSON.parse(localStorage.getItem(PRESET_KEY));
    if (d && Array.isArray(d.slots)) {
      return { slots: d.slots.slice(0, SLOT_COUNT).map(normalizeSlot) };
    }
  } catch {
    /* 损坏数据回退空槽 */
  }
  return { slots: Array.from({ length: SLOT_COUNT }, () => ({ name: '', snapshot: null, savedAt: 0 })) };
}

function normalizeSlot(s) {
  return {
    name: typeof s?.name === 'string' ? s.name : '',
    snapshot: s?.snapshot && typeof s.snapshot === 'object' ? s.snapshot : null,
    savedAt: typeof s?.savedAt === 'number' ? s.savedAt : 0,
  };
}

function saveSlots(d) {
  try {
    localStorage.setItem(PRESET_KEY, JSON.stringify(d));
  } catch {
    /* 存储满等异常忽略 */
  }
}

const fmtSavedAt = (ts) => {
  if (!ts) return '空槽';
  const d = new Date(ts);
  const pad = (x) => String(x).padStart(2, '0');
  return `已保存 ${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function renderSlot(i, slot) {
  const box = document.createElement('div');
  box.className = 'fx-slot';

  const row = document.createElement('div');
  row.className = 'fx-slot-row';
  const nameInp = document.createElement('input');
  nameInp.className = 'fx-slot-name';
  nameInp.id = `fx-slot-name-${i}`;
  nameInp.type = 'text';
  nameInp.maxLength = 12;
  nameInp.placeholder = `预设 ${i + 1}`;
  nameInp.value = slot.name;

  const mkBtn = (id, label, onClick) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.id = id;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  };

  const hint = document.createElement('div');
  hint.className = 'fx-slot-hint';
  hint.id = `fx-slot-hint-${i}`;
  hint.textContent = fmtSavedAt(slot.savedAt);

  row.append(
    nameInp,
    mkBtn(`fx-slot-save-${i}`, '保存', () => {
      const name = nameInp.value.trim() || `预设 ${i + 1}`;
      nameInp.value = name;
      const slots = loadSlots();
      slots.slots[i] = { name, snapshot: getFxSnapshot(), savedAt: Date.now() };
      saveSlots(slots);
      hint.textContent = fmtSavedAt(Date.now());
    }),
    mkBtn(`fx-slot-apply-${i}`, '应用', () => {
      const slot = loadSlots().slots[i];
      if (!slot.snapshot) {
        hint.textContent = '空槽,先保存';
        return;
      }
      applyFxSnapshot(slot.snapshot);
    }),
    mkBtn(`fx-slot-clear-${i}`, '✕', () => {
      const slots = loadSlots();
      slots.slots[i] = { name: '', snapshot: null, savedAt: 0 };
      saveSlots(slots);
      nameInp.value = '';
      hint.textContent = fmtSavedAt(0);
    })
  );
  box.append(row, hint);
  return box;
}

// ---------- 入口 ----------
export function initFxPanel(rootEl) {
  if (!rootEl) return;
  rootEl.innerHTML = `
    <div class="fx-note" id="fx-note"></div>
    <div class="fx-groups"></div>
    <div class="fx-group">
      <div class="fx-group-title">预设槽</div>
      <div class="fx-slots" id="fx-slots"></div>
    </div>
    <div class="fx-reset-row"><button class="chip" id="fx-reset" title="全部参数恢复默认">恢复默认</button></div>`;

  const note = rootEl.querySelector('#fx-note');
  note.textContent =
    window.__APP_STARFIELD_3D === '1'
      ? '参数即时生效 · 粒子计数不可调(需重建几何体)'
      : '⚠ 2D 回退模式:场景参数仅 3D 视觉生效';

  const groupsEl = rootEl.querySelector('.fx-groups');
  const collapsedSet = loadCollapsed();
  FX_GROUPS.forEach((g) => groupsEl.appendChild(renderGroup(g, collapsedSet)));
  window.__APP_FX_COLLAPSE = collapsedSet; // 测试标记(与真实点击同路径)

  const slotsEl = rootEl.querySelector('#fx-slots');
  const slots = loadSlots();
  for (let i = 0; i < SLOT_COUNT; i++) slotsEl.appendChild(renderSlot(i, slots.slots[i]));

  rootEl.querySelector('#fx-reset').addEventListener('click', resetFx);

  subscribe(() => syncControls(rootEl));
  syncControls(rootEl);
}
