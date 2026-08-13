import express from "express";
import cors from "cors";
import 'dotenv/config'
import routes from "./routes/index.r.js";
import { getCloudProvider } from "./utils/cloudProvider.js";
import { db, fileDownloads } from "./db/index.js";
import { eq } from "drizzle-orm";

const app = express();

app.use(cors());
app.use(express.json());

let isReady = false;

// Middleware to check if server is ready
app.use((req, res, next) => {
  if (!isReady && req.path !== '/health') {
    return res.status(503).json({ error: 'Server is starting up, please retry in a moment' });
  }
  next();
});

app.get("/", (req, res) => {
  res.status(200).send("Server is running!....");
});

app.get("/health", (req, res) => {
  res.status(isReady ? 200 : 503).json({ ready: isReady });
});

app.use("/api", routes);

const PORT = process.env.PORT || 4000;

/**
 * On startup, any rows still marked 'downloading' are stale — they were
 * in-flight when Express last stopped and their progressMap entry is gone.
 * Mark them 'failed' so the frontend stops waiting and can show the error.
 */
async function recoverStaleDownloads() {
  try {
    const stale = await db
      .update(fileDownloads)
      .set({
        status: "failed",
        errorMessage: "Server restarted while download was in progress",
        updatedAt: new Date(),
      })
      .where(eq(fileDownloads.status, "downloading"))
      .returning({ id: fileDownloads.id });

    if (stale.length > 0) {
      console.log(`[startup] Marked ${stale.length} stale download(s) as failed:`, stale.map(r => r.id));
    }
  } catch (err) {
    console.error("[startup] Failed to recover stale downloads:", err.message);
  }
}

/**
 * Pre-warm the configured cloud provider connection at startup.
 * Adding a new provider: add an `if` branch here to validate credentials
 * or establish a connection before the server starts accepting requests.
 */
async function initCloudProvider() {
  const provider = getCloudProvider();
  console.log(`Cloud provider: ${provider}`);

  if (provider === "mega") {
    const { initMega } = await import("./utils/providers/mega/megaStorage.js");
    try {
      await initMega();
      console.log("Connected to MEGA ✅");
    } catch (err) {
      console.error("MEGA connection failed:", err.message);
      // Still continue — non-cloud routes (server downloads, health, etc.) work fine
    }
  }
  // Future: add "s3", "gdrive", etc. branches here
}

// Wait for the cloud provider to be ready before accepting requests
async function startServer() {
  await initCloudProvider();

  // Clean up any downloads that were mid-flight when Express last stopped
  await recoverStaleDownloads();

  isReady = true;
}

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
  startServer();
});
