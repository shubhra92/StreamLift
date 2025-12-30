import express from "express";
import { streamServerDownload, streamMegaUpload } from "../controllers/streamDownload.js";

const router = express.Router();

router.post("/server", streamServerDownload);
router.post("/mega", streamMegaUpload);


export default router;
