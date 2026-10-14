import {assertLocalRuntime} from '../src/deployment.js';

// Vercel recognizes the vercel-build package script. Fail before publishing an
// apparently successful static shell whose local API cannot function securely.
try {
  assertLocalRuntime({VERCEL: '1'});
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
