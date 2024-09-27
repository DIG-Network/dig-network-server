import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { appRoutes } from "./routes/appRoutes";
import { parseUdi, networkRouter } from "./middleware";

const app = express();
const PORT = Number(process.env.PORT) || 4162;

// Apply store routes
app.use(cookieParser());
app.use(cors());
app.use("/", appRoutes);
app.use(parseUdi);
app.use(networkRouter);

// Export both the app and the server
export { app, PORT };
