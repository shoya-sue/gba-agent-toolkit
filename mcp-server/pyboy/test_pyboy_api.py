#!/usr/bin/env python3
"""
test_pyboy_api.py ― PyBoy 単体 GB/GBC API 検証 (Phase 4 DoD)

基本 API 4 系統（画面取得 / 入力送信 / メモリ読取 / セーブステート）が
GB(DMG) と GBC(CGB) の両モードで疎通することを検証する。

使い方: python test_pyboy_api.py <ROM.gb|.gbc>
終了コード: 0=全PASS / 1=いずれかFAIL
"""
import os
import sys
import struct

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pyboy_bridge import PyBoyBridge, VALID_BUTTONS

results = []


def record(group, ok, detail):
    results.append((group, ok, detail))
    print(f"{'✓' if ok else '✗'} [{group}] {detail}")


def png_dims(path):
    with open(path, "rb") as f:
        data = f.read(24)
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    w, h = struct.unpack(">II", data[16:24])
    return w, h


def run_mode(rom, mode, cgb):
    print(f"\n──────── モード: {mode} ────────")
    br = PyBoyBridge(rom, window="null", cgb=cgb)
    try:
        # ウォームアップ
        br.tick(120, False)
        info = br.get_info()
        record(f"{mode}:info", bool(info["title"]),
               f"get_info → title='{info['title']}' frame={info['frame']}")

        # 1. 画面取得（連続 3 回・PNG 160×144）
        dims = set()
        okshot = True
        for _ in range(3):
            p = br.screenshot()
            try:
                w, h = png_dims(p)
                dims.add(f"{w}x{h}")
            except Exception as e:
                okshot = False
            finally:
                if os.path.exists(p):
                    os.remove(p)
            br.tick(4, True)
        record(f"{mode}:screenshot", okshot and dims == {"160x144"},
               f"3連続キャプチャ 解像度={sorted(dims)}")

        # ndarray 形状も確認
        arr = br.screen_ndarray()
        record(f"{mode}:screen_ndarray", tuple(arr.shape) == (144, 160, 4),
               f"ndarray shape={tuple(arr.shape)} (144x160x4 RGBA)")

        # 2. 入力送信（全ボタン投入・エラーなく受理＋フレーム進行）
        f0 = br.get_info()["frame"]
        okbtn = True
        detail = []
        for b in ["a", "b", "up", "down", "left", "right", "start", "select"]:
            try:
                br.press_button(b, delay=2)
                br.tick(3, False)
                detail.append(f"{b}✓")
            except Exception as e:
                okbtn = False
                detail.append(f"{b}✗")
        f1 = br.get_info()["frame"]
        record(f"{mode}:buttons", okbtn and f1 > f0, f"{' '.join(detail)} (frame {f0}→{f1})")

        # 3. メモリ読取（ROM ヘッダのタイトル 0x0134..0x0143 を読み get_info と照合）
        raw = br.read_range(0x0134, 15)
        ascii_title = raw.split(b"\x00")[0].decode("ascii", "replace")
        b8 = br.read8(0x0134)
        match = info["title"].upper().startswith(ascii_title[:4].upper()) if ascii_title else False
        record(f"{mode}:memory", len(raw) == 15 and b8 == raw[0],
               f"read_range(0x0134,15)→'{ascii_title}' read8(0x0134)=0x{b8:02x}{' (title一致)' if match else ''}")

        # 4. セーブステート（save → WRAM を書換 → load で書換が取り消される）
        #    ※ PyBoy の frame_count はラッパ側カウンタでステート対象外のため、
        #      machine state(WRAM) が復元されるかを決定的に検証する。
        addr = 0xC000  # WRAM(書込可能)
        before = br.read8(addr)
        size = br.save_state(slot=1)
        br.write8(addr, before ^ 0xFF)  # 別の値へ書換
        modified = br.read8(addr)
        br.load_state(slot=1)            # 復元
        after = br.read8(addr)
        record(f"{mode}:save_state", modified != before and after == before,
               f"save({size}B) → WRAM[0x{addr:04x}] 0x{before:02x}→書換0x{modified:02x}→load後0x{after:02x}（復元={after == before}）")
    finally:
        br.stop()


def main():
    if len(sys.argv) < 2:
        print("usage: python test_pyboy_api.py <ROM.gb|.gbc>")
        sys.exit(2)
    rom = sys.argv[1]
    if not os.path.isfile(rom):
        print(f"ROM not found: {rom}")
        sys.exit(2)

    # GB(DMG) と GBC(CGB) の両モードで検証
    run_mode(rom, "GB(DMG)", cgb=False)
    run_mode(rom, "GBC(CGB)", cgb=True)

    fails = [r for r in results if not r[1]]
    print("\n──────── PyBoy GB/GBC API 検証サマリ ────────")
    print(f"合計 {len(results)} 項目 / PASS {len(results) - len(fails)} / FAIL {len(fails)}")
    for g, ok, d in fails:
        print(f"  FAIL [{g}] {d}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
