import express from "express";
import healthRouter from "./routes/health.js";
import { errorHandler } from "./middlewares/error-handler.js";

const app = express();

app.use(express.json());
app.use(healthRouter);
app.use(errorHandler);

export default app;
