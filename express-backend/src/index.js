import express from "express";
import cors from "cors";
import 'dotenv/config'
import routes from "./routes/index.r.js";
import { mega } from "./utils/megaStorage.js";

const app = express();

app.use(cors());
app.use(express.json()); // for JSON bodies
mega.ready.then((a)=>console.log("Connected to MEGA ✅")).catch((err)=>console.log(err.message))

app.get("/",(req, res)=>{
    res.status(200).send("Server is running!....")
})

app.use("/api", routes);


const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
