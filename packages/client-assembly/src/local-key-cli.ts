#!/usr/bin/env node
import { runLocalKeyCli } from "./local-key";

process.exitCode = await runLocalKeyCli(process.argv.slice(2));
