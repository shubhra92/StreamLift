/**
 * StreamLift SharedWorker — sync-worker.js
 *
 * Runs ONCE across all tabs. Owns all API syncing and progress tracking.
 * Written in plain ES6 (no TypeScript, no bundler) for direct browser execution.
 *
 * Protocol:
 *   Tab → Worker: { type: "init", origin: "http://..." }
 *                 { type: "declare", needs: ["downloads"|"torrents"|"workers"], cursors: {...} }
 *                 { type: "syncNow", entity }
 *                 { type: "trackDownload", downloadId, workerId, downloadType }
 *                 { type: "stopTracking" }
 *                 { type: "watchWorker", workerId }
 *                 { type: "unwatchWorker", workerId }
 *
 *   Worker → Tab: { type: "ready" }
 *                 { type: "networkStatus", status: "online"|"offline" }
 *                 { type: "data", entity, rows, runtimeStatus? }
 *                 { type: "progress", payload }
 *                 { type: "saveCursor", entity, cursor }
 *                 { type: "workerStatus", workerId, status }
 */

// ─── Constants ────────────────────────────────────────────────────────────────

var INTERVALS = { downloads: 30000, torrents: 30000, workers: 15000 };
var WORKER_POLL_INTERVAL = 3000;
var EXPRESS_POLL_INTERVAL = 10000;

// ─── State ────────────────────────────────────────────────────────────────────

var ports    = new Set();

/**
 * Dependency registry: maps each port to the set of entities it currently needs.
 * The active sync intervals are the union of all ports' needs — deduplicated.
 *
 * This replaces the old subscriberCount integers, which drifted when tabs
 * crashed or navigated away before an async subscribe message arrived.
 */
var portNeeds = new Map();   // Map<MessagePort, Set<string>>

var syncIntervals   = { downloads: null, torrents: null, workers: null };
var lastSyncedAt    = { downloads: 0, torrents: 0, workers: 0 };
var cursors         = { downloads: null, torrents: null, workers: null };
var syncing         = { downloads: false, torrents: false, workers: false };
var debounceTimers  = {};

/** Counts syncs per entity — reconciliation runs every RECONCILE_EVERY syncs */
var syncCount       = { downloads: 0, torrents: 0, workers: 0 };
var RECONCILE_EVERY = 5;

/** In-worker cache of IDB-known IDs (sent by tabs on first data ack) */
var broadcastIds    = { downloads: null, torrents: null, workers: null };

/**
 * Buffered IDB IDs from tabs, accumulated during the 500 ms boot-debounce
 * window. Multiple tabs reloading at the same time each send their IDB ID
 * sets; we union them before the first reconcile so no orphan is missed.
 * Keyed by entity. Each value is a Set<string> or null (not yet seeded).
 */
var pendingIdbIds   = { downloads: null, torrents: null, workers: null };

/** Boot-debounce timers — one per entity, 500 ms */
var bootDebounce    = { downloads: null, torrents: null, workers: null };
var BOOT_DEBOUNCE_MS = 500;

var origin   = "";
var isOnline = true;

var trackingDownloadId = null;
var trackingWorkerId   = null;
var trackingType       = null;
var sseSource          = null;
var progressTimer      = null;

// Browser-to-device transfers are currently written by the initiating tab
// (the save picker needs a user gesture). The SharedWorker owns their state so
// every open tab sees the same progress.
var workerFileTransfers = new Map();

// ─── Connection ───────────────────────────────────────────────────────────────

self.onconnect = function(event) {
  var port = event.ports[0];
  ports.add(port);
  portNeeds.set(port, new Set());

  port.onmessage = function(e) { handleMessage(port, e.data); };
  port.onmessageerror = function() { removePort(port); };

  // Detect tab close / navigation. MessagePort doesn't fire a "close" event,
  // but postMessage throws when the port is dead — we catch that in broadcast/sendTo
  // and call removePort. For explicit cleanup we also handle the beforeunload
  // message that some implementations send, but mainly rely on postMessage failures.
  port.start();
};

/** Called whenever a port goes dead (crash, close, navigation). */
function removePort(port) {
  ports.delete(port);
  portNeeds.delete(port);
  recomputeIntervals();
}

// ─── Broadcast ────────────────────────────────────────────────────────────────

function broadcast(message) {
  var dead = [];
  ports.forEach(function(port) {
    try { port.postMessage(message); }
    catch(e) { dead.push(port); }
  });
  dead.forEach(function(p) { removePort(p); });
}

function sendTo(port, message) {
  try { port.postMessage(message); }
  catch(e) { removePort(port); }
}

// ─── Message handler ──────────────────────────────────────────────────────────

function handleMessage(port, msg) {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case "init":
      if (!origin && msg.origin) origin = msg.origin;
      sendTo(port, { type: "ready" });
      sendTo(port, { type: "networkStatus", status: isOnline ? "online" : "offline" });
      sendTo(port, { type: "workerFileTransfers", transfers: Array.from(workerFileTransfers.values()) });
      break;
    case "declare":
      handleDeclare(port, msg.needs || [], msg.cursors || {}, msg.idbIds || {});
      break;
    case "syncNow":
      scheduleSync(msg.entity);
      break;
    case "resetCursor":
      // Wipe the in-memory cursor so the next sync is a full fetch.
      // Also clear the syncing flag in case a previous sync is stuck,
      // and run immediately (no debounce) since this is an urgent reset.
      cursors[msg.entity] = null;
      syncing[msg.entity] = false;
      runSync(msg.entity);
      break;
    case "trackDownload":
      startTracking(msg.downloadId, msg.workerId, msg.downloadType);
      break;
    case "stopTracking":
      stopTracking();
      break;
    case "watchWorker":
      handleWatchWorker(msg.workerId);
      break;
    case "unwatchWorker":
      handleUnwatchWorker(msg.workerId);
      break;
    case "workerFileTransfer":
      if (msg.transfer && msg.transfer.id) {
        workerFileTransfers.set(msg.transfer.id, msg.transfer);
        broadcast({ type: "workerFileTransfer", transfer: msg.transfer });
      }
      break;
    case "removeWorkerFileTransfer":
      if (msg.id) {
        workerFileTransfers.delete(msg.id);
        broadcast({ type: "removeWorkerFileTransfer", id: msg.id });
      }
      break;
  }
}

// ─── Declare / recompute ──────────────────────────────────────────────────────

/**
 * A tab declares its full current set of needed entities.
 * We replace that tab's slot and recompute which intervals should run.
 *
 * cursors: per-entity IDB cursors from the tab (used to resume syncing from
 *          the right point if the worker doesn't have a cursor yet).
 * idbIds:  per-entity IDB ID arrays from the tab — merged into pendingIdbIds
 *          so the first reconcile can detect orphans even on a fresh worker.
 */
function handleDeclare(port, needs, cursors_from_tab, idbIds_from_tab) {
  // Update this port's needs (full replace, not increment/decrement)
  var prev = portNeeds.get(port) || new Set();
  var next = new Set(needs);
  portNeeds.set(port, next);

  // Absorb any cursors the tab sent for newly-needed entities.
  // Always accept an epoch reset (new Date(0)) — it means the tab detected
  // stale state and explicitly wants a full re-fetch regardless of what
  // cursor the worker currently holds.
  needs.forEach(function(entity) {
    var tabCursor = cursors_from_tab[entity];
    if (!tabCursor) return;
    var isEpochReset = tabCursor === "1970-01-01T00:00:00.000Z";
    if (isEpochReset || (!prev.has(entity) && !cursors[entity])) {
      cursors[entity] = isEpochReset ? null : tabCursor;
    }
  });

  // Merge incoming IDB IDs into pendingIdbIds (union across tabs)
  if (idbIds_from_tab) {
    needs.forEach(function(entity) {
      var ids = idbIds_from_tab[entity];
      if (!ids || !ids.length) return;
      if (!pendingIdbIds[entity]) {
        pendingIdbIds[entity] = new Set(ids);
      } else {
        ids.forEach(function(id) { pendingIdbIds[entity].add(id); });
      }
    });
  }

  recomputeIntervals();
}

/**
 * Compute the union of all ports' needs and start/stop intervals to match.
 * This is the heart of the new model — O(ports × entities), both tiny.
 */
function recomputeIntervals() {
  var union = new Set();
  portNeeds.forEach(function(needs) {
    needs.forEach(function(entity) { union.add(entity); });
  });

  ["downloads", "torrents", "workers"].forEach(function(entity) {
    var needed = union.has(entity);
    var running = syncIntervals[entity] !== null;

    if (needed && !running) {
      // Newly needed — debounce the boot sync to coalesce multi-tab reloads,
      // then schedule the regular interval.
      scheduleBootSync(entity);
      syncIntervals[entity] = setInterval(function() { runSync(entity); }, INTERVALS[entity]);
    } else if (!needed && running) {
      // No longer needed by any tab — stop the interval and cancel any
      // pending boot debounce for this entity.
      clearInterval(syncIntervals[entity]);
      syncIntervals[entity] = null;
      if (bootDebounce[entity]) {
        clearTimeout(bootDebounce[entity]);
        bootDebounce[entity] = null;
      }
    }
    // needed && running → nothing to do (already polling)
    // !needed && !running → nothing to do
  });
}

// ─── Boot sync ────────────────────────────────────────────────────────────────

/**
 * Debounced boot sync — waits BOOT_DEBOUNCE_MS before firing so that all
 * tabs reloading simultaneously can contribute their IDB IDs first.
 * After the window closes, ONE sync runs using the merged pendingIdbIds.
 */
function scheduleBootSync(entity) {
  if (bootDebounce[entity]) clearTimeout(bootDebounce[entity]);
  bootDebounce[entity] = setTimeout(function() {
    bootDebounce[entity] = null;
    bootSyncIfStale(entity);
  }, BOOT_DEBOUNCE_MS);
}

function bootSyncIfStale(entity) {
  var age = Date.now() - lastSyncedAt[entity];
  if (lastSyncedAt[entity] === 0 || age >= INTERVALS[entity]) {
    runSync(entity);
  }
}

// ─── Debounced syncNow ────────────────────────────────────────────────────────

function scheduleSync(entity) {
  if (debounceTimers[entity]) clearTimeout(debounceTimers[entity]);
  debounceTimers[entity] = setTimeout(function() { runSync(entity); }, 50);
}

// ─── Core sync ────────────────────────────────────────────────────────────────

function runSync(entity) {
  if (syncing[entity] || !isOnline) return;
  syncing[entity] = true;
  fetchAndBroadcast(entity).then(function() {
    syncing[entity] = false;
    // Run dispatcher only after download/torrent syncs — halves dispatch frequency.
    // Workers sync (every 15s) does NOT trigger dispatch.
    if (entity === "downloads" || entity === "torrents") {
      runDispatcher();
    }
  }).catch(function(err) {
    console.warn("[SyncWorker] sync failed for " + entity, err);
    syncing[entity] = false;
  });
}

function fetchAndBroadcast(entity) {
  syncCount[entity]++;
  var shouldReconcile = (syncCount[entity] === 1) || (syncCount[entity] % RECONCILE_EVERY === 0);

  if (entity === "downloads") {
    var url = "/api/sync/downloads" + (cursors.downloads ? "?since=" + encodeURIComponent(cursors.downloads) : "");
    return safeFetch(url).then(function(res) {
      if (!res) return;
      cursors.downloads = res.syncedAt;
      lastSyncedAt.downloads = Date.now();

      if (!shouldReconcile) {
        // Update our known ID set with any new rows
        if (broadcastIds.downloads && res.data) {
          res.data.forEach(function(r) { broadcastIds.downloads.add(r.id); });
        } else if (res.data) {
          broadcastIds.downloads = new Set(res.data.map(function(r) { return r.id; }));
        }
        broadcast({ type: "data", entity: "downloads", rows: res.data || [] });
        broadcast({ type: "saveCursor", entity: "downloads", cursor: res.syncedAt });
        return;
      }

      // Reconciliation cycle — fetch all current IDs from server
      return safeFetch("/api/sync/downloads?ids_only=true").then(function(idsRes) {
        var serverIds = (idsRes && idsRes.ids) ? idsRes.ids : null;
        var orphanIds = [];
        if (serverIds) {
          var serverIdSet = new Set(serverIds);
          // Seed broadcastIds from tabs' IDB IDs if this is the first sync
          if (!broadcastIds.downloads && pendingIdbIds.downloads) {
            broadcastIds.downloads = new Set(pendingIdbIds.downloads);
          }
          pendingIdbIds.downloads = null; // consumed
          if (broadcastIds.downloads) {
            broadcastIds.downloads.forEach(function(id) {
              if (!serverIdSet.has(id)) orphanIds.push(id);
            });
          }
          broadcastIds.downloads = serverIdSet;
          // Add any new rows from this sync
          if (res.data) res.data.forEach(function(r) { broadcastIds.downloads.add(r.id); });
        }
        broadcast({ type: "data", entity: "downloads", rows: res.data || [], orphanIds: orphanIds });
        broadcast({ type: "saveCursor", entity: "downloads", cursor: res.syncedAt });
      });
    });

  } else if (entity === "torrents") {
    var url = "/api/sync/torrents" + (cursors.torrents ? "?since=" + encodeURIComponent(cursors.torrents) : "");
    return safeFetch(url).then(function(res) {
      if (!res) return;
      cursors.torrents = res.syncedAt;
      lastSyncedAt.torrents = Date.now();

      if (!shouldReconcile) {
        if (broadcastIds.torrents && res.data) {
          res.data.forEach(function(r) { broadcastIds.torrents.add(r.id); });
        } else if (res.data) {
          broadcastIds.torrents = new Set(res.data.map(function(r) { return r.id; }));
        }
        broadcast({ type: "data", entity: "torrents", rows: res.data || [] });
        broadcast({ type: "saveCursor", entity: "torrents", cursor: res.syncedAt });
        return;
      }

      return safeFetch("/api/sync/torrents?ids_only=true").then(function(idsRes) {
        var serverIds = (idsRes && idsRes.ids) ? idsRes.ids : null;
        var orphanIds = [];
        if (serverIds) {
          var serverIdSet = new Set(serverIds);
          // Seed broadcastIds from tabs' IDB IDs if this is the first sync
          if (!broadcastIds.torrents && pendingIdbIds.torrents) {
            broadcastIds.torrents = new Set(pendingIdbIds.torrents);
          }
          pendingIdbIds.torrents = null; // consumed
          if (broadcastIds.torrents) {
            broadcastIds.torrents.forEach(function(id) {
              if (!serverIdSet.has(id)) orphanIds.push(id);
            });
          }
          broadcastIds.torrents = serverIdSet;
          if (res.data) res.data.forEach(function(r) { broadcastIds.torrents.add(r.id); });
        }
        broadcast({ type: "data", entity: "torrents", rows: res.data || [], orphanIds: orphanIds });
        broadcast({ type: "saveCursor", entity: "torrents", cursor: res.syncedAt });
      });
    });

  } else if (entity === "workers") {
    var url = "/api/worker/list" + (cursors.workers ? "?since=" + encodeURIComponent(cursors.workers) : "");
    return safeFetch(url).then(function(res) {
      if (!res) return;
      cursors.workers = res.syncedAt;
      lastSyncedAt.workers = Date.now();

      if (!shouldReconcile) {
        if (broadcastIds.workers && res.data) {
          res.data.forEach(function(r) { broadcastIds.workers.add(r.id); });
        } else if (res.data) {
          broadcastIds.workers = new Set(res.data.map(function(r) { return r.id; }));
        }
        broadcast({ type: "data", entity: "workers", rows: res.data || [], runtimeStatus: res.runtimeStatus || {} });
        broadcast({ type: "saveCursor", entity: "workers", cursor: res.syncedAt });
        return;
      }

      return safeFetch("/api/worker/list?ids_only=true").then(function(idsRes) {
        var serverIds = (idsRes && idsRes.ids) ? idsRes.ids : null;
        var orphanIds = [];
        if (serverIds) {
          var serverIdSet = new Set(serverIds);
          // Seed broadcastIds from tabs' IDB IDs if this is the first sync
          if (!broadcastIds.workers && pendingIdbIds.workers) {
            broadcastIds.workers = new Set(pendingIdbIds.workers);
          }
          pendingIdbIds.workers = null; // consumed
          if (broadcastIds.workers) {
            broadcastIds.workers.forEach(function(id) {
              if (!serverIdSet.has(id)) orphanIds.push(id);
            });
          }
          broadcastIds.workers = serverIdSet;
          if (res.data) res.data.forEach(function(r) { broadcastIds.workers.add(r.id); });
        }
        broadcast({ type: "data", entity: "workers", rows: res.data || [], runtimeStatus: res.runtimeStatus || {}, orphanIds: orphanIds });
        broadcast({ type: "saveCursor", entity: "workers", cursor: res.syncedAt });
      });
    });
  }

  return Promise.resolve();
}

// ─── Fetch helper (absolute URL) ──────────────────────────────────────────────

function safeFetch(path, method, body) {
  var url = origin ? (origin + path) : path;
  var opts = { credentials: "include" };
  if (method === "POST") {
    opts.method = "POST";
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body || {});
  }
  return fetch(url, opts)
    .then(function(res) {
      if (!res.ok) return null;
      return res.json();
    })
    .catch(function() { return null; });
}

// ─── Progress tracking ────────────────────────────────────────────────────────

function startTracking(downloadId, workerId, downloadType) {
  stopTracking();
  trackingDownloadId = downloadId;
  trackingWorkerId   = workerId;
  trackingType       = downloadType;

  if (downloadType === "express") {
    openSSE(downloadId);
  } else if (downloadType === "worker") {
    startWorkerPoll(workerId, downloadId);
  }
}

function stopTracking() {
  if (sseSource)      { sseSource.close(); sseSource = null; }
  if (progressTimer)  { clearInterval(progressTimer); progressTimer = null; }
  trackingDownloadId = null;
  trackingWorkerId   = null;
  trackingType       = null;
}

// ─── Express SSE ──────────────────────────────────────────────────────────────

function openSSE(downloadId) {
  var sseUrl = (origin || "") + "/api/progress/" + downloadId + "/stream";
  sseSource = new EventSource(sseUrl, { withCredentials: true });

  sseSource.onmessage = function(event) {
    try {
      var data = JSON.parse(event.data);
      var payload = {
        downloadedBytes: data.downloadedBytes || 0,
        totalBytes:      data.totalBytes  || null,
        percent:         data.percent     || null,
        percentFixed2:   data.percentFixed2 || null,
        done:            !!data.done,
        error:           data.error || null,
      };
      broadcast({ type: "progress", payload: payload });

      if (data.done || data.error) {
        stopTracking();
        scheduleSync("downloads");
      }
    } catch(e) {}
  };

  sseSource.onerror = function() {
    if (sseSource) { sseSource.close(); sseSource = null; }
    // Check the progress endpoint before deciding what to do
    safeFetch("/api/progress/" + downloadId).then(function(res) {
      if (!res) {
        // 404 — progressMap entry is gone. The download may have completed
        // normally (progressMap cleans up 60s after done) or the server may
        // have restarted. Trigger a DB sync so the tab can read the real
        // status from the database instead of assuming failure.
        scheduleSync("downloads");
        // Signal done without an error — the tab's error handler only acts
        // on the specific "Download not found" string, so using a different
        // sentinel here prevents it from incorrectly marking a completed
        // download as failed.
        broadcast({
          type: "progress",
          payload: {
            downloadedBytes: 0, totalBytes: null,
            percent: null, percentFixed2: null,
            done: true, error: null
          }
        });
        stopTracking();
      } else if (res.done) {
        broadcast({ type: "progress", payload: {
          downloadedBytes: res.downloadedBytes || 0,
          totalBytes: res.totalBytes || null,
          percent: res.percent || null,
          percentFixed2: res.percentFixed2 || null,
          done: true, error: res.error || null
        }});
        stopTracking();
        scheduleSync("downloads");
      } else {
        startExpressPolling(downloadId);
      }
    });
  };
}

function startExpressPolling(downloadId) {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = setInterval(function() {
    safeFetch("/api/progress/" + downloadId).then(function(res) {
      if (!res) {
        // 404 — progressMap gone (download finished or server restarted).
        // Sync the DB to get the real terminal status instead of assuming failure.
        scheduleSync("downloads");
        broadcast({
          type: "progress",
          payload: {
            downloadedBytes: 0, totalBytes: null,
            percent: null, percentFixed2: null,
            done: true, error: null
          }
        });
        stopTracking();
        return;
      }
      var payload = {
        downloadedBytes: res.downloadedBytes || 0,
        totalBytes:      res.totalBytes  || null,
        percent:         res.percent     || null,
        percentFixed2:   res.percentFixed2 || null,
        done:            !!res.done,
        error:           res.error || null,
      };
      broadcast({ type: "progress", payload: payload });
      if (res.done || res.error) {
        stopTracking();
        scheduleSync("downloads");
      }
    });
  }, EXPRESS_POLL_INTERVAL);
}

// ─── Worker download polling ──────────────────────────────────────────────────

function startWorkerPoll(workerId, downloadId) {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = setInterval(function() {
    safeFetch("/api/worker/" + workerId + "/status").then(function(res) {
      if (!res) return;
      var task = res.currentTask;
      if (task && task.downloadId === downloadId) {
        var pct = task.progress || 0;
        var payload = {
          downloadedBytes: 0,
          totalBytes:      null,
          percent:         pct,
          percentFixed2:   pct.toFixed(2),
          done:            task.status === "completed",
          error:           task.status === "failed" ? "Download failed" : null,
        };
        broadcast({ type: "progress", payload: payload });
        if (task.status === "completed" || task.status === "failed") {
          stopTracking();
          scheduleSync("downloads");
        }
      } else if (res.online === false) {
        broadcast({
          type: "progress",
          payload: {
            downloadedBytes: 0, totalBytes: null,
            percent: null, percentFixed2: null,
            done: true, error: "Worker went offline"
          }
        });
        stopTracking();
      }
    });
  }, WORKER_POLL_INTERVAL);
}

// ─── Worker status watching ───────────────────────────────────────────────────
//
// One SSE stream (or poll fallback) covers ALL watched workers.
// SSE: /api/worker/status/stream  — server pushes { workerId, status } every 2s
// Poll fallback: /api/worker/status/batch — returns all worker statuses
//
// Strategy:
//   1. First watchWorker → open SSE
//   2. SSE fails → immediate poll → poll every 10s → retry SSE every 30s
//   3. SSE reconnects → stop poll
//   4. Last unwatchWorker → close everything

var watchedWorkerIds   = new Set();   // workerIds currently watched by any tab
var workerStatusSSE    = null;        // active EventSource
var workerStatusTimer  = null;        // poll interval handle
var sseRetryTimer      = null;        // SSE reconnect attempt timer
var sseActive          = false;       // true while SSE is open and healthy

var WORKER_STATUS_POLL_MS   = 10000;  // poll every 10s (matches heartbeat cadence)
var WORKER_STATUS_SSE_RETRY = 30000;  // retry SSE every 30s while in poll mode

function handleWatchWorker(workerId) {
  var isFirst = watchedWorkerIds.size === 0;
  watchedWorkerIds.add(workerId);
  if (isFirst) {
    openWorkerStatusSSE();
  }
}

function handleUnwatchWorker(workerId) {
  watchedWorkerIds.delete(workerId);
  if (watchedWorkerIds.size === 0) {
    closeWorkerStatusAll();
  }
}

function closeWorkerStatusAll() {
  sseActive = false;
  if (workerStatusSSE)  { workerStatusSSE.close(); workerStatusSSE = null; }
  if (workerStatusTimer){ clearInterval(workerStatusTimer); workerStatusTimer = null; }
  if (sseRetryTimer)    { clearTimeout(sseRetryTimer); sseRetryTimer = null; }
}

// ── SSE ───────────────────────────────────────────────────────────────────────

function openWorkerStatusSSE() {
  if (workerStatusSSE) { workerStatusSSE.close(); workerStatusSSE = null; }
  if (sseRetryTimer)   { clearTimeout(sseRetryTimer); sseRetryTimer = null; }

  var sseUrl = (origin || "") + "/api/worker/status/stream";
  workerStatusSSE = new EventSource(sseUrl, { withCredentials: true });
  sseActive = true;

  workerStatusSSE.onmessage = function(event) {
    try {
      var data = JSON.parse(event.data);
      // data = { workerId, status }
      if (data.workerId && watchedWorkerIds.has(data.workerId)) {
        broadcast({ type: "workerStatus", workerId: data.workerId, status: data.status });
      }
    } catch(e) {}
  };

  workerStatusSSE.onerror = function() {
    sseActive = false;
    if (workerStatusSSE) { workerStatusSSE.close(); workerStatusSSE = null; }

    // Still have watched workers — fall back to polling
    if (watchedWorkerIds.size > 0) {
      // Immediate poll so UI doesn't go stale
      pollWorkerStatusBatch();
      startWorkerStatusPoll();
      // Schedule SSE reconnect attempt
      scheduleSseRetry();
    }
  };
}

// ── Poll fallback ─────────────────────────────────────────────────────────────

function startWorkerStatusPoll() {
  if (workerStatusTimer) return; // already polling
  workerStatusTimer = setInterval(function() {
    if (watchedWorkerIds.size === 0) {
      clearInterval(workerStatusTimer);
      workerStatusTimer = null;
      return;
    }
    pollWorkerStatusBatch();
  }, WORKER_STATUS_POLL_MS);
}

function stopWorkerStatusPoll() {
  if (workerStatusTimer) { clearInterval(workerStatusTimer); workerStatusTimer = null; }
}

function pollWorkerStatusBatch() {
  safeFetch("/api/worker/status/batch").then(function(res) {
    if (!res || !res.workers) return;
    watchedWorkerIds.forEach(function(workerId) {
      var status = res.workers[workerId];
      if (status) {
        broadcast({ type: "workerStatus", workerId: workerId, status: status });
      }
    });
  });
}

// ── SSE retry ─────────────────────────────────────────────────────────────────

function scheduleSseRetry() {
  if (sseRetryTimer) return;
  sseRetryTimer = setTimeout(function() {
    sseRetryTimer = null;
    if (watchedWorkerIds.size === 0) return;
    if (sseActive) return; // SSE already recovered somehow
    // Stop poll and try SSE again
    stopWorkerStatusPoll();
    openWorkerStatusSSE();
  }, WORKER_STATUS_SSE_RETRY);
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────
//
// Runs after every sync cycle. Calls /api/worker/dispatch which returns the
// next pending download that should start (if any). The worker then calls
// the appropriate endpoint to trigger the download.
//
// This runs in the SharedWorker — single instance across all tabs, so there's
// no risk of two tabs double-triggering the same download.

var dispatchInProgress = false;

function runDispatcher() {
  if (dispatchInProgress || !isOnline) return;
  dispatchInProgress = true;

  safeFetch("/api/worker/dispatch", "POST", {})
    .then(function(res) {
      dispatchInProgress = false;
      if (!res || res.action !== "trigger") return;

      var download = res.download;
      if (!download) return;

      if (res.destination === "worker" && res.pinggyUrl && res.sessionToken) {
        // Trigger worker download directly
        var workerUrl = res.pinggyUrl + "/download";
        var indices = null;
        try {
          if (download.selectedFileIndices) {
            indices = JSON.parse(download.selectedFileIndices);
          }
        } catch(e) {}

        fetch(workerUrl, {
          method: "POST",
          headers: {
            "Content-Type":    "application/json",
            "X-Session-Token": res.sessionToken,
            // Pinggy free tunnels show a browser screening page unless this
            // header is present. It also keeps this direct request API-only.
            "X-Pinggy-No-Screen": "1",
          },
          body: JSON.stringify({
            downloadId:   download.id,
            sourceUrl:    download.sourceUrl,
            fileName:     download.fileName || "download",
            downloadType: download.downloadType || "http",
            fileIndices:  indices,
          }),
        }).then(function(r) {
          if (r.ok) {
            // Force immediate syncs after trigger so the "downloading" status
            // is picked up right away rather than waiting for the 30s cycle.
            // Poll at 1s, 5s, 15s to catch fast and slow downloads.
            setTimeout(function() { scheduleSync("downloads"); scheduleSync("torrents"); }, 1000);
            setTimeout(function() { scheduleSync("downloads"); scheduleSync("torrents"); }, 5000);
            setTimeout(function() { scheduleSync("downloads"); scheduleSync("torrents"); }, 15000);
          } else if (r.status === 409) {
            // Worker is busy — will retry on next sync cycle
          }
        }).catch(function() {
          // Network error — will retry on next sync cycle
        });

      } else if (res.destination === "server") {
        // For server/cloud downloads, broadcast to tabs — they handle it
        // (tabs already have the claimDownload + startDownload logic)
        broadcast({ type: "dispatchServer", download: download });
      }
    })
    .catch(function() {
      dispatchInProgress = false;
    });
}



self.addEventListener("online", function() {
  isOnline = true;
  broadcast({ type: "networkStatus", status: "online" });
  // Resume syncing for any entity that has active subscribers
  ["downloads", "torrents", "workers"].forEach(function(entity) {
    if (syncIntervals[entity] !== null) runSync(entity);
  });
});

self.addEventListener("offline", function() {
  isOnline = false;
  broadcast({ type: "networkStatus", status: "offline" });
});
