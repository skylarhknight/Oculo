import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2022',
  },
  test: {
    // Native builds check out third-party packages (with their own tests) under ios/ and android/.
    exclude: [...configDefaults.exclude, 'ios/**', 'android/**'],
  },
});
