import express from "express";
import cors from "cors";
import multer from "multer";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import pino from "pino";
import ffmpeg from "fluent-ffmpeg";
import { promises as fs, existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";


dotenv.config();

// ==========================================
// CONFIGURATION & LOGGING
// ==========================================
const logger = pino({
  transport: {
    target: "pino-pretty",
    options: { colorize: true }
  }
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for rate limiting (needed behind Docker/LB/Proxies)
app.set('trust proxy', 1);

// Security & Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "style-src": ["'self'", "'unsafe-inline'", "fonts.googleapis.com"],
      "font-src": ["'self'", "fonts.gstatic.com"],
    },
  },
}));

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));


// Rate Limiting: 15 requests per 15 mins per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { error: "Too many uploads, please try again later." }
});
app.use("/process-video", limiter);

// Directories Setup
const UPLOAD_DIR = path.resolve(__dirname, "uploads");
const OUTPUT_DIR = path.resolve(__dirname, "outputs");


[UPLOAD_DIR, OUTPUT_DIR].forEach(dir => {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
});

// ==========================================
// MULTER CONFIG
// ==========================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => {
    const safeName = `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_")}`;
    cb(null, safeName);
  },
});

const upload = multer({ 
  storage,
  limits: { fileSize: 150 * 1024 * 1024 }, // Increased limit for local processing
  fileFilter: (req, file, cb) => {
    file.mimetype.startsWith("video/") ? cb(null, true) : cb(new Error("Invalid file type"), false);
  }
});

// ==========================================
// LOCAL CORE PROCESSING (FFMPEG)
// ==========================================

/**
 * Local Watermark Removal using FFmpeg delogo filter
 * This applies the "Reverse" logic locally by interpolating the specified region.
 */
async function processVideoLocally(inputPath, outputFileName, deepClean = false) {
  const outputPath = path.resolve(OUTPUT_DIR, outputFileName);
  
  logger.info(`Processing video locally: ${path.basename(inputPath)} (Deep Clean: ${deepClean})`);

  // Get video dimensions first since delogo may not support expressions in all environments
  const probe = await new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata);
    });
  });

  const videoStream = probe.streams.find(s => s.codec_type === "video");
  const width = videoStream.width;
  const height = videoStream.height;

  // Calculate coordinates (Gemini Veo watermark is bottom-right)
  // We add a safety padding and slightly larger base dimensions to ensure drop shadows are caught.
  const padding = deepClean ? 25 : 15;
  const x = Math.max(0, width - 225 - padding);
  const y = Math.max(0, height - 105 - padding);
  const w = Math.min(205 + (padding * 2), width - x);
  const h = Math.min(95 + (padding * 2), height - y);

  const blurRadius = deepClean ? 12 : 5;

  logger.info(`Detected resolution: ${width}x${height}. Applying Enhanced Seamless Removal at [${x},${y},${w},${h}] with padding ${padding}`);

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      // Enhanced Multi-Pass Filter Chain:
      // 1. apply delogo (base interpolation)
      // 2. split the stream to create a localized blur mask
      // 3. crop, blur, and overlay the region to hide interpolation artifacts
      .complexFilter([
        `[0:v]delogo=x=${x}:y=${y}:w=${w}:h=${h}[cleaned]`,
        `[cleaned]split[a][b]`,
        `[b]crop=${w}:${h}:${x}:${y},boxblur=${blurRadius}:1[blurred]`,
        `[a][blurred]overlay=${x}:${y}:shortest=1`
      ])
      .videoCodec('libx264')
      .outputOptions("-y") // Force overwrite


      .on("start", (cmd) => logger.info(`FFmpeg command: ${cmd}`))
      .on("progress", (progress) => {
        if (progress.percent) logger.info(`Processing: ${Math.round(progress.percent)}%`);
      })
      .on("error", (err, stdout, stderr) => {
        logger.error(`FFmpeg Error: ${err.message}`);
        logger.error(`FFmpeg stderr: ${stderr}`);
        reject(err);
      })
      .on("end", () => {
        logger.info(`Video processed successfully: ${outputFileName}`);
        resolve(outputPath);
      })
      .output(outputPath)
      .run();

  });
}

app.post("/process-video", upload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No video provided" });

  const inputPath = req.file.path;
  const outputFileName = `clean-${path.basename(inputPath)}`;
  const deepClean = req.body.deepClean === "true";
  
  try {
    const outputPath = await processVideoLocally(inputPath, outputFileName, deepClean);
    
    // Serve the file to the user
    res.download(outputPath, outputFileName, async (err) => {
      if (err) {
        logger.error(`Download failed: ${err.message}`);
      }
      // Cleanup both input and output after download completion/failure
      await cleanupFile(inputPath);
      await cleanupFile(outputPath);
    });

  } catch (error) {
    logger.error({ err: error.message }, "Local processing failed");
    await cleanupFile(inputPath);
    res.status(500).json({ error: "Processing failed", details: error.message });
  }
});

// ==========================================
// UTILS & BOOT
// ==========================================
async function cleanupFile(filePath) {
  try {
    if (existsSync(filePath)) {
      await fs.unlink(filePath);
      logger.info(`Cleaned up file: ${path.basename(filePath)}`);
    }
  } catch (e) {
    logger.warn(`Cleanup failed for ${filePath}: ${e.message}`);
  }
}

app.get("/health", (req, res) => res.json({ status: "healthy", engine: "local-ffmpeg", version: "2.0.0" }));

app.listen(PORT, async () => {
  logger.info(`=========================================`);
  logger.info(`STANDALONE WATERMARK REMOVER ACTIVE`);
  logger.info(`Port: ${PORT}`);
  
  // Check engine availability
  ffmpeg.getAvailableFormats((err, formats) => {
    if (err) {
      logger.error("FFmpeg engine NOT detected in system path!");
      logger.error("Please ensure FFmpeg is installed and added to PATH.");
    } else {
      logger.info(`Engine: FFmpeg (System) - ${Object.keys(formats).length} formats supported`);
    }
  });
  
  logger.info(`=========================================`);
});


