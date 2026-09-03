import express from "express";
import { createShareLink } from "../controllers/cloudShare.js";

const router = express.Router();

router.post("/share/:id", createShareLink);

export default router;
