// Dev helper: generate the demo book into books/ (server does this itself on
// startup when the library is empty — this just forces it for local dev).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncSampleBook } from '../lib/sample.js';

syncSampleBook(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'books'));
console.log('done');
