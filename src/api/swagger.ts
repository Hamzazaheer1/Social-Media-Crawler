import path from "path";
import fs from "fs";
import YAML from "yaml";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function loadOpenApiSpec() {
  const filePath = path.join(process.cwd(), "openapi.yaml");
  const raw = fs.readFileSync(filePath, "utf8");
  return YAML.parse(raw);
}
