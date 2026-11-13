#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
卫戍协议 盟约·特质数据库 —— 数据构建脚本

从 PRTS 公开数据源抓取原始数据，解析并生成静态站点可直接使用的
data/seasons.json 与本地图片资源。

数据来源:
  - 干员/活动数据: https://torappu.prts.wiki/gamedata/latest/excel/*.json
  - 赛季归档:     https://static.prts.wiki/app/spdatabase/archive/*.json
  - 图片素材:     https://media.prts.wiki/... (按文件名 md5 分目录)
                  https://torappu.prts.wiki/assets/char_avatar/<charId>.png

用法:
  python scripts/build_data.py            # 全量构建
  python scripts/build_data.py --no-images # 仅生成 JSON
"""

import argparse
import hashlib
import io
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "_raw")
DATA = os.path.join(ROOT, "data")
IMG = os.path.join(ROOT, "assets", "img")

GAMEDATA = "https://torappu.prts.wiki/gamedata/latest/excel/"
ARCHIVE = "https://static.prts.wiki/app/spdatabase/archive/"
MEDIA = "https://media.prts.wiki/"
AVATAR = "https://torappu.prts.wiki/assets/char_avatar/"

# PRTS「装备数据库」小节（卫戍协议·规程 / PRTS盟约记录）
WIKI_EQUIP = (
    "https://prts.wiki/index.php?title=%E5%8D%AB%E6%88%8D%E5%8D%8F%E8%AE%AE%C2%B7%E8%A7%84%E7%A8%8B"
    "/PRTS%E7%9B%9F%E7%BA%A6%E8%AE%B0%E5%BD%95&action=raw&section=10"
)
WIKI_COVENANT = (
    'https://prts.wiki/index.php?title=%E5%8D%AB%E6%88%8D%E5%8D%8F%E8%AE%AE%C2%B7%E8%A7%84%E7%A8%8B'
    '/PRTS%E7%9B%9F%E7%BA%A6%E8%AE%B0%E5%BD%95&action=raw&section=2',
    'https://prts.wiki/index.php?title=%E5%8D%AB%E6%88%8D%E5%8D%8F%E8%AE%AE%C2%B7%E8%A7%84%E7%A8%8B'
    '/PRTS%E7%9B%9F%E7%BA%A6%E8%AE%B0%E5%BD%95&action=raw&section=3',
)
WIKI_STRATEGY = (
    "https://prts.wiki/index.php?title=%E5%8D%AB%E6%88%8D%E5%8D%8F%E8%AE%AE%C2%B7%E8%A7%84%E7%A8%8B"
    "/PRTS%E7%9B%9F%E7%BA%A6%E8%AE%B0%E5%BD%95&action=raw&section=4"
)
BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
}

PROFESSION_CN = {
    "PIONEER": "先锋",
    "WARRIOR": "近卫",
    "SNIPER": "狙击",
    "SUPPORT": "辅助",
    "CASTER": "术师",
    "SPECIAL": "特种",
    "MEDIC": "医疗",
    "TANK": "重装",
}

# 赛季定义: (id, 标题, 副标题, 数据源, 数据路径)
# 目前仅保留常驻协议「规程序列」；如需恢复历史赛季，把对应条目加回列表即可。
SEASONS = [
    {
        "id": "perm",
        "name": "规程序列",
        "subtitle": "常驻协议 · V3.1",
        "source": "activity_table",
        "path": ["activity", "AUTOCHESS", "act3autochess", "V3_1"],
        "extra": ["autoChessData"],
    },
]


EQUIPMENT_CACHE = {}
COVENANT_CACHE = {}
STRATEGY_CACHE = {}


def log(msg):
    print(msg, flush=True)


def fetch(url, dest, retries=3):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return dest
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 spdb-build"})
            with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
                f.write(r.read())
            return dest
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"download failed: {url} ({last})")


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def dig(obj, path):
    for k in path:
        obj = obj[k]
    return obj


def media_url(filename):
    h = hashlib.md5(filename.encode("utf-8")).hexdigest()
    return f"{MEDIA}{h[0]}/{h[:2]}/{urllib.parse.quote(filename)}"


def download_image(url, dest, max_size=0, quality=86):
    """下载并按需缩放/转 webp。"""
    if os.path.exists(dest):
        return True
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 spdb-build"})
        with urllib.request.urlopen(req, timeout=60) as r:
            blob = r.read()
        im = Image.open(io.BytesIO(blob))
        if im.mode != "RGBA":
            im = im.convert("RGBA")
        if max_size and max(im.size) > max_size:
            im.thumbnail((max_size, max_size), Image.LANCZOS)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if dest.endswith(".webp"):
            im.save(dest, "WEBP", quality=quality, method=6)
        else:
            im.save(dest, "PNG", optimize=True)
        return True
    except Exception as e:  # noqa: BLE001
        log(f"  ! image failed {url} -> {e}")
        return False


def fetch_text(url, dest, retries=3):
    """下载纯文本（带浏览器请求头，绕过 PRTS 对默认 UA 的限制）。"""
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return io.open(dest, encoding="utf-8").read()
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=BROWSER_HEADERS)
            with urllib.request.urlopen(req, timeout=90) as r:
                raw = r.read().decode("utf-8", "replace")
            io.open(dest, "w", encoding="utf-8").write(raw)
            return raw
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"download failed: {url} ({last})")


WIKI_COLORS = {
    "orange": "#e8912d",
    "red": "#d9534f",
    "green": "#3fa06a",
    "blue": "#4a7fd4",
    "purple": "#9b6ad6",
}


def wiki_markup(text):
    """wiki 语法转站点富文本：{{color|#hex|x}} -> <c:#hex>x</>，<br> -> 换行。"""
    if not text:
        return ""

    def color_repl(m):
        c = m.group(1).strip()
        body = m.group(2)
        c = WIKI_COLORS.get(c, c)
        if c.startswith("#") and len(c) == 7:
            return f"<c:{c}>{body}</>"
        return body

    s = re.sub(r"\{\{color\|([^|}]+)\|([^}]*)\}\}", color_repl, text)
    s = re.sub(r"<br\s*/?>", "\n", s)
    s = s.replace("'''", "").replace("''", "")
    s = s.replace("&nbsp;", " ")
    return s.strip()


def build_equipment(raw, season):
    """解析 PRTS 装备数据库，并与游戏数据（盟约 / 等阶）合并。"""
    blocks = raw.split("{{:卫戍协议/道具")[1:]
    wiki = []
    for b in blocks:
        def param(key):
            m = re.search(r"\|" + key + r"=([^\n]*)", b)
            return m.group(1).strip() if m else ""

        name = param("名称")
        if not name:
            continue
        price = param("售价")
        level = param("等阶")
        wiki.append(
            {
                "name": name,
                "level": int(level) if level.isdigit() else 0,
                "price": int(price) if price.isdigit() else None,
                "effect": wiki_markup(param("效果")),
                "desc": wiki_markup(param("描述")),
            }
        )

    eff = season.get("effectInfoDataDict", {})
    trap = season.get("trapChessDataDict", {})
    shop = season.get("trapShopChessDatas", {})
    game = {}
    for item_id, si in shop.items():
        t = trap.get(item_id) or {}
        e = eff.get(t.get("effectId")) or {}
        nm = e.get("effectName")
        if not nm:
            continue
        game[nm] = {"bond": t.get("giveBondId"), "level": si.get("itemLevel")}

    out = []
    for it in wiki:
        g = game.get(it["name"], {})
        out.append(
            {
                "id": "eq_" + hashlib.md5(it["name"].encode("utf-8")).hexdigest()[:8],
                "name": it["name"],
                "level": int(g.get("level") or it["level"] or 0),
                "price": it["price"],
                "bond": g.get("bond"),
                "effect": it["effect"],
                "desc": it["desc"],
            }
        )
    out.sort(key=lambda x: (x["level"], x["name"]))
    return out


def resolve_equip_icons(names):
    """通过 PRTS API 批量解析装备图标真实地址（处理文件重命名/重定向）。"""
    api = "https://prts.wiki/api.php?action=query&prop=imageinfo&iiprop=url&format=json&titles="
    out = {}
    for i in range(0, len(names), 40):
        batch = names[i : i + 40]
        titles = "|".join("File:卫戍协议 道具 " + n.replace(" ", "_") + ".png" for n in batch)
        try:
            req = urllib.request.Request(api + urllib.parse.quote(titles, safe=""), headers=BROWSER_HEADERS)
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.loads(r.read().decode("utf-8"))
            for page in data.get("query", {}).get("pages", {}).values():
                title = page.get("title", "")
                url = (page.get("imageinfo") or [{}])[0].get("url")
                if not url:
                    continue
                nm = title.replace("文件:卫戍协议 道具 ", "").rsplit(".png", 1)[0]
                out[nm] = url
        except Exception as e:  # noqa: BLE001
            log(f"  ! 图标解析失败：{e}")
    return out


def expand_wiki_templates(text):
    """把 wiki 模板按由内向外展开：color / 术语 / ruby / 其他。"""
    pat = re.compile(r"\{\{([^{}]*)\}\}")
    while True:
        m = pat.search(text)
        if not m:
            break
        parts = m.group(1).split("|")
        head = parts[0].strip()
        if head == "color" and len(parts) >= 3:
            c = WIKI_COLORS.get(parts[1].strip(), parts[1].strip())
            body = "|".join(parts[2:])
            rep = f"<c:{c}>{body}</>" if c.startswith("#") and len(c) == 7 else body
        elif head == "术语" and len(parts) >= 3:
            rep = parts[-1]
        elif head == "ruby" and len(parts) >= 2:
            rep = parts[1]
        else:
            rep = ""
        text = text[: m.start()] + rep + text[m.end() :]
    return text


def build_covenants(raw_pages):
    """解析核心/附加盟约板块，提取「效果」文本与激活人数。"""
    out = {}
    for raw in raw_pages:
        for block in raw.split("{{卫戍协议/盟约")[1:]:
            nm = re.search(r"\|盟约=([^|]+)", block)
            if not nm:
                continue
            name = nm.group(1).strip()
            pm = re.search(r"\|人数=(\d+)", block)
            em = re.search(r"\|效果=(.*?)(?=\|干员=)", block, re.S)
            if not em:
                continue
            raw_effect = re.sub(r"<br\s*/?>", "\n", em.group(1))
            raw_effect = re.sub(r"<([^<>\n]+)>", r"<k>\1</k>", raw_effect)
            text = expand_wiki_templates(raw_effect).replace("'''", "").strip()
            out[name] = {"desc": text, "people": int(pm.group(1)) if pm else None}
    return out


STRATEGY_META = {
    "众志合一": ("增益类", ["干员增益"], []),
    "坚不可摧": ("增益类", ["干员增益"], []),
    "加急调派": ("增益类", ["干员增益"], []),
    "食腐之蝶": ("增益类", ["干员增益"], []),
    "统御号令": ("增益类", ["干员增益"], []),
    "意志鼓舞": ("增益类", ["干员增益"], []),
    "药枚实验": ("增益类", ["干员增益"], []),
    "溃心领域": ("增益类", ["干员增益"], []),
    "以己之长": ("增益类", ["干员增益"], []),
    "内部货源": ("经济类", ["资金"], []),
    "纸片替身": ("经济类", ["干员获取"], []),
    "幻画为真": ("经济类", ["干员获取"], []),
    "集结指示": ("经济类", ["装备获取", "干员获取"], []),
    "全力熔铸": ("经济类", ["装备获取"], []),
    "得闲饮茶": ("经济类", ["资金", "干员获取"], []),
    "协力共进": ("经济类", ["装备获取", "干员获取"], []),
    "外勤医疗": ("经济类", ["干员获取"], []),
    "暴躁铁皮": ("经济类", ["干员获取"], []),
    "宝藏探机": ("经济类", ["资金"], []),
    "消解空间": ("经济类", ["干员获取"], []),
    "变形同构": ("经济类", ["装备获取"], []),
    "私募基金": ("经济类", ["资金"], []),
    "献身护卫": ("经济类", ["资金"], []),
    "利滚利": ("经济类", ["资金"], []),
    "“神秘顾客”": ("经济类", ["资金"], []),
    "最佳品味": ("经济类", ["干员获取", "资金"], []),
    "替身娃娃": ("经济类", ["干员获取"], []),
    "人才锁定": ("经济类", ["干员获取"], []),
    "专享情报": ("经济类", ["干员获取"], []),
    "精巧设计": ("经济类", ["装备获取"], []),
    "电气化！": ("经济类", ["装备获取"], []),
    "打包速递": ("经济类", ["干员获取", "资金"], []),
    "优等生": ("经济类", ["干员获取"], ["调和"]),
    "黑白相易": ("经济类", ["干员获取"], ["炎"]),
    "广交豪杰": ("经济类", ["干员获取"], ["炎"]),
    "博学多通": ("经济类", ["干员获取"], ["萨尔贡"]),
    "自发制造": ("经济类", ["装备获取"], ["维多利亚"]),
    "人才盲盒": ("经济类", ["干员获取"], ["维多利亚"]),
    "猎人战法": ("经济类", ["干员获取"], ["阿戈尔"]),
    "骑士团长": ("经济类", ["干员获取", "资金"], ["卡西米尔"]),
    "不融信念": ("经济类", ["装备获取"], ["谢拉格"]),
    "量体裁衣": ("经济类", ["资金"], ["叙拉古"]),
    "团伙行动": ("经济类", ["干员获取"], ["叙拉古"]),
    "流动乐章": ("经济类", ["干员获取"], ["莱塔尼亚"]),
    "无惧风雪": ("经济类", ["干员获取", "资金"], ["乌萨斯"]),
    "出航时刻": ("经济类", ["干员获取"], ["伊比利亚"]),
    "条文修正": ("节奏类", ["干员增益"], []),
    "全场聚焦": ("节奏类", ["干员增益"], []),
    "重点监护": ("节奏类", ["干员增益"], []),
    "至纯凝结": ("节奏类", ["干员增益"], []),
    "御守之力": ("节奏类", ["干员增益"], []),
    "强制休整": ("节奏类", ["干员增益"], []),
    "不稳定要素": ("节奏类", ["干员获取"], []),
    "好多委托！": ("节奏类", [], []),
    "东之极道": ("节奏类", ["干员增益"], []),
    "正直教官": ("节奏类", ["干员增益"], []),
    "二重奏": ("节奏类", ["干员增益"], []),
    "沙洲梦魇": ("节奏类", ["干员获取", "资金"], ["萨尔贡"]),
    "崇高牺牲": ("节奏类", ["干员增益"], ["阿戈尔"]),
    "业务指标": ("节奏类", ["资金"], ["卡西米尔"]),
    "雪域礼赠": ("节奏类", ["资金"], ["谢拉格"]),
}


def convert_game_wiki(text):
    """游戏内 wiki 文本：<br> -> 换行，<…> -> 条件标签，模板展开。"""
    t = re.sub(r"<br\s*/?>", "\n", text or "")
    t = re.sub(r"<([^<>\n]+)>", r"<k>\1</k>", t)
    t = expand_wiki_templates(t)
    return t.replace("'''", "").strip()


def build_strategies(raw):
    out = []
    for block in raw.split("{{:卫戍协议/策略")[1:]:
        def param(key):
            m = re.search(r"\|" + key + r"=([^\n]*)", block)
            return m.group(1).strip() if m else ""

        name = param("策略")
        if not name:
            continue
        cls, effects, bonds = STRATEGY_META.get(name, ("增益类", [], []))
        hp = param("血量")
        who = param("发起人")
        out.append(
            {
                "id": "st_" + hashlib.md5(name.encode("utf-8")).hexdigest()[:8],
                "name": name,
                "who": who,
                "avatar": "assets/img/strat/" + hashlib.md5(who.encode("utf-8")).hexdigest()[:8] + ".png",
                "hp": int(hp) if hp.isdigit() else 0,
                "desc": convert_game_wiki(param("效果")),
                "unlock": convert_game_wiki(param("解锁条件")),
                "cls": cls,
                "effects": effects,
                "bonds": bonds,
            }
        )
    return out


def resolve_strategy_avatars(names):
    """通过 PRTS API 批量解析策略发起人头像（文件名：卫戍协议：盟约 策略发起人 X.png）。"""
    api = "https://prts.wiki/api.php?action=query&prop=imageinfo&iiprop=url&format=json&titles="
    out = {}
    names = list(dict.fromkeys(names))
    for i in range(0, len(names), 35):
        batch = names[i : i + 35]
        titles = "|".join(f"File:卫戍协议：盟约 策略发起人 {n}.png" for n in batch)
        try:
            req = urllib.request.Request(api + urllib.parse.quote(titles, safe=""), headers=BROWSER_HEADERS)
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.loads(r.read().decode("utf-8"))
            for page in data.get("query", {}).get("pages", {}).values():
                title = page.get("title", "")
                url = (page.get("imageinfo") or [{}])[0].get("url")
                if not url:
                    continue
                nm = title.replace("文件:卫戍协议：盟约 策略发起人 ", "").rsplit(".png", 1)[0]
                out[nm] = url
        except Exception as e:  # noqa: BLE001
            log(f"  ! 策略头像解析失败：{e}")
    return out


def build_season(cfg, tables):
    src = cfg["source"]
    season = dig(tables[src], cfg["path"])
    extra = dig(tables[src], cfg["extra"])

    root_bonds = extra.get("bondInfoDict", {})
    season_bonds = season.get("bondInfoDict", {})
    garrison = season.get("garrisonDataDict", {})
    shop = season.get("charShopChessDatas", {})
    chess = season.get("charChessDataDict", {})

    # ---- 盟约元数据 ----
    bonds = []
    for bid, b in root_bonds.items():
        sb = season_bonds.get(bid, {})
        bonds.append(
            {
                "id": bid,
                "name": b.get("name", bid),
                "type": b.get("bondType", "REGULAR"),
                "icon": b.get("icon", ""),
                "order": b.get("bondOrder", 99),
                "desc": sb.get("desc", ""),
                "activeCount": sb.get("activeCount"),
                "activeType": sb.get("activeType", ""),
            }
        )
    bonds.sort(key=lambda x: (x["type"] != "SEASON", x["order"], x["name"]))

    # 用 PRTS 盟约板块的公式化描述覆盖游戏内简略说明
    cov = COVENANT_CACHE.get(cfg["id"], {})
    for b in bonds:
        c = cov.get(b["name"])
        if c:
            b["desc"] = c["desc"]
            b["people"] = c["people"]

    # ---- 特质分类 ----
    trait_types = {}
    for g in garrison.values():
        key = g.get("eventTypeDesc") or "其他"
        if key not in trait_types:
            trait_types[key] = {
                "key": key,
                "eventType": g.get("eventType", ""),
                "icon": g.get("eventTypeSmallIcon", ""),
                "iconBig": g.get("eventTypeIcon", ""),
            }

    # ---- 干员 ----
    operators = {}
    for cid, c in chess.items():
        if "diy" in cid or not c.get("upgradeChessId"):
            continue
        s = shop.get(cid)
        if not s:
            continue
        char_id = s.get("tmplId") or s.get("charId")
        if not char_id:
            continue
        meta = tables["chars"].get(char_id) or tables["patch"].get(char_id)
        if not meta:
            continue
        if meta.get("isNotObtainable") and char_id not in operators:
            pass
        bonds_ids = [b for b in c.get("bondIds", []) if b in root_bonds]
        if not bonds_ids:
            continue

        up = chess.get(c.get("upgradeChessId")) or {}
        rank = s.get("chessLevel", 0)

        def tier(entry, label, key):
            t_bonds = [b for b in entry.get("bondIds", []) if b in root_bonds]
            traits = []
            for gid in entry.get("garrisonIds", []):
                g = garrison.get(gid)
                if not g:
                    continue
                traits.append(
                    {
                        "id": gid,
                        "t": g.get("eventTypeDesc") or "其他",
                        "d": g.get("description") or g.get("garrisonDesc") or "",
                        "lv": g.get("charLevel", 0),
                    }
                )
            return {
                "k": key,
                "label": label,
                "level": (entry.get("status") or {}).get("charLevel"),
                "bonds": t_bonds,
                "traits": traits,
                "desc": entry.get("desc", ""),
            }

        operators[char_id] = {
            "id": char_id,
            "name": meta.get("name", char_id),
            "rarity": int(str(meta.get("rarity", "TIER_1")).replace("TIER_", "")),
            "profession": PROFESSION_CN.get(meta.get("profession", ""), ""),
            "professionKey": meta.get("profession", ""),
            "nation": meta.get("nationId") or "",
            "rank": rank,
            "bonds": bonds_ids,
            "tiers": [tier(c, "普通", "normal"), tier(up, "精锐", "elite")],
        }

    ops = sorted(
        operators.values(),
        key=lambda o: (o["rank"], -o["rarity"], o["name"]),
    )

    # ---- 统计 ----
    used_bonds = set()
    used_traits = set()
    for o in ops:
        used_bonds.update(o["bonds"])
        for t in o["tiers"]:
            used_bonds.update(t["bonds"])
            for tr in t["traits"]:
                used_traits.add(tr["t"])

    return {
        "id": cfg["id"],
        "name": cfg["name"],
        "subtitle": cfg["subtitle"],
        "bonds": [b for b in bonds if b["id"] in used_bonds],
        "traitTypes": [trait_types[k] for k in ["持续叠加", "整备能力", "作战能力", "单次叠加", "特异化"] if k in trait_types],
        "operators": ops,
        "equipment": EQUIPMENT_CACHE.get(cfg["id"], []),
        "strategies": STRATEGY_CACHE.get(cfg["id"], []),
        "stats": {
            "operators": len(ops),
            "bonds": len(used_bonds),
            "traits": len(used_traits),
            "equipment": len(EQUIPMENT_CACHE.get(cfg["id"], [])),
            "strategies": len(STRATEGY_CACHE.get(cfg["id"], [])),
        },
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-images", action="store_true")
    args = ap.parse_args()

    os.makedirs(RAW, exist_ok=True)
    os.makedirs(DATA, exist_ok=True)

    log("[1/4] 拉取原始数据 ...")
    files = {
        "activity_table": GAMEDATA + "activity_table.json",
        "character_table": GAMEDATA + "character_table.json",
        "char_patch_table": GAMEDATA + "char_patch_table.json",
    }
    for key, url in files.items():
        dest = os.path.join(RAW, key.split(":")[-1])
        fetch(url, dest)
        log(f"  ok {key} ({os.path.getsize(dest)/1e6:.1f} MB)")

    log("[2/4] 解析 ...")
    tables = {}
    for key in files:
        name = key.split(":")[-1]
        tables[key] = load(os.path.join(RAW, name))
    tables["chars"] = tables["character_table"]
    tables["patch"] = tables["char_patch_table"].get("patchChars", {})

    log("[2.5/4] 解析装备与盟约数据 ...")
    cov_raw = [
        fetch_text(u, os.path.join(RAW, f"cov_{i}.txt")) for i, u in enumerate(WIKI_COVENANT)
    ]
    cov_data = build_covenants(cov_raw)
    for cfg in SEASONS:
        COVENANT_CACHE[cfg["id"]] = cov_data
    log(f"  盟约描述: {len(cov_data)} 条")
    eq_raw = fetch_text(WIKI_EQUIP, os.path.join(RAW, "equip_section.txt"))
    for cfg in SEASONS:
        EQUIPMENT_CACHE[cfg["id"]] = build_equipment(eq_raw, dig(tables[cfg["source"]], cfg["path"]))
        log(f"  {cfg['id']}: {len(EQUIPMENT_CACHE[cfg['id']])} 件装备")

    log("[2.6/4] 解析策略报告 ...")
    strat_raw = fetch_text(WIKI_STRATEGY, os.path.join(RAW, "strategy.txt"))
    strat_data = build_strategies(strat_raw)
    for cfg in SEASONS:
        STRATEGY_CACHE[cfg["id"]] = strat_data
    log(f"  策略: {len(strat_data)} 条")

    all_seasons = []
    for cfg in SEASONS:
        season = build_season(cfg, tables)
        log(f"  {cfg['id']}: {season['stats']}")
        all_seasons.append(season)

    payload = {
        "generated": time.strftime("%Y-%m-%d"),
        "source": "PRTS.WIKI · torappu.prts.wiki",
        "seasons": all_seasons,
    }
    out = os.path.join(DATA, "seasons.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    # 同时输出一份 JS 包装，便于直接以 file:// 打开（无需本地服务器）
    js = os.path.join(DATA, "seasons.js")
    with open(js, "w", encoding="utf-8") as f:
        f.write("/* generated by scripts/build_data.py */\nwindow.SPDB=")
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    log(f"[3/4] 写出 {out} ({os.path.getsize(out)/1e6:.2f} MB) + seasons.js")

    if args.no_images:
        return

    log("[4/4] 下载图片 ...")
    # 个别干员没有独立头像（如阿米娅-医疗），回退到同角色其他形态
    avatar_fallback = {"char_1037_amiya3": "char_1001_amiya2"}
    # 策略发起人头像
    strat_names = [st["who"] for s in all_seasons for st in s.get("strategies", [])]
    strat_icons = resolve_strategy_avatars(strat_names)
    for s in all_seasons:
        for st in s.get("strategies", []):
            url = strat_icons.get(st["who"])
            if not url:
                continue
            download_image(url, os.path.join(ROOT, st["avatar"]), max_size=96)

    # 装备图标真实地址（部分文件在 wiki 上被重命名）
    equip_icons = resolve_equip_icons(
        [eq["name"] for s in all_seasons for eq in s.get("equipment", [])]
    )
    # 干员头像 / 盟约图标 / 特质图标 / 职业图标
    for s in all_seasons:
        for o in s["operators"]:
            dest = os.path.join(IMG, "ops", o["id"] + ".webp")
            ok = download_image(
                AVATAR + urllib.parse.quote(o["id"]) + ".png",
                dest,
                max_size=160,
            )
            if not ok and o["id"] in avatar_fallback:
                download_image(
                    AVATAR + urllib.parse.quote(avatar_fallback[o["id"]]) + ".png",
                    dest,
                    max_size=160,
                )
        for b in s["bonds"]:
            fn = f"卫戍协议：盟约_icon_{b['id']}.png"
            download_image(media_url(fn), os.path.join(IMG, "bonds", b["id"] + ".png"), max_size=96)
        for t in s["traitTypes"]:
            if not t.get("icon"):
                continue
            fn = f"卫戍协议：盟约_{t['icon']}.png"
            download_image(media_url(fn), os.path.join(IMG, "traits", t["icon"] + ".png"), max_size=64)
        for eq in s.get("equipment", []):
            fn = "卫戍协议_道具_" + eq["name"].replace(" ", "_") + ".png"
            url = equip_icons.get(eq["name"]) or media_url(fn)
            download_image(url, os.path.join(IMG, "equip", eq["id"] + ".png"), max_size=96)
    prof_seen = set()
    for s in all_seasons:
        for o in s["operators"]:
            p = o["profession"]
            if p and p not in prof_seen:
                prof_seen.add(p)
                fn = f"图标_职业_{p}.png"
                download_image(media_url(fn), os.path.join(IMG, "prof", p + ".png"), max_size=48)
    log("done.")


if __name__ == "__main__":
    sys.exit(main())
