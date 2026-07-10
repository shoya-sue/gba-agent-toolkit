"""
pyboy_bridge.py ― PyBoy を GB/GBC 用の共通 API にラップする (Phase 4)

GBA 経路（mGBA + mcp-mgba, TypeScript）とは別トラックの Python 実装。
AI Agent の 3 系統（画面取得 / 入力送信 / メモリ読取）＋セーブステートを
PyBoy(v2.7.0, LGPL-3.0-only) の上に薄く実装する。

参考: PyBoy API（https://docs.pyboy.dk/）
"""
import io
import tempfile

from pyboy import PyBoy

# GB/GBC のボタン名（PyBoy の button() が受ける小文字名にマップ）
VALID_BUTTONS = {"a", "b", "up", "down", "left", "right", "start", "select"}


class PyBoyBridge:
    """PyBoy を 1 インスタンス保持し、Agent 向け高レベル API を提供する。"""

    def __init__(self, rom_path: str, window: str = "null", cgb: bool | None = None):
        # window="null" でヘッドレス。cgb=True で GBC モード強制（None は ROM 依存で自動）
        kwargs = {"window": window}
        if cgb is not None:
            kwargs["cgb"] = cgb
        self.pyboy = PyBoy(rom_path, **kwargs)
        self.rom_path = rom_path
        self._states: dict[int, bytes] = {}  # slot -> セーブステート(バイト列)

    # ── 情報 ──────────────────────────────────────────────
    def get_info(self) -> dict:
        return {
            "title": self.pyboy.cartridge_title,
            "frame": self.pyboy.frame_count,
        }

    def tick(self, count: int = 1, render: bool = True) -> None:
        self.pyboy.tick(count, render)

    # ── 1. 画面取得 ──────────────────────────────────────
    def screenshot(self, path: str | None = None) -> str:
        """PNG を保存しパスを返す。GB 画面は 160×144。"""
        if path is None:
            fd, path = tempfile.mkstemp(suffix=".png", prefix="pyboy_")
            import os
            os.close(fd)
        self.pyboy.screen.image.save(path)
        return path

    def screen_ndarray(self):
        """(144, 160, 4) RGBA の numpy 配列。"""
        return self.pyboy.screen.ndarray

    # ── 2. 入力送信 ──────────────────────────────────────
    def press_button(self, button: str, delay: int = 1) -> None:
        b = button.lower()
        if b not in VALID_BUTTONS:
            raise ValueError(f"invalid button: {button} (valid: {sorted(VALID_BUTTONS)})")
        self.pyboy.button(b, delay)

    def press_buttons(self, buttons: list[str], delay: int = 1) -> None:
        for b in buttons:
            self.press_button(b, delay)

    # ── 3. メモリ読取／書込 ──────────────────────────────
    def read8(self, address: int) -> int:
        return int(self.pyboy.memory[address])

    def read_range(self, address: int, length: int) -> bytes:
        return bytes(self.pyboy.memory[address:address + length])

    def write8(self, address: int, value: int) -> None:
        self.pyboy.memory[address] = value & 0xFF

    # ── 4. セーブステート（試行錯誤・分岐探索の土台）────
    def save_state(self, slot: int = 0) -> int:
        buf = io.BytesIO()
        self.pyboy.save_state(buf)
        data = buf.getvalue()
        self._states[slot] = data
        return len(data)

    def load_state(self, slot: int = 0) -> None:
        if slot not in self._states:
            raise ValueError(f"no save state in slot {slot}")
        self.pyboy.load_state(io.BytesIO(self._states[slot]))

    # ── 終了 ──────────────────────────────────────────────
    def stop(self) -> None:
        self.pyboy.stop(save=False)
