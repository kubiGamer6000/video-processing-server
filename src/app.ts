import express from "express";
import healthRouter from "./routes/health.js";
import deployRouter from "./routes/deploy.js";
import transcribeRouter from "./routes/transcribe.js";
import { errorHandler } from "./middlewares/error-handler.js";

const app = express();

app.use(express.json());
app.use(healthRouter);
app.use(deployRouter);
app.use(transcribeRouter);
app.use(errorHandler);

export default app;
