#!/usr/bin/env node
import { captureLogger } from "./registration";
import { readCaptureEnvironment } from "./env";
import { startCaptureService } from "./service";
startCaptureService(readCaptureEnvironment()).catch(() => {
  captureLogger.error(
    "preview-capture refused startup: check its isolated environment and renderer sandbox"
  );
  process.exitCode = 1;
});
