import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import { ingest } from "./pipeline/ingest.js";
import { answer } from "./pipeline/retrieval.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
const uploadsDir = path.join(projectRoot, "uploads");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

/** @type {Map<string, { uploadId: string, chunkCount: number }>} */
const sessions = new Map();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-]/g, "_");
    cb(null, `${Date.now()}-${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const lower = (file.originalname || "").toLowerCase();
    const okExt = lower.endsWith(".pdf") || lower.endsWith(".txt");
    const okMime =
      file.mimetype === "application/pdf" ||
      file.mimetype === "text/plain" ||
      (file.mimetype === "application/octet-stream" &&
        (lower.endsWith(".txt") || lower.endsWith(".pdf")));
    if (okMime && okExt) cb(null, true);
    else cb(new Error("Only .pdf and .txt files up to 20 MB are allowed."));
  },
});

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(projectRoot, "public")));

function deleteFileQuietly(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/upload", upload.single("document"), async (req, res, next) => {
  let tempPath = req.file?.path;

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Missing file field "document" (.pdf or .txt).' });
    }

    const uploadId = crypto.randomUUID();
    const collectionName = `doctalk-${uploadId}`;
    tempPath = req.file.path;
    let mimeType = req.file.mimetype || "application/octet-stream";
    const lowerName = (req.file.originalname || "").toLowerCase();
    if (mimeType === "application/octet-stream") {
      if (lowerName.endsWith(".pdf")) mimeType = "application/pdf";
      else if (lowerName.endsWith(".txt")) mimeType = "text/plain";
    }

    const { chunkCount } = await ingest(tempPath, mimeType, collectionName);

    sessions.set(collectionName, { uploadId, chunkCount });

    res.json({
      success: true,
      uploadId,
      collectionName,
      chunkCount,
    });
  } catch (err) {
    next(err);
  } finally {
    deleteFileQuietly(tempPath);
  }
});

app.post("/api/chat", async (req, res, next) => {
  try {
    const { collectionName, question } = req.body ?? {};

    if (!collectionName || typeof collectionName !== "string" || !collectionName.trim()) {
      return res.status(400).json({ error: "collectionName is required." });
    }
    if (!question || typeof question !== "string" || !question.trim()) {
      return res.status(400).json({ error: "question is required." });
    }

    if (!sessions.has(collectionName)) {
      return res.status(404).json({
        error:
          "Unknown or expired document session. Upload your document again from the home screen.",
      });
    }

    const result = await answer(collectionName.trim(), question.trim());
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Multer / fileFilter errors
app.use((err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "File too large (max 20 MB)." });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err && err.message && /Only \.pdf/.test(err.message)) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

app.use((err, _req, res, _next) => {
  console.error(err);
  const message = err instanceof Error ? err.message : "Internal server error";
  res.status(500).json({ error: message });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`DocTalk listening on http://localhost:${port}`);
});
