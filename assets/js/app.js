/* ==========================================================================
   卫戍协议 · 盟约与特质数据库
   应用逻辑：状态管理 / 筛选 / 排序 / 渲染 / 弹窗 / 分享
   ========================================================================== */
(() => {
  "use strict";

  const DATA = window.SPDB;
  if (!DATA || !Array.isArray(DATA.seasons) || !DATA.seasons.length) {
    document.body.innerHTML =
      '<div style="padding:60px;font-family:sans-serif;color:#ccc">数据加载失败：未找到 data/seasons.js，请先运行 <code>python scripts/build_data.py</code>。</div>';
    return;
  }

  /* ---------- 常量 ---------- */
  const ROMAN = ["", "Ⅰ", "Ⅱ", "Ⅲ", "Ⅳ", "Ⅴ", "Ⅵ"];
  const RANK_COLOR = {
    1: "#9aa8a1",
    2: "#7fd7c4",
    3: "#5ac8fa",
    4: "#8f9dff",
    5: "#ffd93d",
    6: "#ff9f43",
  };
  const RARITY_COLOR = {
    1: "#9aa8a1",
    2: "#8fd3c0",
    3: "#5ac8fa",
    4: "#b18cff",
    5: "#ffd93d",
    6: "#ff9f43",
  };
  const TRAIT_ORDER = ["持续叠加", "整备能力", "作战能力", "单次叠加", "特异化"];
  const STORE_KEY = "spdb.prefs.v1";
  const HIDDEN_BONDS = new Set(["suntShip", "绝技"]);

  /* ---------- 工具 ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const esc = (s) =>
    String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  let TERMS = new Set();

  /** 把游戏文本中的富文本标记转换为 HTML（容忍嵌套/残缺标记） */
  function rich(str) {
    if (!str) return "";
    let s = esc(str);

    // 1) 高亮标记
    s = s.replace(/&lt;(@[a-z0-9._]+)&gt;/gi, (m, tag) => {
      const t = tag.toLowerCase();
      if (t === "@ba.vup" || t === "@autochess.orange" || t === "@autochess.gold") return '<span class="hl">';
      if (t === "@ba.rem" || t === "@autochess.gray") return '<span class="hl rem">';
      if (t === "@ba.acrem" || t === "@autochess.dgreen") return '<span class="hl acrem">';
      if (t === "@ba.vdown" || t === "@ba.down" || t === "@autochess.dred") return '<span class="hl down">';
      return "";
    });

    // 2) 颜色标记 <c:#rrggbb>
    s = s.replace(/&lt;(c:#[0-9a-f]{6})&gt;/gi, (m, c) => `<span style="color:${c.slice(2)}">`);

    // 3) 闭合标记
    s = s.replace(/&lt;\/&gt;/g, "</span>");

    // 3.5) wiki 条件标签 <k>…</k>（可包裹高亮）
    s = s.replace(/&lt;\/k&gt;/g, "</span>");
    s = s.replace(/&lt;k&gt;/g, '<span class="cond">');

    // 4) 条件标签（不含嵌套标记）
    s = s.replace(/&lt;([^&<>]{1,18})&gt;/g, '<span class="cond">$1</span>');

    // 5) 清理残缺的尖括号
    s = s.replace(/&lt;|&gt;/g, "");

    // 6) 换行
    s = s.replace(/\r?\n/g, "<br>");

    // 7) 【词条】可交互（仅限真实盟约名）
    if (TERMS.size) {
      s = s.replace(/【([^】<>]{1,12})】/g, (m, name) =>
        TERMS.has(name) ? `<button type="button" class="term" data-term="${name}">【${name}】</button>` : m
      );
    }
    return s;
  }

  const plain = (str) =>
    String(str || "")
      .replace(/<[^>]{1,24}>/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const stars = (n) => "★".repeat(n) + "☆".repeat(Math.max(0, 6 - n));

  function debounce(fn, ms) {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  }

  let toastTimer;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.dataset.show = "true";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.dataset.show = "false"), 2200);
  }

  /* ---------- 状态 ---------- */
  const state = {
    view: "ops", // ops | strat
    mode: "ops", // ops | equip
    sbonds: new Set(),
    seff: new Set(),
    ranks: new Set(),
    core: new Set(),
    sub: new Set(),
    traits: new Set(),
    q: "",
    sort: "rank",
    theme: "dark",
  };

  let season = DATA.seasons[0];
  let bondMap = new Map();
  let bondByName = new Map(); // 盟约名 -> 盟约对象
  let bondOps = new Map(); // 盟约名 -> 干员列表
  let bondEquip = new Map(); // 盟约名 -> 装备列表

  /* ---------- 初始化 ---------- */
  function init() {
    loadPrefs();
    const qp = new URLSearchParams(location.search);
    if (qp.get("theme") === "light" || qp.get("theme") === "dark") state.theme = qp.get("theme");
    applyTheme();
    bindUI();
    season = DATA.seasons[0];
    bondMap = new Map(season.bonds.map((b) => [b.id, b]));

    // 盟约 -> 干员 / 装备 索引（用于【词条】悬浮预览）
    bondOps = new Map();
    bondEquip = new Map();
    season.operators.forEach((op) => {
      const ids = new Set(op.bonds);
      op.tiers.forEach((t) => t.bonds.forEach((b) => ids.add(b)));
      ids.forEach((id) => {
        const b = bondMap.get(id);
        if (!b) return;
        if (!bondOps.has(b.name)) bondOps.set(b.name, []);
        bondOps.get(b.name).push(op);
      });
    });
    (season.equipment || []).forEach((eq) => {
      const b = bondMap.get(eq.bond);
      if (!b) return;
      if (!bondEquip.has(b.name)) bondEquip.set(b.name, []);
      bondEquip.get(b.name).push(eq);
    });
    TERMS = new Set([...bondOps.keys(), ...bondEquip.keys()]);
    bondByName = new Map(season.bonds.map((b) => [b.name, b]));

    parseHash();
    applyView(state.view, { silent: true });
    renderStats();
    renderFilters();
    renderList();

    const foot = $("#footerMeta");
    if (foot) {
      foot.innerHTML = `数据更新 ${esc(DATA.generated)}<br>
        <a href="https://prts.wiki" target="_blank" rel="noopener">PRTS.WIKI</a> · 非官方工具`;
    }
  }

  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
      if (p.theme === "light" || p.theme === "dark") state.theme = p.theme;
      if (typeof p.sort === "string") state.sort = p.sort;
    } catch (e) {
      /* ignore */
    }
  }

  function savePrefs() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ theme: state.theme, sort: state.sort }));
    } catch (e) {
      /* ignore */
    }
  }

  function applyTheme() {
    document.documentElement.dataset.theme = state.theme;
  }



  /* ---------- 统计 ---------- */
  function renderStats() {
    const st = season.stats;
    let items;
    if (state.view === "strat") {
      const sts = season.strategies || [];
      const bonds = new Set();
      sts.forEach((s) => s.bonds.forEach((b) => bonds.add(b)));
      items = [
        [sts.length, "策略"],
        [3, "类别"],
        [bonds.size, "涉及盟约"],
        [DATA.generated, "数据更新"],
      ];
    } else {
      items = [
        [season.operators.length, "干员"],
        [st.bonds, "盟约"],
        [st.traits || season.traitTypes.length, "特质类型"],
      ];
      if (st.equipment) items.push([st.equipment, "装备"]);
      items.push([DATA.generated, "数据更新"]);
    }
    $("#stats").innerHTML = items
      .map(([v, k]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(k)}</span></div>`)
      .join("");
  }

  /* ---------- 筛选器 ---------- */
  function renderFilters() {
    if (state.view === "strat") {
      renderStratFilters();
      return;
    }
    const equip = season.equipment || [];
    const panel = $("#filterPanel");
    panel.dataset.mode = state.mode;
    panel.classList.toggle("is-equip", state.mode === "equip");

    // 等阶（干员等阶 / 装备等阶共用）
    const rankSource = state.mode === "equip" ? equip.map((e) => e.level) : season.operators.map((o) => o.rank);
    const ranks = [...new Set(rankSource)].sort((a, b) => a - b);
    $("#rankChips").innerHTML =
      `<button class="chip" data-group="rank" data-value="all" aria-pressed="${state.ranks.size === 0}">全部</button>` +
      ranks
        .map(
          (r) =>
            `<button class="chip chip--rank" data-group="rank" data-value="${r}" data-rank="${r}"
              aria-pressed="${state.ranks.has(r)}" title="${r} 阶">${ROMAN[r] || r}</button>`
        )
        .join("");

    const core = season.bonds.filter((b) => b.type === "SEASON");
    const sub = season.bonds.filter((b) => b.type !== "SEASON" && !HIDDEN_BONDS.has(b.id) && !HIDDEN_BONDS.has(b.name));

    $("#coreChips").innerHTML =
      `<button class="chip" data-group="core" data-value="all" aria-pressed="${state.core.size === 0}">全部</button>` +
      core.map((b) => bondChip(b, "core", state.core.has(b.id))).join("") +
      `<button class="chip chip--equip" data-group="mode" data-value="equip"
        aria-pressed="${state.mode === "equip"}" title="浏览装备（${equip.length} 件）">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 20 7.5v9L12 21 4 16.5v-9L12 3Z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 8v8M8 12h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        <span>装备</span><em>${equip.length}</em>
      </button>`;

    $("#subChips").innerHTML =
      `<button class="chip" data-group="sub" data-value="all" aria-pressed="${state.sub.size === 0}">全部</button>` +
      sub.map((b) => bondChip(b, "sub", state.sub.has(b.id))).join("");

    const traits = [...(season.traitTypes || [])].sort(
      (a, b) => TRAIT_ORDER.indexOf(a.key) - TRAIT_ORDER.indexOf(b.key)
    );
    $("#traitChips").innerHTML =
      `<button class="chip" data-group="trait" data-value="all" aria-pressed="${state.traits.size === 0}">全部</button>` +
      traits
        .map(
          (t) =>
            `<button class="chip chip--trait" data-group="trait" data-value="${esc(t.key)}" data-t="${esc(
              t.key
            )}" aria-pressed="${state.traits.has(t.key)}">
              ${t.icon ? `<img src="assets/img/traits/${esc(t.icon)}.png" alt="" loading="lazy">` : ""}
              <span>${esc(t.key)}</span>
            </button>`
        )
        .join("");
  }

  function bondChip(b, group, on) {
    return `<button class="chip" data-group="${group}" data-value="${esc(b.id)}" aria-pressed="${on}" title="${esc(
      b.name
    )}">
      <img src="assets/img/bonds/${esc(b.id)}.png" alt="" loading="lazy">
      <span>${esc(b.name)}</span>
    </button>`;
  }


  /* ---------- 过滤 ---------- */
  function matches(op) {
    if (state.ranks.size && !state.ranks.has(op.rank)) return false;

    const bonds = new Set(op.bonds);
    op.tiers.forEach((t) => t.bonds.forEach((b) => bonds.add(b)));

    if (state.core.size) {
      let ok = false;
      for (const id of state.core) if (bonds.has(id)) { ok = true; break; }
      if (!ok) return false;
    }
    if (state.sub.size) {
      let ok = false;
      for (const id of state.sub) if (bonds.has(id)) { ok = true; break; }
      if (!ok) return false;
    }
    if (state.traits.size) {
      let ok = false;
      for (const t of op.tiers) {
        for (const tr of t.traits) {
          if (state.traits.has(tr.t)) { ok = true; break; }
        }
        if (ok) break;
      }
      if (!ok) return false;
    }
    if (state.q) {
      const q = state.q.toLowerCase();
      let hay = op.name + " " + op.profession;
      bonds.forEach((id) => {
        const b = bondMap.get(id);
        if (b) hay += " " + b.name + " " + plain(b.desc);
      });
      op.tiers.forEach((t) => {
        hay += " " + plain(t.desc);
        t.traits.forEach((tr) => (hay += " " + tr.t + " " + plain(tr.d)));
      });
      if (!hay.toLowerCase().includes(q)) return false;
    }
    return true;
  }

  /** 装备过滤 */
  function equipMatches(eq) {
    if (state.ranks.size && !state.ranks.has(eq.level)) return false;
    if (state.core.size || state.sub.size) {
      if (!eq.bond) return false;
      if (!state.core.has(eq.bond) && !state.sub.has(eq.bond)) return false;
    }
    if (state.q) {
      const q = state.q.toLowerCase();
      const b = bondMap.get(eq.bond);
      const hay = [eq.name, plain(eq.effect), plain(eq.desc), b ? b.name : ""].join(" ");
      if (!hay.toLowerCase().includes(q)) return false;
    }
    return true;
  }

  function comparator(a, b) {
    if (state.mode === "equip") {
      if (state.sort === "name") return a.name.localeCompare(b.name, "zh-Hans-CN");
      return a.level - b.level || a.name.localeCompare(b.name, "zh-Hans-CN");
    }
    if (state.sort === "name") return a.name.localeCompare(b.name, "zh-Hans-CN");
    if (state.sort === "rarity") {
      return b.rarity - a.rarity || a.rank - b.rank || a.name.localeCompare(b.name, "zh-Hans-CN");
    }
    return a.rank - b.rank || b.rarity - a.rarity || a.name.localeCompare(b.name, "zh-Hans-CN");
  }

  /* ---------- 渲染列表 ---------- */
  function renderList() {
    if (state.view === "strat") {
      renderStrategies();
      return;
    }
    const isEquip = state.mode === "equip";
    const source = isEquip ? season.equipment || [] : season.operators;
    const list = source.filter(isEquip ? equipMatches : matches).sort(comparator);
    const total = source.length;
    const unit = isEquip ? "件装备" : "名干员";

    $("#resultCount").innerHTML = `<b>${list.length}</b> / ${total} ${unit}`;
    $("#listFoot").hidden = list.length === 0;
    $("#listFoot").innerHTML = `<span>已显示全部 ${list.length} ${unit}</span>`;
    $("#searchInput").placeholder = isEquip ? "搜索装备 / 效果 / 盟约…" : "搜索干员 / 盟约 / 特质描述…";

    $("#opList").innerHTML = list
      .map((item, i) => (isEquip ? equipCardHTML(item, i) : cardHTML(item, i)))
      .join("");

    $("#emptyState").hidden = list.length !== 0;
    $("#opList").hidden = list.length === 0;
    if (list.length === 0) $("#listFoot").hidden = true;

    $("#emptyState h3").textContent = isEquip ? "没有符合条件的装备" : "没有符合条件的干员";
    $("#emptyState p").textContent = isEquip ? "尝试减少等阶条件，或更换关键词。" : "尝试减少筛选条件，或更换关键词。";

    renderActiveFilters();
    syncHash();
  }

  function cardHTML(op, i) {
    const rk = RANK_COLOR[op.rank] || "#9aa8a1";
    const rgb = RARITY_COLOR[op.rarity] || "#ffd93d";
    return `<article class="op" data-id="${esc(op.id)}" tabindex="0" role="button"
        aria-label="查看 ${esc(op.name)} 的干员档案"
        style="--i:${Math.min(i, 24)};--rk:${rk};--rarity:${rgb}">
      <div class="op__id">
        <div class="portrait" data-rarity="${op.rarity}">
          <span class="rankbadge">${ROMAN[op.rank] || op.rank}</span>
          <img src="assets/img/ops/${esc(op.id)}.webp" alt="${esc(op.name)}" loading="lazy" decoding="async">
        </div>
        <div class="op__info">
          <div class="op__name">${esc(op.name)}</div>
          <div class="op__rarity" title="${op.rarity} 星">${stars(op.rarity)}</div>
          <div class="op__meta">
            <img src="assets/img/prof/${esc(op.profession)}.png" alt="" loading="lazy">
            <span>${esc(op.profession)}</span>
          </div>
        </div>
      </div>
      <div class="op__body">${op.tiers.map((t) => tierHTML(t)).join("")}</div>
      <span class="op__more">档案 →</span>
    </article>`;
  }

  function tierHTML(t) {
    const bonds = t.bonds.length
      ? t.bonds
          .map((id) => {
            const b = bondMap.get(id);
            const cls = b && b.type === "SEASON" ? "bond--core" : "bond--sub";
            return `<span class="bond ${cls}" title="${esc(b ? b.name : id)}">
              ${b ? `<img src="assets/img/bonds/${esc(id)}.png" alt="" loading="lazy">` : ""}
              <span>${esc(b ? b.name : id)}</span></span>`;
          })
          .join("")
      : `<span class="bond bond--none">无盟约</span>`;

    const traits = t.traits.length
      ? t.traits
          .map(
            (tr) => `<div class="trait-line">
              <span class="tpill" data-t="${esc(tr.t)}">
                ${traitIcon(tr.t) ? `<img src="${traitIcon(tr.t)}" alt="" loading="lazy">` : ""}${esc(tr.t)}
              </span>
              <span class="ttext">${rich(tr.d)}</span>
            </div>`
          )
          .join("")
      : `<div class="trait-line"><span class="ttext" style="color:var(--text-mute)">—</span></div>`;

    return `<div class="tier ${t.k === "elite" ? "tier--elite" : ""}">
      <span class="tier__label"><i></i>${esc(t.label)}${t.level ? `<em style="font-style:normal;opacity:.55">Lv.${t.level}</em>` : ""}</span>
      <div class="bonds">${bonds}</div>
      <div class="traits">${traits}</div>
    </div>`;
  }

  function traitIcon(key) {
    const t = (season.traitTypes || []).find((x) => x.key === key);
    return t && t.icon ? `assets/img/traits/${t.icon}.png` : "";
  }

  /* ---------- 策略视图 ---------- */
  const STRAT_CLASSES = ["增益类", "经济类", "节奏类"];
  const STRAT_CLASS_DESC = {
    增益类: "提升生命上限或干员属性",
    经济类: "提供资金、干员或装备",
    节奏类: "围绕精锐 / 特质 / 核心盟约的运营节奏",
  };
  const EFFECT_TYPES = ["干员获取", "干员增益", "装备获取", "资金"];

  function renderStratFilters() {
    const sts = season.strategies || [];
    const bonds = [...new Set(sts.flatMap((s) => s.bonds))].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
    $("#sbondChips").innerHTML =
      `<button class="chip" data-group="sbond" data-value="all" aria-pressed="${state.sbonds.size === 0}">全部</button>` +
      bonds
        .map((b) => {
          const bd = bondByName.get(b);
          return `<button class="chip" data-group="sbond" data-value="${esc(b)}" aria-pressed="${state.sbonds.has(b)}">
            ${bd ? `<img src="assets/img/bonds/${esc(bd.id)}.png" alt="" loading="lazy">` : ""}
            <span>${esc(b)}</span></button>`;
        })
        .join("");
    $("#seffChips").innerHTML =
      `<button class="chip" data-group="seff" data-value="all" aria-pressed="${state.seff.size === 0}">全部</button>` +
      EFFECT_TYPES.map(
        (e) =>
          `<button class="chip chip--eff" data-group="seff" data-value="${e}" aria-pressed="${state.seff.has(e)}">${e}</button>`
      ).join("");
  }

  function stratMatches(st) {
    if (state.sbonds.size && !st.bonds.some((b) => state.sbonds.has(b))) return false;
    if (state.seff.size && !st.effects.some((e) => state.seff.has(e))) return false;
    if (state.q) {
      const hay = [st.name, st.who, st.cls, plain(st.desc), ...st.bonds, ...st.effects]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(state.q.toLowerCase())) return false;
    }
    return true;
  }

  function stratCardHTML(st, i) {
    const bonds = st.bonds
      .map((name) => {
        const bd = bondByName.get(name);
        return bd
          ? `<span class="bond bond--core" title="${esc(name)}"><img src="assets/img/bonds/${esc(bd.id)}.png" alt="" loading="lazy"><span>${esc(name)}</span></span>`
          : `<span class="bond"><span>${esc(name)}</span></span>`;
      })
      .join("");
    const effs = st.effects.map((e) => `<span class="efftag" data-e="${esc(e)}">${esc(e)}</span>`).join("");
    return `<article class="strat" style="--i:${Math.min(i, 18)}">
      <div class="strat__who">
        <div class="strat__avatar">
          <img src="${esc(st.avatar || "")}" alt="${esc(st.who)}" loading="lazy">
        </div>
        <span>${esc(st.who)}</span>
      </div>
      <div class="strat__main">
        <div class="strat__head">
          <span class="strat__cls strat__cls--${esc(st.cls)}">${esc(st.cls.replace("类", ""))}</span>
          <h3 class="strat__name">${esc(st.name)}</h3>
          ${st.hp ? `<span class="strat__hp">初始生命 ${st.hp}</span>` : ""}
          ${st.unlock ? `<span class="strat__unlock">${esc(st.unlock)}</span>` : ""}
        </div>
        <div class="strat__desc">${rich(st.desc)}</div>
        <div class="strat__tags">${effs}${bonds}</div>
      </div>
    </article>`;
  }

  function renderStrategies() {
    const all = season.strategies || [];
    const list = all.filter(stratMatches);
    const total = all.length;

    $("#resultCount").innerHTML = `<b>${list.length}</b> / ${total} 条策略`;
    $("#listFoot").hidden = list.length === 0;
    $("#listFoot").innerHTML = `<span>已显示全部 ${list.length} 条策略</span>`;
    $("#searchInput").placeholder = "搜索策略 / 发起人 / 效果…";

    const sections = STRAT_CLASSES.map((cls) => ({ cls, items: list.filter((s) => s.cls === cls) })).filter(
      (g) => g.items.length
    );

    $("#opList").innerHTML = sections
      .map(
        (g) => `<section class="stratsec">
          <div class="stratsec__head">
            <h2>${esc(g.cls)}</h2>
            <em>${g.items.length}</em>
            <span>${esc(STRAT_CLASS_DESC[g.cls] || "")}</span>
          </div>
          <div class="stratsec__list">${g.items.map(stratCardHTML).join("")}</div>
        </section>`
      )
      .join("");

    $("#emptyState").hidden = list.length !== 0;
    $("#opList").hidden = list.length === 0;
    if (list.length === 0) $("#listFoot").hidden = true;
    $("#emptyState h3").textContent = "没有符合条件的策略";
    $("#emptyState p").textContent = "尝试减少盟约 / 效果条件，或更换关键词。";

    renderActiveFilters();
    syncHash();
  }

  /* ---------- 视图切换 ---------- */
  const VIEW_META = {
    ops: {
      eyebrow: "ALLIANCE · TRAIT ARCHIVE / 数据档案",
      title: '盟约 <i>·</i> 特质数据库',
      lede: "收录《明日方舟》卫戍协议全部可调配干员：所属核心盟约、附加盟约、卫戍特质与等阶档位。按条件组合筛选，快速比对普通 / 精锐两档的层数与词条差异。",
    },
    strat: {
      eyebrow: "S.W.E.E.P. · STRATEGY REPORT / 策略报告",
      title: '策略 <i>·</i> 数据统计',
      lede: "按增益 / 经济 / 节奏三类整理卫戍协议的初始策略：标注发起人、初始目标生命、所属盟约与增益效果，支持按盟约与效果类型筛选。",
    },
  };

  function applyView(view, opts = {}) {
    state.view = view;
    document.body.dataset.view = view;
    const meta = VIEW_META[view] || VIEW_META.ops;
    $("#heroEyebrow").innerHTML = `<span class="dot"></span> ${meta.eyebrow}`;
    $("#heroTitle").innerHTML = meta.title;
    $("#heroLede").textContent = meta.lede;
    $$(".viewswitch__btn").forEach((b) => {
      const on = b.dataset.view === view;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-selected", String(on));
    });
    $("#stratFilters").hidden = view !== "strat";
    $$("#filterPanel > .fgroup").forEach((g) => (g.hidden = view === "strat"));
    if (!opts.silent) {
      renderStats();
      renderFilters();
      renderList();
    }
  }

  /* ---------- 已选条件 ---------- */
  function renderActiveFilters() {
    const chips = [];
    const add = (label, group, value) =>
      chips.push(
        `<span class="tag">${esc(label)}<button data-remove-group="${group}" data-remove-value="${esc(
          value
        )}" aria-label="移除 ${esc(label)}">×</button></span>`
      );

    state.ranks.forEach((r) => add(`${r} 阶`, "rank", r));
    state.core.forEach((id) => add(bondMap.get(id)?.name || id, "core", id));
    state.sub.forEach((id) => add(bondMap.get(id)?.name || id, "sub", id));
    state.traits.forEach((t) => add(t, "trait", t));
    if (state.mode === "equip" && state.view === "ops") add("装备", "mode", "equip");
    state.sbonds.forEach((b) => add(b, "sbond", b));
    state.seff.forEach((e) => add(e, "seff", e));
    if (state.q) add(`“${state.q}”`, "q", state.q);

    $("#activeFilters").innerHTML = chips.join("");
  }

  /* ---------- 装备 ---------- */
  const EQ_COLOR = { 1: "#c5c5c5", 2: "#ffffff", 3: "#46efbc", 4: "#33c9da", 5: "#f6c60f", 6: "#e88c1a" };

  function bondTag(id) {
    const b = bondMap.get(id);
    if (!b) return "";
    return `<span class="bond ${b.type === "SEASON" ? "bond--core" : "bond--sub"}" title="${esc(b.name)}">
      <img src="assets/img/bonds/${esc(id)}.png" alt="" loading="lazy"><span>${esc(b.name)}</span></span>`;
  }

  function equipCardHTML(eq, i) {
    const c = EQ_COLOR[eq.level] || "#9aa8a1";
    return `<article class="eq" data-eq="${esc(eq.id)}" tabindex="0" role="button"
        aria-label="查看装备 ${esc(eq.name)}"
        style="--i:${Math.min(i, 24)};--ec:${c}">
      <div class="eq__icon">
        <img src="assets/img/equip/${esc(eq.id)}.png" alt="${esc(eq.name)}" loading="lazy" decoding="async">
        <span class="eq__rank">${ROMAN[eq.level] || eq.level}</span>
      </div>
      <div class="eq__main">
        <div class="eq__head">
          <h3 class="eq__name">${esc(eq.name)}</h3>
          ${eq.price != null ? `<span class="eq__price" title="售价">
            <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 4.6v6.8M6.2 6.2h3.2M6.2 9.4h3.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
            ${eq.price}</span>` : ""}
          ${eq.bond ? bondTag(eq.bond) : ""}
        </div>
        <div class="eq__effect">${rich(eq.effect)}</div>
        <div class="eq__desc">${rich(eq.desc)}</div>
      </div>
    </article>`;
  }

  function openEquipModal(eq) {
    lastFocus = document.activeElement;
    const c = EQ_COLOR[eq.level] || "#9aa8a1";
    const b = bondMap.get(eq.bond);
    const bondCard = b
      ? `<div class="mbond ${b.type === "SEASON" ? "" : "mbond--sub"}">
          <div class="mbond__top">
            <img src="assets/img/bonds/${esc(b.id)}.png" alt="" loading="lazy">
            <b>${esc(b.name)}</b>
            <span>${b.type === "SEASON" ? "核心盟约" : "附加盟约"}${b.people ? ` · 需 ${b.people} 人` : ""}</span>
          </div>
          <div class="mbond__desc">${rich(b.desc) || "—"}</div>
        </div>`
      : `<div class="mbond mbond--sub"><div class="mbond__desc">通用装备，不隶属任何盟约。</div></div>`;

    $("#modalBody").innerHTML = `
      <div class="mop__head" style="--rk:${c};--rarity:${c}">
        <div class="mop__portrait mop__portrait--eq" style="--ec:${c}">
          <img src="assets/img/equip/${esc(eq.id)}.png" alt="${esc(eq.name)}">
        </div>
        <div class="mop__title">
          <h3 id="modalName">${esc(eq.name)}</h3>
          <div class="mop__sub">EQUIPMENT · ${esc(season.name)}</div>
          <div class="mop__badges">
            <span class="badge badge--rank">${ROMAN[eq.level] || eq.level} 阶</span>
            ${eq.price != null ? `<span class="badge">售价 ${eq.price}</span>` : ""}
            <span class="badge">装备</span>
            ${b ? `<span class="badge">${esc(b.name)}</span>` : `<span class="badge">通用</span>`}
          </div>
        </div>
      </div>

      <div class="mop__section">
        <h4>装备效果</h4>
        <div class="meffect">${rich(eq.effect)}</div>
      </div>

      <div class="mop__section">
        <h4>盟约归属</h4>
        <div class="mop__bonds">${bondCard}</div>
      </div>

      <div class="mop__section">
        <h4>描述</h4>
        <p class="mdesc">${rich(eq.desc) || "—"}</p>
      </div>

      <div class="mop__actions">
        <button class="btn" data-close type="button">关闭</button>
      </div>`;

    $("#modal").hidden = false;
    lockScroll();
    $("#modal .modal__panel").scrollTop = 0;
    setTimeout(() => $("#modal .modal__panel")?.focus({ preventScroll: true }), 30);
  }

  /* ---------- 【词条】悬浮预览 ---------- */
  let termPop = null;
  let termHideTimer = 0;

  function ensureTermPop() {
    if (termPop) return termPop;
    termPop = document.createElement("div");
    termPop.className = "termpop";
    termPop.id = "termPop";
    termPop.hidden = true;
    document.body.appendChild(termPop);
    termPop.addEventListener("mouseenter", () => clearTimeout(termHideTimer));
    termPop.addEventListener("mouseleave", () => (termHideTimer = setTimeout(hideTermPop, 160)));
    termPop.addEventListener("click", (e) => {
      const item = e.target.closest("[data-op]");
      if (!item) return;
      const op = season.operators.find((o) => o.id === item.dataset.op);
      hideTermPop();
      if (op) openModal(op);
    });
    return termPop;
  }

  function showTermPop(term, anchor) {
    const ops = bondOps.get(term) || [];
    const eqs = bondEquip.get(term) || [];
    if (!ops.length && !eqs.length) return;

    const pop = ensureTermPop();
    const items = ops
      .slice(0, 12)
      .map(
        (o) => `<button class="termpop__item" data-op="${esc(o.id)}" type="button">
          <img src="assets/img/ops/${esc(o.id)}.webp" alt="" loading="lazy">
          <span>${esc(o.name)}</span><em class="rankbadge-mini" style="--rk:${RANK_COLOR[o.rank] || "#9aa8a1"}">${ROMAN[o.rank] || o.rank}</em>
        </button>`
      )
      .join("");

    pop.innerHTML = `<div class="termpop__head">
        <b>【${esc(term)}】</b>
        <span>${ops.length} 名干员${eqs.length ? ` · ${eqs.length} 件装备` : ""}</span>
      </div>
      <div class="termpop__list">${items || '<div class="termpop__empty">暂无干员</div>'}</div>
      ${ops.length > 12 ? `<div class="termpop__more">仅显示前 12 名</div>` : ""}`;

    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    let left = r.left + r.width / 2 - pr.width / 2;
    left = Math.max(10, Math.min(left, window.innerWidth - pr.width - 10));
    let top = r.bottom + 8;
    if (top + pr.height > window.innerHeight - 10) top = Math.max(10, r.top - pr.height - 8);
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  }

  function hideTermPop() {
    if (termPop) termPop.hidden = true;
  }

  /* ---------- 弹窗 ---------- */
  let lastFocus = null;

  function openModal(op) {
    lastFocus = document.activeElement;
    const rk = RANK_COLOR[op.rank] || "#9aa8a1";
    const rgb = RARITY_COLOR[op.rarity] || "#ffd93d";
    const bonds = op.bonds.map((id) => bondMap.get(id)).filter(Boolean);

    const bondCards = bonds.length
      ? bonds
          .map(
            (b) => `<div class="mbond ${b.type === "SEASON" ? "" : "mbond--sub"}">
              <div class="mbond__top">
                <img src="assets/img/bonds/${esc(b.id)}.png" alt="" loading="lazy">
                <b>${esc(b.name)}</b>
                <span>${b.type === "SEASON" ? "核心盟约" : "附加盟约"}${b.people ? ` · 需 ${b.people} 人` : ""}</span>
              </div>
              <div class="mbond__desc">${rich(b.desc) || "—"}</div>
            </div>`
          )
          .join("")
      : '<div class="mbond"><div class="mbond__desc">无盟约</div></div>';

    const tiers = op.tiers
      .map((t) => {
        const traits = t.traits.length
          ? t.traits
              .map(
                (tr) => `<div class="mtrait">
                  <div><span class="tpill" data-t="${esc(tr.t)}">
                    ${traitIcon(tr.t) ? `<img src="${traitIcon(tr.t)}" alt="">` : ""}${esc(tr.t)}
                  </span></div>
                  <div class="ttext">${rich(tr.d)}</div>
                </div>`
              )
              .join("")
          : '<div class="ttext" style="color:var(--text-mute)">—</div>';
        const tone = t.k === "elite" ? "mtier--elite" : "";
        return `<div class="mtier ${tone}">
          <div class="mtier__head"><b>${esc(t.label)}</b><span>Lv.${t.level ?? "—"}</span></div>
          ${traits}
        </div>`;
      })
      .join("");

    $("#modalBody").innerHTML = `
      <div class="mop__head" style="--rk:${rk};--rarity:${rgb}">
        <div class="mop__portrait">
          <img src="assets/img/ops/${esc(op.id)}.webp" alt="${esc(op.name)}">
        </div>
        <div class="mop__title">
          <h3 id="modalName">${esc(op.name)}</h3>
          <div class="mop__sub">${esc(op.id.toUpperCase())} · ${esc(season.name)}</div>
          <div class="mop__badges">
            <span class="badge badge--rank">${ROMAN[op.rank] || op.rank} 阶</span>
            <span class="badge badge--rarity">${stars(op.rarity)}</span>
            <span class="badge">${esc(op.profession)}</span>
            <span class="badge">${esc(op.tiers[0]?.label || "")} Lv.${op.tiers[0]?.level ?? "—"} / ${esc(
      op.tiers[1]?.label || ""
    )} Lv.${op.tiers[1]?.level ?? "—"}</span>
          </div>
        </div>
      </div>

      <div class="mop__section">
        <h4>盟约归属</h4>
        <div class="mop__bonds">${bondCards}</div>
      </div>

      <div class="mop__section">
        <h4>卫戍特质</h4>
        <div class="mtiers">${tiers}</div>
      </div>

      <div class="mop__actions">
        <button class="btn btn--primary" id="copyLinkBtn" type="button">复制该干员链接</button>
        <button class="btn" data-close type="button">关闭</button>
      </div>`;

    $("#modal").hidden = false;
    lockScroll();
    $("#modal .modal__panel").scrollTop = 0;
    $("#copyLinkBtn").addEventListener("click", () => {
      const url = new URL(location.href);
      url.hash = `op=${op.id}`;
      const text = url.toString();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard
          .writeText(text)
          .then(() => toast("链接已复制"))
          .catch(() => toast("复制失败：" + text));
      } else {
        toast(text);
      }
    });
    setTimeout(() => $("#modal .modal__panel")?.focus({ preventScroll: true }), 30);
  }

  /* ---------- 滚动锁定 / 移动端抽屉 ---------- */
  function lockScroll() {
    const drawerOpen = $("#filterPanel").dataset.open === "true";
    const modalOpen = !$("#modal").hidden;
    document.body.style.overflow = drawerOpen || modalOpen ? "hidden" : "";
  }

  function setDrawer(open) {
    $("#filterPanel").dataset.open = String(open);
    const scrim = $("#filterScrim");
    if (scrim) scrim.dataset.open = String(open);
    lockScroll();
  }

  function closeModal() {
    const m = $("#modal");
    if (m.hidden) return;
    m.hidden = true;
    lockScroll();
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  /* ---------- 关于 ---------- */
  function openAbout() {
    lastFocus = document.activeElement;
    const rows = DATA.seasons
      .map(
        (s) => `<div class="about-row">
          <span class="about-row__name">${esc(s.name)}</span>
          <span class="about-row__sub">${esc(s.subtitle)}</span>
          <span class="about-row__num">${s.operators.length} 名干员</span>
        </div>`
      )
      .join("");

    $("#modalBody").innerHTML = `
      <div class="about">
        <p class="eyebrow" style="margin-bottom:14px"><span class="dot"></span> ABOUT THIS ARCHIVE</p>
        <h3 id="modalName" style="font-size:26px;margin-bottom:12px">卫戍协议 · 盟约与特质数据库</h3>
        <p class="about__lede">一个纯静态的《明日方舟》卫戍协议数据查询站。干员视图收录可调配干员的盟约、特质、等阶与普通 / 精锐数值；策略视图按增益 / 经济 / 节奏三类整理 S.W.E.E.P. 初始策略，二者均可组合筛选与搜索。</p>

        <div class="mop__section">
          <h4>数据版本</h4>
          <div class="about-list">${rows}</div>
        </div>

        <div class="mop__section">
          <h4>数据来源</h4>
          <div class="about__meta">
            <p>游戏数据与图片素材来自 <a href="https://prts.wiki" target="_blank" rel="noopener">PRTS.WIKI</a>（玩家共同构筑的明日方舟中文 Wiki），
            原始接口为 <code>torappu.prts.wiki/gamedata</code>、<code>static.prts.wiki/app/spdatabase</code> 与 <code>media.prts.wiki</code>。</p>
            <p>本项目仅做结构化整理与可视化，不含任何游戏内购或破解内容。数据更新于 <b>${esc(DATA.generated)}</b>。</p>
          </div>
        </div>

        <div class="mop__section">
          <h4>构建</h4>
          <div class="about__meta">
            <p>纯静态站点：原生 HTML / CSS / JavaScript，无运行时依赖；数据由 <code>scripts/build_data.py</code> 预生成。
            可直接部署到 GitHub Pages / Cloudflare Pages / Netlify。</p>
          </div>
        </div>

        <div class="mop__actions">
          <button class="btn btn--primary" data-close type="button">知道了</button>
        </div>
      </div>`;

    $("#modal").hidden = false;
    lockScroll();
    $("#modal .modal__panel").scrollTop = 0;
    setTimeout(() => $("#modal .modal__panel")?.focus({ preventScroll: true }), 30);
  }

  /* ---------- URL 同步 ---------- */
  function syncHash() {
    const p = new URLSearchParams();
    if (state.view === "strat") p.set("view", "strat");
    if (state.mode === "equip") p.set("type", "equip");
    if (state.sbonds.size) p.set("sb", [...state.sbonds].join(","));
    if (state.seff.size) p.set("se", [...state.seff].join(","));
    if (state.ranks.size) p.set("rank", [...state.ranks].join(","));
    if (state.core.size) p.set("core", [...state.core].join(","));
    if (state.sub.size) p.set("sub", [...state.sub].join(","));
    if (state.traits.size) p.set("trait", [...state.traits].join(","));
    if (state.q) p.set("q", state.q);
    if (state.sort !== "rank") p.set("sort", state.sort);
    const hash = "#" + p.toString();
    if (location.hash === hash) return;
    try {
      history.replaceState(null, "", hash);
    } catch (e) {
      /* file:// 等环境下可能被拒绝，忽略即可 */
    }
  }

  function parseHash() {
    const raw = location.hash.replace(/^#/, "");
    if (!raw) return;
    const p = new URLSearchParams(raw);

    const set = (key, target) => {
      const v = p.get(key);
      if (!v) return;
      v.split(",").filter(Boolean).forEach((x) => target.add(key === "rank" ? Number(x) : x));
    };
    set("rank", state.ranks);
    set("core", state.core);
    set("sub", state.sub);
    set("trait", state.traits);
    if (p.get("type") === "equip") state.mode = "equip";
    if (p.get("view") === "strat") state.view = "strat";
    set("sb", state.sbonds);
    set("se", state.seff);
    if (p.get("q")) state.q = p.get("q");
    if (p.get("sort")) state.sort = p.get("sort");
    const opId = p.get("op");
    if (opId) setTimeout(() => {
      const op = season.operators.find((o) => o.id === opId);
      if (op) openModal(op);
    }, 120);
    const eqId = p.get("eq");
    if (eqId) setTimeout(() => {
      const eq = (season.equipment || []).find((x) => x.id === eqId);
      if (eq) openEquipModal(eq);
    }, 120);
  }

  /* ---------- 事件 ---------- */
  function bindUI() {
    // 筛选 chip
    $("#filterPanel").addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (chip) {
        const group = chip.dataset.group;
        const value = chip.dataset.value;
        if (group === "sbond" || group === "seff") {
          const set = group === "sbond" ? state.sbonds : state.seff;
          if (value === "all") set.clear();
          else if (set.has(value)) set.delete(value);
          else set.add(value);
          renderFilters();
          renderList();
          return;
        }
        if (group === "mode") {
          state.mode = state.mode === "equip" ? "ops" : "equip";
          if (state.mode === "equip") state.traits.clear();
          renderFilters();
          renderList();
          return;
        }
        const target =
          group === "rank" ? state.ranks : group === "core" ? state.core : group === "sub" ? state.sub : state.traits;
        if (value === "all") target.clear();
        else {
          const key = group === "rank" ? Number(value) : value;
          target.has(key) ? target.delete(key) : target.add(key);
        }
        renderFilters();
        renderList();
        return;
      }
    });

    // 已选条件标签：点击 × 取消对应筛选（含搜索词）
    $("#activeFilters").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-remove-group]");
      if (!btn) return;
      const g = btn.dataset.removeGroup;
      const v = btn.dataset.removeValue;
      if (g === "rank") state.ranks.delete(Number(v));
      else if (g === "core") state.core.delete(v);
      else if (g === "sub") state.sub.delete(v);
      else if (g === "trait") state.traits.delete(v);
      else if (g === "sbond") state.sbonds.delete(v);
      else if (g === "seff") state.seff.delete(v);
      else if (g === "mode") state.mode = "ops";
      else if (g === "q") {
        state.q = "";
        $("#searchInput").value = "";
      }
      renderFilters();
      renderList();
    });

    // 重置
    const reset = () => {
      state.mode = "ops";
      state.sbonds.clear();
      state.seff.clear();
      state.ranks.clear();
      state.core.clear();
      state.sub.clear();
      state.traits.clear();
      state.q = "";
      $("#searchInput").value = "";
      renderFilters();
      renderList();
      toast("已清空筛选条件");
    };
    $("#resetBtn").addEventListener("click", reset);
    $("#emptyReset").addEventListener("click", reset);

    // 搜索
    const onSearch = debounce((v) => {
      state.q = v.trim();
      renderList();
    }, 140);
    $("#searchInput").addEventListener("input", (e) => onSearch(e.target.value));
    $("#searchInput").addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.target.value = "";
        state.q = "";
        renderList();
        e.target.blur();
      }
    });

    // 排序
    $("#sortSelect").value = state.sort;
    $("#sortSelect").addEventListener("change", (e) => {
      state.sort = e.target.value;
      savePrefs();
      renderList();
    });

    // 主题
    $("#themeBtn").addEventListener("click", () => {
      state.theme = state.theme === "dark" ? "light" : "dark";
      applyTheme();
      savePrefs();
    });

    $("#aboutBtn").addEventListener("click", openAbout);

    // 干员 / 策略 视图切换
    $$(".viewswitch__btn").forEach((btn) =>
      btn.addEventListener("click", () => {
        if (btn.dataset.view === state.view) return;
        state.q = "";
        $("#searchInput").value = "";
        state.sbonds.clear();
        state.seff.clear();
        applyView(btn.dataset.view);
        syncHash();
      })
    );


    // 卡片点击 / 键盘
    $("#opList").addEventListener("click", (e) => {
      if (e.target.closest(".term")) return; // 【词条】交给悬浮预览
      const eqCard = e.target.closest(".eq");
      if (eqCard) {
        const eq = (season.equipment || []).find((x) => x.id === eqCard.dataset.eq);
        if (eq) openEquipModal(eq);
        return;
      }
      const card = e.target.closest(".op");
      if (!card) return;
      const op = season.operators.find((o) => o.id === card.dataset.id);
      if (op) openModal(op);
    });
    $("#opList").addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const eqCard = e.target.closest(".eq");
      if (eqCard) {
        e.preventDefault();
        const eq = (season.equipment || []).find((x) => x.id === eqCard.dataset.eq);
        if (eq) openEquipModal(eq);
        return;
      }
      const card = e.target.closest(".op");
      if (!card) return;
      e.preventDefault();
      const op = season.operators.find((o) => o.id === card.dataset.id);
      if (op) openModal(op);
    });

    // 【词条】悬浮预览
    document.addEventListener("mouseover", (e) => {
      const t = e.target.closest(".term");
      if (!t) return;
      clearTimeout(termHideTimer);
      showTermPop(t.dataset.term, t);
    });
    document.addEventListener("mouseout", (e) => {
      const t = e.target.closest(".term");
      if (!t) return;
      const to = e.relatedTarget;
      if (to && to.closest && to.closest(".termpop")) return;
      termHideTimer = setTimeout(hideTermPop, 180);
    });
    document.addEventListener("focusin", (e) => {
      const t = e.target.closest(".term");
      if (t) showTermPop(t.dataset.term, t);
    });
    document.addEventListener("click", (e) => {
      const t = e.target.closest(".term");
      if (t) {
        e.preventDefault();
        e.stopPropagation();
        clearTimeout(termHideTimer);
        showTermPop(t.dataset.term, t);
        return;
      }
      if (!e.target.closest(".termpop")) hideTermPop();
    });

    // 弹窗关闭
    $("#modal").addEventListener("click", (e) => {
      if (e.target.closest("[data-close]")) closeModal();
    });

    // 移动端筛选抽屉
    $("#mobFilterBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      setDrawer($("#filterPanel").dataset.open !== "true");
    });
    $("#filterScrim")?.addEventListener("click", () => setDrawer(false));
    $("#closeFilterBtn")?.addEventListener("click", () => setDrawer(false));

    // 全局快捷键
    document.addEventListener("keydown", (e) => {
      const tag = (e.target.tagName || "").toLowerCase();
      const typing = tag === "input" || tag === "textarea" || tag === "select";
      if (e.key === "Escape") {
        hideTermPop();
        closeModal();
        setDrawer(false);
      }
      if (e.key === "/" && !typing) {
        e.preventDefault();
        $("#searchInput").focus();
      }
    });

    // 视口变宽（回到桌面布局）时自动收起抽屉
    window.addEventListener("resize", () => {
      if (window.innerWidth > 1180 && $("#filterPanel").dataset.open === "true") setDrawer(false);
    });

    // 图片加载失败兜底
    document.addEventListener(
      "error",
      (e) => {
        const t = e.target;
        if (t && t.tagName === "IMG") {
          t.style.visibility = "hidden";
          const box = t.closest(".portrait, .mop__portrait");
          if (box) box.classList.add("portrait--empty");
        }
      },
      true
    );
  }

  /* ---------- 启动 ---------- */
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
