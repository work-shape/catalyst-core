import pino from "pino";
import type { Logger } from "@work-shape/catalyst-core";
export const captureLogger: Logger = pino({ level: "info" });
