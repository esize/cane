import express from "express";
import dotenv from "dotenv";
import winston from "winston";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import router from "./routes";

dotenv.config();

const app = express();
const port = process.env.PORT || 7000;

// Logging
const logger = winston.createLogger({
  level: "info",
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
  ],
});

// Middleware
app.use(helmet());
app.use(express.json());
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
  })
);

// Routes
app.use("/api/", router);

app.listen(port, () => {
  logger.info(`Server running on port ${port}`);
});
