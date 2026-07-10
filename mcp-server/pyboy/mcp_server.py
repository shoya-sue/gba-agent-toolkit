#!/usr/bin/env python3
"""
mcp_server.py ― GB/GBC 用 MCP サーバ (Phase 4)

PyBoy を土台に、AI Agent へ GB/GBC 操作ツールを MCP(stdio) で公開する。
GBA 経路（mGBA + mcp-mgba, TypeScript）とは別トラックの Python 実装。

起動: python mcp_server.py
登録: claude mcp add pyboy --scope user -- <venv>/bin/python <このファイルのパス>

ツール命名は GBA 側(mgba_*)と対を成す pyboy_* 接頭辞。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pyboy_bridge import PyBoyBridge, VALID_BUTTONS

from mcp.server.fastmcp import FastMCP

app = FastMCP("pyboy-gbc")

# 単一の PyBoy インスタンスを保持（ROM ロード後に有効）
_bridge: PyBoyBridge | None = None


def _require() -> PyBoyBridge:
    if _bridge is None:
        raise RuntimeError("ROM 未ロード。先に pyboy_load_rom を呼んでください。")
    return _bridge


@app.tool()
def pyboy_ping() -> str:
    """疎通確認。ROM ロード済みなら pong、未ロードなら pong (no rom)。"""
    return "pong" if _bridge is not None else "pong (no rom)"


@app.tool()
def pyboy_load_rom(rom_path: str, cgb: bool = False) -> str:
    """GB/GBC ROM をロードして PyBoy を起動する（cgb=True で GBC モード）。"""
    global _bridge
    if not os.path.isfile(rom_path):
        raise FileNotFoundError(f"ROM not found: {rom_path}")
    if _bridge is not None:
        _bridge.stop()
    _bridge = PyBoyBridge(rom_path, window="null", cgb=cgb)
    _bridge.tick(60, False)  # 起動直後を安定させる
    info = _bridge.get_info()
    return f"loaded: title={info['title']} cgb={cgb}"


@app.tool()
def pyboy_get_info() -> str:
    """タイトル / フレーム数を返す。"""
    info = _require().get_info()
    return f"Title: {info['title']}\nFrame: {info['frame']}"


@app.tool()
def pyboy_screenshot() -> str:
    """スクリーンショット(PNG 160×144)を保存しパスを返す。"""
    return f"Screenshot saved: {_require().screenshot()}"


@app.tool()
def pyboy_press_buttons(buttons: list[str], delay: int = 2) -> str:
    """ボタン列を FIFO で投入する（a/b/up/down/left/right/start/select）。"""
    br = _require()
    br.press_buttons(buttons, delay=delay)
    br.tick(4, False)
    return f"pressed: {'+'.join(buttons)}"


@app.tool()
def pyboy_read8(address: int) -> str:
    """1 バイト読取。"""
    v = _require().read8(address)
    return f"0x{address:04x}: {v} (0x{v:02x})"


@app.tool()
def pyboy_read_range(address: int, length: int) -> str:
    """範囲一括読取（16 進表記）。"""
    data = _require().read_range(address, length)
    hexs = " ".join(f"{b:02x}" for b in data)
    return f"0x{address:04x} [{length} bytes]: {hexs}"


@app.tool()
def pyboy_tick(count: int = 1) -> str:
    """count フレーム進める。"""
    _require().tick(count, True)
    return f"advanced {count} frames (frame={_require().get_info()['frame']})"


@app.tool()
def pyboy_save_state(slot: int = 0) -> str:
    """現在の状態をスロットに保存。"""
    size = _require().save_state(slot)
    return f"save_state slot={slot} ({size} bytes)"


@app.tool()
def pyboy_load_state(slot: int = 0) -> str:
    """スロットから状態を復元。"""
    _require().load_state(slot)
    return f"load_state slot={slot}"


if __name__ == "__main__":
    app.run()  # 既定で stdio トランスポート
