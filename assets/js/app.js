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

    // 2) 闭合标记
    s = s.replace(/&lt;\/&gt;/g, "</span>");

    // 3) 条件标签（不含嵌套标记）
    s = s.replace(/&lt;([^&<>]{1,18})&gt;/g, '<span class="cond">$1</span>');

    // 4) 清理残缺的尖括号
    s = s.replace(/&lt;|&gt;/g, "");
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

  /* ---------- 初始化 ---------- */
  function init() {
    loadPrefs();
    const qp = new URLSearchParams(location.search);
    if (qp.get("theme") === "light" || qp.get("theme") === "dark") state.theme = qp.get("theme");
    applyTheme();
    bindUI();
    season = DATA.seasons[0];
    bondMap = new Map(season.bonds.map((b) => [b.id, b]));
    parseHash();
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
    const items = [
      [season.operators.length, "干员"],
      [st.bonds, "盟约"],
      [st.traits || season.traitTypes.length, "特质类型"],
      [DATA.generated, "数据更新"],
    ];
    $("#stats").innerHTML = items
      .map(([v, k]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(k)}</span></div>`)
      .join("");
  }

  /* ---------- 筛选器 ---------- */
  function renderFilters() {
    // 等阶
    const ranks = [...new Set(season.operators.map((o) => o.rank))].sort((a, b) => a - b);
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
      core.map((b) => bondChip(b, "core", state.core.has(b.id))).join("");

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

  function comparator(a, b) {
    if (state.sort === "name") return a.name.localeCompare(b.name, "zh-Hans-CN");
    if (state.sort === "rarity") {
      return b.rarity - a.rarity || a.rank - b.rank || a.name.localeCompare(b.name, "zh-Hans-CN");
    }
    return a.rank - b.rank || b.rarity - a.rarity || a.name.localeCompare(b.name, "zh-Hans-CN");
  }

  /* ---------- 渲染列表 ---------- */
  function renderList() {
    const list = season.operators.filter(matches).sort(comparator);
    const total = season.operators.length;

    $("#resultCount").innerHTML = `<b>${list.length}</b> / ${total} 名干员`;
    $("#listFoot").hidden = list.length === 0;
    $("#listFoot").innerHTML = `<span>已显示全部 ${list.length} 名干员</span>`;

    $("#opList").innerHTML = list
      .map((op, i) => cardHTML(op, i))
      .join("");

    $("#emptyState").hidden = list.length !== 0;
    $("#opList").hidden = list.length === 0;
    if (list.length === 0) $("#listFoot").hidden = true;

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
    if (state.q) add(`“${state.q}”`, "q", state.q);

    $("#activeFilters").innerHTML = chips.join("");
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
                <span>${b.type === "SEASON" ? "核心盟约" : "附加盟约"}</span>
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
    document.body.style.overflow = "hidden";
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

  function closeModal() {
    const m = $("#modal");
    if (m.hidden) return;
    m.hidden = true;
    document.body.style.overflow = "";
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
        <p class="about__lede">一个纯静态的《明日方舟》卫戍协议数据查询站。收录每个可调配干员的所属盟约、附加盟约、卫戍特质、等阶与普通 / 精锐两档数值，支持组合筛选、搜索与单干员档案查看。</p>

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
    document.body.style.overflow = "hidden";
    $("#modal .modal__panel").scrollTop = 0;
    setTimeout(() => $("#modal .modal__panel")?.focus({ preventScroll: true }), 30);
  }

  /* ---------- URL 同步 ---------- */
  function syncHash() {
    const p = new URLSearchParams();
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
    if (p.get("q")) state.q = p.get("q");
    if (p.get("sort")) state.sort = p.get("sort");
    const opId = p.get("op");
    if (opId) setTimeout(() => {
      const op = season.operators.find((o) => o.id === opId);
      if (op) openModal(op);
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
      else if (g === "q") {
        state.q = "";
        $("#searchInput").value = "";
      }
      renderFilters();
      renderList();
    });

    // 重置
    const reset = () => {
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


    // 卡片点击 / 键盘
    $("#opList").addEventListener("click", (e) => {
      const card = e.target.closest(".op");
      if (!card) return;
      const op = season.operators.find((o) => o.id === card.dataset.id);
      if (op) openModal(op);
    });
    $("#opList").addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const card = e.target.closest(".op");
      if (!card) return;
      e.preventDefault();
      const op = season.operators.find((o) => o.id === card.dataset.id);
      if (op) openModal(op);
    });

    // 弹窗关闭
    $("#modal").addEventListener("click", (e) => {
      if (e.target.closest("[data-close]")) closeModal();
    });

    // 移动端筛选抽屉
    $("#mobFilterBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      const p = $("#filterPanel");
      const open = p.dataset.open !== "true";
      p.dataset.open = String(open);
      const scrim = $("#filterScrim");
      if (scrim) scrim.dataset.open = String(open);
    });
    $("#filterScrim")?.addEventListener("click", () => {
      $("#filterPanel").dataset.open = "false";
      $("#filterScrim").dataset.open = "false";
    });
    $("#closeFilterBtn")?.addEventListener("click", () => {
      $("#filterPanel").dataset.open = "false";
      $("#filterScrim").dataset.open = "false";
    });

    // 全局快捷键
    document.addEventListener("keydown", (e) => {
      const tag = (e.target.tagName || "").toLowerCase();
      const typing = tag === "input" || tag === "textarea" || tag === "select";
      if (e.key === "Escape") {
        closeModal();
        $("#filterPanel").dataset.open = "false";
        $("#filterScrim").dataset.open = "false";
      }
      if (e.key === "/" && !typing) {
        e.preventDefault();
        $("#searchInput").focus();
      }
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
