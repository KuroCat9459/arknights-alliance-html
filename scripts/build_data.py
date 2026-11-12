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
        "stats": {
            "operators": len(ops),
            "bonds": len(used_bonds),
            "traits": len(used_traits),
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
