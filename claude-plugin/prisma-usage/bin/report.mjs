#!/usr/bin/env node
import { report } from "../lib/report.mjs";

console.log(report(process.argv.slice(2)).join("\n"));
