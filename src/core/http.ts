import axios, { type AxiosInstance, type AxiosError } from "axios";
import { logger } from "./logger.js";

export function createHttpClient(baseURL?: string, headers?: Record<string, string>): AxiosInstance {
  const client = axios.create({
    ...(baseURL ? { baseURL } : {}),
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      ...headers,
    },
    timeout: 30000,
  });

  client.interceptors.response.use(
    (response) => response,
    (error: AxiosError) => {
      if (error.response) {
        logger.warn({ status: error.response.status, url: error.config?.url }, "HTTP error");
      } else if (error.request) {
        logger.warn({ url: error.config?.url }, "Network error");
      }
      throw error;
    }
  );

  return client;
}
