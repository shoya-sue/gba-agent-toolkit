// GBA Agent Launcher フロントエンド
// CSP を効かせるためインライン script を分離（外部ファイル化）。
const invoke = window.__TAURI__.core.invoke;
const $ = (id) => document.getElementById(id);
const statusEl = $("status");

function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = kind || "muted";
}

// 入力検証（フロント側の第一次防壁。バックエンドも別途検証する）
function validatePort(port) {
  return /^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535;
}
function validateBind(bind) {
  return /^(127\.0\.0\.1|localhost|::1)$/.test(bind);
}

async function persist() {
  try {
    await invoke("save_config", {
      config: { rom_path: $("rom").value, port: $("port").value, bind: $("bind").value },
    });
  } catch (e) {
    /* 保存失敗は致命的でない */
  }
}

// 起動時に設定を復元
(async () => {
  try {
    const cfg = await invoke("load_config");
    if (cfg) {
      $("rom").value = cfg.rom_path || "";
      $("port").value = cfg.port || "8765";
      $("bind").value = cfg.bind || "127.0.0.1";
    }
  } catch (e) {}
})();

$("browse").addEventListener("click", async () => {
  try {
    const p = await invoke("pick_rom");
    if (p) {
      $("rom").value = p;
      persist();
    }
  } catch (e) {
    setStatus("選択キャンセル: " + e, "muted");
  }
});

$("start").addEventListener("click", async () => {
  const rom = $("rom").value.trim();
  const port = $("port").value.trim();
  const bind = $("bind").value.trim();
  if (!rom) { setStatus("ROM を選択してください", "err"); return; }
  if (!validatePort(port)) { setStatus("Port は 1–65535 の整数です", "err"); return; }
  if (!validateBind(bind)) { setStatus("Bind は localhost / 127.0.0.1 / ::1 のみ", "err"); return; }

  setStatus("起動中… mGBA を立ち上げ、bridge.lua をロードしています", "muted");
  $("start").disabled = true;
  await persist();
  try {
    const out = await invoke("start_session", { rom, port, bind });
    setStatus("✅ 起動成功\n" + out, "ok");
  } catch (e) {
    setStatus("❌ 起動失敗\n" + e, "err");
  } finally {
    $("start").disabled = false;
  }
});

$("stop").addEventListener("click", async () => {
  setStatus("停止中…", "muted");
  try {
    const out = await invoke("stop_session");
    setStatus("■ 停止しました\n" + out, "muted");
  } catch (e) {
    setStatus("停止エラー: " + e, "err");
  }
});

["rom", "port", "bind"].forEach((id) => $(id).addEventListener("change", persist));
