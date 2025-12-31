import express from "express";
import cors from "cors";
import 'dotenv/config'
import routes from "./routes/index.r.js";
import { initMega } from "./utils/megaStorage.js";

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

// Wait for MEGA to be ready before marking server as ready
async function startServer() {
  try {
    await initMega();
    console.log("Connected to MEGA ✅");
    isReady = true;
  } catch (err) {
    console.error("MEGA connection failed:", err.message);
    // Still mark as ready to allow non-MEGA routes to work
    isReady = true;
  }
}

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
  startServer();
});
