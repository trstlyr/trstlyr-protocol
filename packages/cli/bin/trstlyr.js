#!/usr/bin/env node
import('../dist/index.js').then(m => m.main()).catch(e => { console.error(e.message); process.exit(1); });
