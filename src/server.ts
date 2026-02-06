import "dotenv/config";
import express from "express";
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import routes from "./api/routes.js";
import { loadOpenApiSpec } from "./api/swagger.js";
import { logger } from "./core/logger.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Handle invalid JSON (e.g. unescaped newlines/control chars in string values)
app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({
      error: "Invalid JSON in request body",
      detail: "String values must not contain unescaped control characters (e.g. newlines, tabs). Use \\n for newline, \\t for tab.",
    });
    return;
  }
  next(err);
});

// Swagger (single file with both social media and website endpoints)
const spec = loadOpenApiSpec();
app.use("/docs", swaggerUi.serve, swaggerUi.setup(spec, {
  customCss: ".swagger-ui .topbar { display: none }",
  customSiteTitle: "Social Media & Website Crawler API"
}));

// Routes
app.use("/", routes);

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  logger.info(`Server running on http://localhost:${port}`);
  logger.info(`Swagger Docs: http://localhost:${port}/docs`);
});
