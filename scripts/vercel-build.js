import {verifyHostedBuild} from '../src/hosted/readiness.js';

// Vercel recognizes this script. Never publish a static shell with unconfigured
// Auth/data services. The local JSON entry point remains independently blocked.
try {
  await verifyHostedBuild();
  console.log('PASS: hosted configuration, Supabase Auth/schema/private evidence storage and OpenAI model access. No paid search was run.');
} catch (error) {
  console.error('ATLAS deployment blocked: ' + error.message);
  process.exitCode = 1;
}
