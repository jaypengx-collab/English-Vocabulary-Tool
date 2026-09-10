"use strict";

// ---- sync.js ----
// Optional cross-device sync for this app's learning progress (the
// progressStore app.js already keeps in localStorage). Reuses Orbit's own
// Cloudflare Worker (see that project's cloudflare-worker/orbit-worker.js,
// its `/vocab-sync` path) as shared server-side infrastructure - this app
// has no server of its own, and piggybacking on an already-deployed Worker
// means its owner doesn't need a second Firebase project or a second thing
// to keep patched just for this. See Orbit's README ("這支 Worker 同時也
// 服務 English Vocabulary Tool 的同步功能") for what runs server-side.
//
// Unlike Orbit's own schedule sync (one shared document broadcast from a
// manager device to many read-only viewer devices), this app's sync has no
// such broadcast use case: a pairing always belongs to ONE learner syncing
// their own progress across their own devices, so there is only ever one
// role. Every device holding the sync code AND its passcode can both read
// and write - the Worker requires the passcode for reads here too (unlike
// Orbit's open reads), since there is no legitimate "read-only" device to
// keep that door open for, and this is someone's personal learning record.
//
// Loaded as a plain <script> (attaches everything to `window.VocabSync`),
// same as logic.js/app.js - no bundler here, so the proxy URL below is a
// placeholder substituted at deploy time by .github/workflows/pages.yml,
// the same sed-based mechanism that already stamps __BUILD_VERSION__ into
// index.html/app.js. Left as the literal placeholder (or empty, if the
// GitHub Actions variable behind it is unset) when running locally without
// that build step - see isSyncProxyConfigured() below.
const VOCAB_SYNC_PROXY_URL = "__VOCAB_SYNC_PROXY_URL__";

const CODE_KEY = "vocab_sync_code";
const PASSCODE_KEY = "vocab_sync_passcode";
const LAST_UPDATE_KEY = "vocab_sync_last_update";
// A one-shot safety net for the one genuinely destructive moment in this
// feature: joining an existing sync immediately replaces this device's
// local progress with whatever the shared document holds (see
// vocabSyncJoin). Written right before that happens, offered back the
// moment there's somewhere to offer it from again - unlinking or deleting
// the sync both leave this device on its own, which is exactly when "did
// you want your old progress back, or is the one you've been using fine"
// becomes a real question (see promptRestoreBackupIfAny).
const BACKUP_BEFORE_JOIN_KEY = "vocab_sync_backup_before_join";

const SYNC_SCHEMA_VERSION = 1;
// A synced word's recentAttempts ring buffer is capped smaller than the
// locally-kept one (logic.js's CONFIG.maxRecentAttempts, 12) - it exists
// purely to show "you recently typed X, Y, Z" in the Progress/Review-list
// UI, not for any scoring logic, so a shorter history synced across
// devices is a fine trade against keeping every device's upload small even
// with thousands of attempted words.
const RECENT_ATTEMPTS_SYNC_CAP = 5;
// Mirrors Orbit's own activity-driven throttle: a receiving device that's
// genuinely idle sends nothing, and a burst of quiz answers (this app
// saves progress after EVERY single question, unlike Orbit's "save the
// whole schedule on demand") collapses into at most one sync round trip
// per this many milliseconds instead of one per answer.
const ACTIVITY_SYNC_THROTTLE_MS = 5000;

/* ---------- Local storage helpers ---------- */

function readLocal(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch (e) {
    return "";
  }
}
function writeLocal(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch (e) {
    /* localStorage unavailable (private browsing, etc.) */
  }
}

function isSyncProxyConfigured() {
  // Unreplaced local dev keeps the literal `__VOCAB_SYNC_PROXY_URL__`
  // placeholder; an unset-but-substituted GitHub Actions variable becomes
  // an empty string. Both mean "no proxy" - same two-case check app.js's
  // own checkForUpdate() already uses for __BUILD_VERSION__.
  return !!VOCAB_SYNC_PROXY_URL && !VOCAB_SYNC_PROXY_URL.startsWith("__");
}
function getSyncCode() {
  return readLocal(CODE_KEY).trim();
}
function getSyncPasscode() {
  return readLocal(PASSCODE_KEY).trim();
}
function isSyncConfigured() {
  return !!(getSyncCode() && getSyncPasscode());
}
function setSyncPairing(code, passcode) {
  writeLocal(CODE_KEY, String(code || "").trim().toUpperCase());
  writeLocal(PASSCODE_KEY, String(passcode || "").trim());
  writeLocal(LAST_UPDATE_KEY, "");
}
function clearSyncPairing() {
  writeLocal(CODE_KEY, "");
  writeLocal(PASSCODE_KEY, "");
  writeLocal(LAST_UPDATE_KEY, "");
}

/* ---------- Compact binary payload encoding (gzip + base64) ----------
   Progress data is JSON with a LOT of repeated key names (every attempted
   word carries the same dozen-odd field names), so gzip compresses it
   heavily - this is what keeps a snapshot of thousands of words' worth of
   history well under the Worker's payload cap even without hand-rolling a
   denser format the way Orbit's own transfer-text format does (that one
   also needs to be human-copy-pasteable; this one only ever travels inside
   a JSON request body, so plain base64 is enough). */

function base64FromBytes(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function bytesFromBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
async function encodeSyncPayload(data) {
  if (typeof CompressionStream !== "function") throw new Error("此裝置不支援同步所需的壓縮功能。");
  const raw = JSON.stringify(data);
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return base64FromBytes(bytes);
}
async function decodeSyncPayload(text) {
  if (typeof DecompressionStream !== "function") throw new Error("此裝置不支援同步所需的解壓縮功能。");
  const stream = new Blob([bytesFromBase64(text)]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

function trimProgressForSync(progress) {
  const trimmed = {};
  for (const key of Object.keys(progress || {})) {
    const history = progress[key];
    if (!history || typeof history !== "object") continue;
    const copy = Object.assign({}, history);
    if (Array.isArray(copy.recentAttempts) && copy.recentAttempts.length > RECENT_ATTEMPTS_SYNC_CAP) {
      copy.recentAttempts = copy.recentAttempts.slice(-RECENT_ATTEMPTS_SYNC_CAP);
    }
    trimmed[key] = copy;
  }
  return trimmed;
}

function buildSyncSnapshotData() {
  return {
    source: "vocab-tool-sync",
    schemaVersion: SYNC_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    progress: trimProgressForSync(window.VocabState.getProgress()),
    settings: window.VocabState.getSettings(),
  };
}

/* ---------- Worker calls ---------- */

function proxyUrl(code, extraParams) {
  const params = new URLSearchParams(Object.assign({ code: code }, extraParams || {}));
  return `${VOCAB_SYNC_PROXY_URL}?${params.toString()}`;
}
async function proxyErrorMessage(response) {
  if (response.status === 429) return "請求過於頻繁，請稍後再試。";
  const errorJson = await response.json().catch(() => ({}));
  return errorJson.error?.message || response.statusText || `HTTP ${response.status}`;
}

// This app's `/vocab-sync` route always needs the passcode to read too
// (see the top-of-file comment on why) - unlike Orbit's own /sync, there
// is no passcode-less "just checking role" call here.
async function fetchSyncDoc(code, passcode) {
  const response = await fetch(proxyUrl(code, { passcode: passcode || "" }));
  if (response.status === 400) return { ok: true, exists: false, updateTime: "", payload: "" };
  if (!response.ok) return { ok: false, error: await proxyErrorMessage(response) };
  const data = await response.json();
  return { ok: true, exists: !!data.exists, updateTime: data.updateTime || "", payload: data.payload || "" };
}

async function createSyncDoc(payload) {
  try {
    const response = await fetch(VOCAB_SYNC_PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: payload }),
    });
    if (!response.ok) return { ok: false, error: await proxyErrorMessage(response) };
    const data = await response.json();
    return { ok: true, code: data.code, passcode: data.managerPasscode, updateTime: data.updateTime || "" };
  } catch (error) {
    return { ok: false, error: `建立同步失敗：${error.message || error}` };
  }
}

async function writeSyncDoc(code, payload, passcode) {
  const response = await fetch(proxyUrl(code), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload: payload, passcode: passcode }),
  });
  if (!response.ok) return { ok: false, error: await proxyErrorMessage(response) };
  const doc = await response.json();
  return { ok: true, updateTime: doc.updateTime || "" };
}

async function deleteSyncDoc(code, passcode) {
  const response = await fetch(proxyUrl(code, { passcode: passcode }), { method: "DELETE" });
  if (!response.ok) return { ok: false, error: await proxyErrorMessage(response) };
  return { ok: true };
}

/* ---------- Push / pull / tick ---------- */

// Set the instant a local change happens (see notifyLocalChange) and
// cleared only once that change has actually been pushed - syncTick uses
// this, not a content diff, to decide whether it's this device's turn to
// push or to pull (see syncTick below), same "push if we changed, else
// pull" shape as Orbit's own syncTick.
let dirty = false;
let syncInFlight = false;
let vocabReady = false;

function setSyncStatus(text, isError) {
  const el = document.getElementById("sync-status");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("danger-text", !!isError);
}

async function pushSnapshot() {
  const code = getSyncCode();
  const passcode = getSyncPasscode();
  if (!isSyncProxyConfigured() || !code || !passcode) return { ok: false, error: "尚未設定同步。" };
  try {
    const payload = await encodeSyncPayload(buildSyncSnapshotData());
    const result = await writeSyncDoc(code, payload, passcode);
    if (!result.ok) throw new Error(result.error);
    writeLocal(LAST_UPDATE_KEY, result.updateTime);
    dirty = false;
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `同步上傳失敗：${error.message || error}` };
  }
}

async function pullSnapshot(opts) {
  const force = !!(opts && opts.force);
  const code = getSyncCode();
  const passcode = getSyncPasscode();
  if (!isSyncProxyConfigured() || !code || !passcode) return { ok: false, error: "尚未設定同步。" };
  try {
    const doc = await fetchSyncDoc(code, passcode);
    if (!doc.ok) throw new Error(doc.error);
    if (!doc.exists) return { ok: true, applied: false, exists: false };
    if (!doc.payload) return { ok: true, applied: false, exists: true };
    if (!force && doc.updateTime && doc.updateTime === readLocal(LAST_UPDATE_KEY)) {
      return { ok: true, applied: false, exists: true };
    }
    const remote = await decodeSyncPayload(doc.payload);
    window.VocabState.applySyncedSnapshot(remote.progress, remote.settings);
    writeLocal(LAST_UPDATE_KEY, doc.updateTime);
    dirty = false;
    return { ok: true, applied: true, exists: true };
  } catch (error) {
    return { ok: false, error: `同步下載失敗：${error.message || error}` };
  }
}

// One check does at most one round trip: push when this device changed
// since its last push, otherwise pull to pick up any change from another
// of this learner's devices. Never both in the same tick, same reasoning
// as Orbit's own syncTick - a push always means "we are already current."
async function syncTick() {
  if (!isSyncConfigured() || !navigator.onLine || document.hidden || syncInFlight || !vocabReady) return false;
  syncInFlight = true;
  try {
    if (dirty) {
      const result = await pushSnapshot();
      setSyncStatus(result.ok ? `已同步（${new Date().toLocaleTimeString("zh-TW")}）` : result.error, !result.ok);
      return result.ok;
    }
    const result = await pullSnapshot();
    if (result.ok && result.applied) {
      setSyncStatus(`已從其他裝置更新學習紀錄（${new Date().toLocaleTimeString("zh-TW")}）`);
    } else if (!result.ok) {
      setSyncStatus(result.error, true);
    }
    return !!(result.ok && result.applied);
  } finally {
    syncInFlight = false;
  }
}

let lastActivitySyncAt = 0;
// Called by app.js's saveProgress()/saveSettings() every time something
// local actually changed. Marks this device dirty immediately (so even a
// throttled-away call is still remembered) but only actually kicks a sync
// round at most once per ACTIVITY_SYNC_THROTTLE_MS, so answering 80
// questions in a row doesn't fire 80 network round trips.
function notifyLocalChange() {
  dirty = true;
  const now = Date.now();
  if (now - lastActivitySyncAt < ACTIVITY_SYNC_THROTTLE_MS) return;
  lastActivitySyncAt = now;
  syncTick();
}
// The moment the app becomes active (first load, a reload, or the tab
// regaining focus) always checks, bypassing the throttle - that's exactly
// when picking up another device's changes is most valuable.
function syncOnAppActive() {
  lastActivitySyncAt = Date.now();
  syncTick();
}

let syncLoopStarted = false;
function startSyncLoopIfConfigured() {
  if (syncLoopStarted || !isSyncConfigured() || !vocabReady) return;
  syncLoopStarted = true;
  syncOnAppActive();
}
// app.js calls this once loadVocab() resolves - pulling before then would
// apply a remote progress snapshot before VOCAB_INDEX exists to migrate it
// against (see window.VocabState.applySyncedSnapshot in app.js).
function onVocabReady() {
  vocabReady = true;
  startSyncLoopIfConfigured();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    syncOnAppActive();
  } else if (dirty) {
    // Best-effort: the tab is being backgrounded/closed with unsynced
    // local changes still pending - try to get them out now rather than
    // waiting for a touch that may never come on this device again today.
    pushSnapshot();
  }
});
window.addEventListener("pageshow", syncOnAppActive);
window.addEventListener("pagehide", () => {
  if (dirty) pushSnapshot();
});

/* ---------- UI entry points ---------- */

async function withButtonDisabled(buttonId, fn) {
  const button = document.getElementById(buttonId);
  if (button) button.disabled = true;
  try {
    await fn();
  } finally {
    if (button) button.disabled = false;
  }
}

async function copyTextWithFeedback(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      const prev = button.textContent;
      button.textContent = "已複製！";
      setTimeout(() => {
        button.textContent = prev;
      }, 1500);
    }
  } catch (e) {
    setSyncStatus("複製失敗，請手動選取複製。", true);
  }
}

// Held only in memory, never localStorage, same reasoning as Orbit's own
// pendingCreatedCodes: this is the one screen that shows the passcode in
// full right after creation, and losing it before copying it down just
// means falling back to the "顯示密碼" reveal in the active-sync box
// instead of losing anything for good.
let pendingCreatedCodes = null;

function renderSyncPanel() {
  const setupBox = document.getElementById("sync-setup-box");
  const createdBox = document.getElementById("sync-created-codes");
  const activeBox = document.getElementById("sync-active-box");
  if (!setupBox || !activeBox || !createdBox) return;

  if (!isSyncProxyConfigured()) {
    setupBox.innerHTML = `<p class="hint">跨裝置同步功能尚未設定，請聯絡開發者。</p>`;
    createdBox.classList.add("hidden");
    activeBox.classList.add("hidden");
    return;
  }

  createdBox.classList.toggle("hidden", !pendingCreatedCodes);
  if (pendingCreatedCodes) {
    setupBox.classList.add("hidden");
    activeBox.classList.add("hidden");
    document.getElementById("sync-created-code").textContent = pendingCreatedCodes.code;
    document.getElementById("sync-created-passcode").textContent = pendingCreatedCodes.passcode;
    return;
  }

  const configured = isSyncConfigured();
  setupBox.classList.toggle("hidden", configured);
  activeBox.classList.toggle("hidden", !configured);
  if (configured) {
    document.getElementById("sync-active-code").textContent = getSyncCode();
    const valueEl = document.getElementById("sync-passcode-value");
    const toggleBtn = document.getElementById("sync-passcode-toggle");
    if (valueEl) {
      valueEl.classList.add("hidden");
      valueEl.textContent = "";
    }
    if (toggleBtn) toggleBtn.textContent = "顯示密碼";
  }
}

function vocabSyncCreate() {
  if (!isSyncProxyConfigured()) {
    setSyncStatus("跨裝置同步功能尚未設定，請聯絡開發者。", true);
    return;
  }
  if (!navigator.onLine) {
    setSyncStatus("目前沒有網路連線，無法建立同步。", true);
    return;
  }
  const confirmed = confirm(
    "建立新同步會產生一組新的同步代碼與密碼，用來在你自己的其他裝置之間同步學習紀錄。\n\n" +
      "已經有代碼的話請改用「加入同步」。要繼續嗎？"
  );
  if (!confirmed) return;
  withButtonDisabled("sync-create-btn", async () => {
    setSyncStatus("正在建立同步…");
    const payload = await encodeSyncPayload(buildSyncSnapshotData());
    const result = await createSyncDoc(payload);
    if (!result.ok) {
      setSyncStatus(result.error, true);
      return;
    }
    setSyncPairing(result.code, result.passcode);
    writeLocal(LAST_UPDATE_KEY, result.updateTime);
    dirty = false;
    pendingCreatedCodes = { code: result.code, passcode: result.passcode };
    setSyncStatus("");
    renderSyncPanel();
    startSyncLoopIfConfigured();
  });
}

function vocabSyncJoin() {
  if (!isSyncProxyConfigured()) {
    setSyncStatus("跨裝置同步功能尚未設定，請聯絡開發者。", true);
    return;
  }
  if (!navigator.onLine) {
    setSyncStatus("目前沒有網路連線，無法加入同步。", true);
    return;
  }
  const codeInput = document.getElementById("sync-join-code");
  const passcodeInput = document.getElementById("sync-join-passcode");
  const code = (codeInput?.value || "").trim().toUpperCase();
  const passcode = (passcodeInput?.value || "").trim();
  if (!code || !passcode) {
    setSyncStatus("請輸入同步代碼與密碼。", true);
    return;
  }

  withButtonDisabled("sync-join-btn", async () => {
    setSyncStatus("正在檢查配對代碼…");
    const doc = await fetchSyncDoc(code, passcode);
    if (!doc.ok) {
      setSyncStatus(doc.error, true);
      return;
    }
    if (!doc.exists) {
      setSyncStatus("找不到這組配對代碼，或密碼不正確，請確認後再試一次。", true);
      return;
    }
    const confirmed = confirm(
      "加入同步會立刻用該代碼下的學習紀錄取代這台裝置目前的紀錄。\n\n" +
        "這台裝置目前的紀錄會先備份起來，解除同步後可以選擇找回，但要繼續嗎？"
    );
    if (!confirmed) {
      setSyncStatus("");
      return;
    }
    writeLocal(BACKUP_BEFORE_JOIN_KEY, JSON.stringify(buildSyncSnapshotData()));
    if (doc.payload) {
      const remote = await decodeSyncPayload(doc.payload);
      window.VocabState.applySyncedSnapshot(remote.progress, remote.settings);
    } else {
      window.VocabState.applySyncedSnapshot({}, null);
    }
    setSyncPairing(code, passcode);
    writeLocal(LAST_UPDATE_KEY, doc.updateTime);
    dirty = false;
    if (codeInput) codeInput.value = "";
    if (passcodeInput) passcodeInput.value = "";
    setSyncStatus("已加入同步。");
    renderSyncPanel();
    startSyncLoopIfConfigured();
  });
}

function vocabSyncNow() {
  if (!isSyncConfigured()) return;
  if (!navigator.onLine) {
    setSyncStatus("目前沒有網路連線，無法同步。", true);
    return;
  }
  withButtonDisabled("sync-now-btn", async () => {
    setSyncStatus("正在同步…");
    if (dirty) {
      const result = await pushSnapshot();
      setSyncStatus(result.ok ? "已同步。" : result.error, !result.ok);
    } else {
      const result = await pullSnapshot({ force: true });
      if (!result.ok) setSyncStatus(result.error, true);
      else setSyncStatus(result.applied ? "已更新為最新的學習紀錄。" : "已是最新。");
    }
  });
}

// The recovery half of the safety net above: offered right after this
// device is no longer part of any sync (unlink or delete), same moment
// Orbit's own promptScheduleBackupRestore offers its schedule backup back.
function promptRestoreBackupIfAny() {
  const raw = readLocal(BACKUP_BEFORE_JOIN_KEY);
  writeLocal(BACKUP_BEFORE_JOIN_KEY, "");
  if (!raw) return;
  let backup;
  try {
    backup = JSON.parse(raw);
  } catch (e) {
    return;
  }
  const confirmed = confirm("要找回加入同步前的本機學習紀錄嗎？（取消則繼續使用目前的學習紀錄）");
  if (!confirmed) return;
  window.VocabState.applySyncedSnapshot(backup.progress, backup.settings);
  setSyncStatus("已還原加入同步前的學習紀錄。");
}

function vocabSyncUnlink() {
  const confirmed = confirm(
    "解除同步後這台裝置會變回只在本機儲存進度，之後可用同一組代碼重新加入。其他裝置不受影響。要繼續嗎？"
  );
  if (!confirmed) return;
  clearSyncPairing();
  syncLoopStarted = false;
  dirty = false;
  renderSyncPanel();
  setSyncStatus("已解除同步（本機學習紀錄不受影響）。");
  promptRestoreBackupIfAny();
}

function vocabSyncDeleteForEveryone() {
  const code = getSyncCode();
  const passcode = getSyncPasscode();
  if (!code || !passcode) return;
  if (!navigator.onLine) {
    setSyncStatus("目前沒有網路連線，無法刪除同步。", true);
    return;
  }
  const confirmed = confirm(
    `確定要整個刪除這組同步（代碼 ${code}）嗎？\n\n所有使用這組代碼的裝置都會斷開連結，此動作無法復原。`
  );
  if (!confirmed) return;
  withButtonDisabled("sync-delete-btn", async () => {
    setSyncStatus("正在刪除同步…");
    const result = await deleteSyncDoc(code, passcode);
    if (!result.ok) {
      setSyncStatus(`刪除失敗：${result.error}`, true);
      return;
    }
    clearSyncPairing();
    syncLoopStarted = false;
    dirty = false;
    renderSyncPanel();
    setSyncStatus("已整個刪除同步，所有裝置都已斷開連結。");
    promptRestoreBackupIfAny();
  });
}

function togglePasscodeReveal() {
  const valueEl = document.getElementById("sync-passcode-value");
  const toggleBtn = document.getElementById("sync-passcode-toggle");
  if (!valueEl || !toggleBtn) return;
  const showing = valueEl.classList.contains("hidden");
  valueEl.classList.toggle("hidden", !showing);
  if (showing) valueEl.textContent = getSyncPasscode();
  toggleBtn.textContent = showing ? "隱藏密碼" : "顯示密碼";
}

function acknowledgeSyncCreatedCodes() {
  pendingCreatedCodes = null;
  renderSyncPanel();
}

function initSyncUI() {
  document.getElementById("sync-create-btn")?.addEventListener("click", vocabSyncCreate);
  document.getElementById("sync-join-btn")?.addEventListener("click", vocabSyncJoin);
  document.getElementById("sync-now-btn")?.addEventListener("click", vocabSyncNow);
  document.getElementById("sync-unlink-btn")?.addEventListener("click", vocabSyncUnlink);
  document.getElementById("sync-delete-btn")?.addEventListener("click", vocabSyncDeleteForEveryone);
  document.getElementById("sync-passcode-toggle")?.addEventListener("click", togglePasscodeReveal);
  document.getElementById("sync-ack-btn")?.addEventListener("click", acknowledgeSyncCreatedCodes);
  document.getElementById("sync-created-code-copy")?.addEventListener("click", () => {
    if (pendingCreatedCodes) {
      copyTextWithFeedback(pendingCreatedCodes.code, document.getElementById("sync-created-code-copy"));
    }
  });
  document.getElementById("sync-created-passcode-copy")?.addEventListener("click", () => {
    if (pendingCreatedCodes) {
      copyTextWithFeedback(pendingCreatedCodes.passcode, document.getElementById("sync-created-passcode-copy"));
    }
  });
  renderSyncPanel();
}

initSyncUI();

window.VocabSync = {
  notifyLocalChange: notifyLocalChange,
  onVocabReady: onVocabReady,
};
