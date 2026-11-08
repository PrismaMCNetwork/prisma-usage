#!/usr/bin/env node
import { logError } from "../lib/log.mjs";
import { flush } from "../lib/sender.mjs";

flush()
  .catch((err) => logError("flush main", err))
  .finally(() => process.exit(0));
