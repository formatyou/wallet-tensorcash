import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/unit/**/*.test.ts', 'server/**/*.test.ts', 'src/**/*.test.ts'], environment: 'node', testTimeout: 30000 } });
