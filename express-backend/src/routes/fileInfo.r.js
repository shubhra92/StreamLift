import express from "express";
import { getFileInfo } from "../controllers/fileInfo.js";

const router = express.Router();

router.get("/", getFileInfo);

export default router;
