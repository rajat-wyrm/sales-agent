import '@testing-library/jest-dom';
import { TextEncoder, TextDecoder } from 'util';

// jsdom has no Vite define step, so src/lib/env.ts (the only module reading
// import.meta) is mocked per-suite rather than globally.

// react-router 7 expects the encoding globals at module-load time; jsdom's
// jest environment does not provide them.
(globalThis as any).TextEncoder ??= TextEncoder;
(globalThis as any).TextDecoder ??= TextDecoder;
